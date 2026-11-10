/**
 * Capture and context tests — pure functions only, no database.
 */

import { describe, expect, test } from "bun:test";
import { Message } from "@opencode/ai/effect";
import { findLastPlanMessage, messageText, type SessionMessageLike } from "../src/capture";
import {
  insertPlanExemption,
  PLAN_MODE_EXEMPTION,
  PLAN_SAVE_INSTRUCTION,
  renderBuildContext,
} from "../src/inject";
import type { Plan } from "../src/store";

const message = (input: Partial<SessionMessageLike>): SessionMessageLike => ({
  type: "assistant",
  ...input,
});

describe("capture", () => {
  test("reads text parts", () => {
    expect(
      messageText({ content: [{ type: "text", text: "hello" }, { type: "reasoning", text: "ignored" }] }),
    ).toBe("hello");
  });

  test("finds the last non-empty Plan message", () => {
    const messages = [
      message({ agent: "build", content: [{ type: "text", text: "build" }] }),
      message({ id: "m1", agent: "plan", content: [{ type: "text", text: "# Plan\n\n- [ ] A" }] }),
      message({ id: "m2", agent: "plan", content: [{ type: "text", text: "   " }] }),
    ];
    expect(findLastPlanMessage(messages)).toEqual({
      body: "# Plan\n\n- [ ] A",
      messageID: "m1",
    });
  });

  test("ignores other agents and non-assistant messages", () => {
    const messages = [
      message({ type: "user", agent: "plan", content: [{ type: "text", text: "user text" }] }),
      message({ agent: "build", content: [{ type: "text", text: "build text" }] }),
      message({ agent: "plan", content: [{ type: "text", text: "   " }] }),
    ];
    expect(findLastPlanMessage(messages)).toBeUndefined();
  });

  test("requireSteps skips a non-plan plan message and finds the previous plan", () => {
    const messages = [
      message({
        id: "m1",
        agent: "plan",
        content: [{ type: "text", text: "# Plan\n\n## Passos\n\n- [ ] A" }],
      }),
      message({
        id: "m2",
        agent: "plan",
        content: [{ type: "text", text: "Você tem razão; salvando agora." }],
      }),
    ];
    expect(findLastPlanMessage(messages)?.messageID).toBe("m2");
    expect(findLastPlanMessage(messages, { requireSteps: true })?.messageID).toBe("m1");
  });

  test("requireSteps returns undefined when no plan message has steps", () => {
    const messages = [
      message({ id: "m1", agent: "plan", content: [{ type: "text", text: "Vou pensar." }] }),
    ];
    expect(findLastPlanMessage(messages, { requireSteps: true })).toBeUndefined();
  });
});

const plan = (overrides: Partial<Plan> = {}): Plan => ({
  id: "plan-1",
  project_id: "project-1",
  project_directory: "/tmp/project-1",
  session_id: "session-1",
  message_id: "message-1",
  title: "Ship the plugin",
  body: "# Ship the plugin\n\n- [ ] Model\n- [x] Store\n- [ ] GUI",
  status: "active",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  completed_at: null,
  steps: [
    { plan_id: "plan-1", position: 0, step_id: "s1", text: "Model", status: "todo" },
    { plan_id: "plan-1", position: 1, step_id: "s2", text: "Store", status: "done" },
    { plan_id: "plan-1", position: 2, step_id: "s3", text: "GUI", status: "todo" },
  ],
  ...overrides,
});

describe("inject", () => {
  test("the plan instruction requires saving in the same turn without permission", () => {
    expect(PLAN_SAVE_INSTRUCTION).toContain("plans.save");
    expect(PLAN_SAVE_INSTRUCTION).toContain("same turn");
    expect(PLAN_SAVE_INSTRUCTION).toContain("no pending questions or choices");
    expect(PLAN_SAVE_INSTRUCTION).toContain("Do not ask for permission");
  });

  test("the plan instruction allows saving and editing in Plan mode", () => {
    expect(PLAN_SAVE_INSTRUCTION).toContain("allowed in Plan mode");
    expect(PLAN_SAVE_INSTRUCTION).toContain("plans database");
    expect(PLAN_SAVE_INSTRUCTION).toContain("Never switch to Build");
  });

  test("the plan instruction treats optional choices as non-blocking", () => {
    expect(PLAN_SAVE_INSTRUCTION).toContain("optional or recommended");
    expect(PLAN_SAVE_INSTRUCTION).toContain("(optional, recommended)");
  });

  test("the Plan-mode exemption follows the core reminder and is idempotent", () => {
    const textOf = (message: Message): string =>
      message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
    const reminder = (text: string) =>
      Message.user(`<system-reminder>\n${text}\n</system-reminder>`);
    const messages = [
      Message.user("hello"),
      reminder("You are in Plan mode. Do not create files."),
      Message.user("task"),
    ];

    expect(insertPlanExemption(messages)).toBe(true);
    expect(messages).toHaveLength(4);
    expect(textOf(messages[2]!)).toBe(PLAN_MODE_EXEMPTION);
    expect(textOf(messages[3]!)).toBe("task");
    expect(PLAN_MODE_EXEMPTION).toContain("allowed in this mode");

    expect(insertPlanExemption(messages)).toBe(false);
    expect(messages).toHaveLength(4);
  });

  test("the Plan-mode exemption is skipped when the reminder is missing", () => {
    const messages = [Message.user("hello")];
    expect(insertPlanExemption(messages)).toBe(false);
    expect(messages).toHaveLength(1);
  });

  test("build context lists active plans and pending steps with ids", () => {
    const text = renderBuildContext([plan()], plan());
    expect(text).toContain("Ship the plugin");
    expect(text).toContain("(s1) Model");
    expect(text).toContain("(s3) GUI");
    expect(text).not.toContain("(s2) Store");
    expect(text).toContain("plans.get");
    expect(text).toContain("plans.update");
    expect(text).toContain("Use plans.get só se precisar");
  });

  test("the doing step comes first and is marked as doing", () => {
    const doing = plan({
      steps: [
        { plan_id: "plan-1", position: 0, step_id: "s1", text: "Model", status: "todo" },
        { plan_id: "plan-1", position: 1, step_id: "s2", text: "Store", status: "doing" },
        { plan_id: "plan-1", position: 2, step_id: "s3", text: "GUI", status: "todo" },
      ],
    });
    const text = renderBuildContext([doing], doing);
    expect(text).toContain("- [doing] (s2) Store");
    expect(text).toContain("- [todo] (s1) Model");
    expect(text).toContain("1 doing");
    expect(text).toContain("stepStatus");
    expect(text.indexOf("- [doing] (s2) Store")).toBeLessThan(
      text.indexOf("- [todo] (s1) Model"),
    );
  });

  test("no active plans and no session plan -> empty", () => {
    expect(renderBuildContext([], undefined)).toBe("");
  });

  test("a done plan is not listed as active", () => {
    const done = plan({ status: "done" });
    expect(renderBuildContext([done], undefined)).toBe("");
  });
});
