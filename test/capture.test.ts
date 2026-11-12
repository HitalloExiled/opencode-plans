/**
 * Capture tests — pure functions only, no database.
 */

import { describe, expect, test } from "bun:test";
import { findLastPlanMessage, messageText, type SessionMessageLike } from "../src/capture";

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
