/**
 * Capture and context tests — pure functions only, no database.
 */

import { describe, expect, test } from "bun:test";
import { findLastPlanMessage, messageText, type SessionMessageLike } from "../src/capture";
import { PLAN_SAVE_INSTRUCTION, renderBuildContext } from "../src/inject";
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
  test("the plan instruction names plans.save", () => {
    expect(PLAN_SAVE_INSTRUCTION).toContain("plans.save");
  });

  test("build context lists active plans and pending steps", () => {
    const text = renderBuildContext([plan()], plan());
    expect(text).toContain("Ship the plugin");
    expect(text).toContain("Model");
    expect(text).toContain("GUI");
    expect(text).not.toContain("- Store");
    expect(text).toContain("plans.get");
    expect(text).toContain("plans.update");
  });

  test("no active plans and no session plan -> empty", () => {
    expect(renderBuildContext([], undefined)).toBe("");
  });

  test("a done plan is not listed as active", () => {
    const done = plan({ status: "done" });
    expect(renderBuildContext([done], undefined)).toBe("");
  });
});
