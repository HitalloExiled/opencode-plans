import { describe, expect, test } from "bun:test";
import {
  applyPlanReminder,
  enter,
  lastReminder,
  leave,
  PLAN_DIR,
  PLAN_REMINDER,
  planReminderPatch,
  type ReminderMessage,
} from "../src/plan-reminder";

// Verbatim copy of `packages/core/src/plugin/plan.ts`; the test fails if the
// replica drifts by a single byte.
const CORE_ENTER = (directory: string) => `<system-reminder>
You are in Plan mode. Discuss the plan with the user directly in the conversation. Do not create or update plan files unless the user explicitly asks you to; when they do, write them only in:
${directory}

Do not modify any other files or ask a subagent to do so.

You remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents.
</system-reminder>`;

const CORE_LEAVE = `<system-reminder>
You are NO LONGER in Plan mode. The previous Plan restrictions no longer apply. Any Plan mode instructions from earlier in this conversation are no longer active.
</system-reminder>`;

const user = (text: string): ReminderMessage => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): ReminderMessage => ({ role: "assistant", content: [{ type: "text", text }] });

describe("plan reminder text", () => {
  test("is byte-identical to the core plugin", () => {
    expect(enter(PLAN_DIR)).toBe(CORE_ENTER(PLAN_DIR));
    expect(leave).toBe(CORE_LEAVE);
    expect(PLAN_REMINDER).toBe(CORE_ENTER(PLAN_DIR));
  });

  test("names the Plan directory and forbids implementation", () => {
    expect(PLAN_REMINDER).toContain(PLAN_DIR);
    expect(PLAN_REMINDER).toContain("If the user asks you to implement changes, do not do so.");
    expect(PLAN_REMINDER).toContain("Tell them they need to switch agents.");
  });
});

describe("lastReminder", () => {
  test("finds the last one, ignoring unrelated text", () => {
    const messages = [user(leave), assistant("ok"), user(PLAN_REMINDER)];
    expect(lastReminder(messages)).toBe(PLAN_REMINDER);
  });

  test("reads a reminder that shares its message with a tail block", () => {
    const messages: ReminderMessage[] = [
      { role: "user", content: [{ type: "text", text: PLAN_REMINDER }, { type: "text", text: "<plans-flow/>" }] },
    ];
    expect(lastReminder(messages)).toBe(PLAN_REMINDER);
  });

  test("is undefined without a reminder", () => {
    expect(lastReminder([user("hi"), assistant("hello")])).toBeUndefined();
  });
});

describe("planReminderPatch", () => {
  test("enters before the user's prompt", () => {
    const messages = [user("plan the migration")];
    expect(planReminderPatch(messages, "planner")).toEqual({ text: PLAN_REMINDER, at: 0 });
  });

  test("lands after a previous assistant turn, before the new user message", () => {
    const messages = [user("a"), assistant("b"), user("c")];
    expect(planReminderPatch(messages, "planner")!.at).toBe(2);
  });

  test("appends at the end when the last message is not from the user", () => {
    const messages = [user("a"), assistant("b")];
    expect(planReminderPatch(messages, "planner")!.at).toBe(2);
  });

  test("does nothing when the planner already has it", () => {
    expect(planReminderPatch([user(PLAN_REMINDER), user("go")], "planner")).toBeUndefined();
  });

  test("re-injects after a compaction that dropped it", () => {
    const messages = [user("summary"), assistant("ok"), user("continue")];
    expect(planReminderPatch(messages, "planner")?.text).toBe(PLAN_REMINDER);
  });

  test("leaves when the session stops using the planner", () => {
    const messages = [user(PLAN_REMINDER), user("go")];
    expect(planReminderPatch(messages, "executor")).toEqual({ text: leave, at: 1 });
    expect(planReminderPatch(messages, "build")).toEqual({ text: leave, at: 1 });
    expect(planReminderPatch(messages, "plan")).toEqual({ text: leave, at: 1 });
  });

  test("does not repeat leave", () => {
    expect(planReminderPatch([user(leave), user("go")], "executor")).toBeUndefined();
  });

  test("other agents never get the enter reminder", () => {
    expect(planReminderPatch([user("go")], "executor")).toBeUndefined();
    expect(planReminderPatch([user("go")], "plan")).toBeUndefined();
  });
});

describe("applyPlanReminder", () => {
  test("splices the message and returns the persisted text", () => {
    const messages = [user("a"), assistant("b"), user("c")];
    expect(applyPlanReminder(messages, "planner")).toBe(PLAN_REMINDER);
    expect(messages).toHaveLength(4);
    expect(messages[2]).toEqual({ role: "user", content: [{ type: "text", text: PLAN_REMINDER }] });
    // The user's prompt stays last, untouched.
    expect(messages[3]).toEqual(user("c"));
  });

  test("is idempotent on the same request", () => {
    const messages = [user("a"), user("b")];
    expect(applyPlanReminder(messages, "planner")).toBe(PLAN_REMINDER);
    expect(applyPlanReminder(messages, "planner")).toBeUndefined();
    expect(messages.filter((message) => message.content[0]?.text === PLAN_REMINDER)).toHaveLength(1);
  });

  test("a tail block appended after it does not cause a duplicate", () => {
    const messages = [user("a")];
    expect(applyPlanReminder(messages, "planner")).toBe(PLAN_REMINDER);
    // A later layer (the plan context) shares the injected message.
    const injected = messages[0]!;
    injected.content.push({ type: "text", text: "<plans-context/>" });
    expect(applyPlanReminder(messages, "planner")).toBeUndefined();
    expect(injected.content).toHaveLength(2);
  });

  test("switching to the executor swaps it for leave", () => {
    const messages = [user(PLAN_REMINDER), user("execute")];
    expect(applyPlanReminder(messages, "executor")).toBe(leave);
    expect(lastReminder(messages)).toBe(leave);
    expect(applyPlanReminder(messages, "executor")).toBeUndefined();
  });
});
