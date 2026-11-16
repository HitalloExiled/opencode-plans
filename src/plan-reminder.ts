/**
 * Replica of the core Plan plugin's reminder.
 *
 * Plan has no system prompt: the runtime keeps it in Plan mode by injecting
 * this `<system-reminder>` as a user message right before the prompt on every
 * request, persisting a synthetic copy, and swapping it for `leave` once the
 * session stops using the agent. Replicating the mechanism (not just the text)
 * is what makes the planner behave like Plan, including after a compaction.
 *
 * The reminder lives in the request tail rather than in `system` on purpose:
 * `system` is the cached prefix, so the only bytes that change when the
 * planner and the executor alternate are the ones already new.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Where Plan writes when the user asks for a plan file (core uses `Global.home`). */
export const PLAN_DIR = join(process.env.OPENCODE_TEST_HOME ?? homedir(), ".opencode", "plan");

/** Verbatim from `packages/core/src/plugin/plan.ts`. */
export const enter = (directory: string) => `<system-reminder>
You are in Plan mode. Discuss the plan with the user directly in the conversation. Do not create or update plan files unless the user explicitly asks you to; when they do, write them only in:
${directory}

Do not modify any other files or ask a subagent to do so.

You remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents.
</system-reminder>`;

/** Verbatim from `packages/core/src/plugin/plan.ts`. */
export const leave = `<system-reminder>
You are NO LONGER in Plan mode. The previous Plan restrictions no longer apply. Any Plan mode instructions from earlier in this conversation are no longer active.
</system-reminder>`;

export const PLAN_REMINDER = enter(PLAN_DIR);

export type ReminderPart = { type: string; text?: string };
export type ReminderMessage = { role: string; content: ReminderPart[] };

/**
 * The last Plan reminder in the conversation, if any.
 *
 * Core only looks at a user message with a single text part. Our tail blocks
 * share the last user message, so a reminder can carry extra parts after it;
 * scanning every text part keeps the reconciliation from missing it and
 * re-injecting on every request.
 */
export function lastReminder(messages: readonly ReminderMessage[]): string | undefined {
  return messages.reduce<string | undefined>((found, message) => {
    if (message.role !== "user") return found;
    for (const part of message.content) {
      if (part.type !== "text") continue;
      if (part.text === PLAN_REMINDER || part.text === leave) return part.text;
    }
    return found;
  }, undefined);
}

export type ReminderPatch = { text: string; at: number };

/**
 * What the request needs, if anything: `enter` for the planner, `leave` when a
 * session leaves it, both placed right before the user's prompt (where the
 * core's own reminder lands).
 */
export function planReminderPatch(
  messages: readonly ReminderMessage[],
  agent: string | undefined,
): ReminderPatch | undefined {
  const reminder = lastReminder(messages);
  const missing = agent === "planner" && reminder !== PLAN_REMINDER;
  const stale = agent !== "planner" && reminder === PLAN_REMINDER;
  if (!missing && !stale) return undefined;
  const at = messages.at(-1)?.role === "user" ? messages.length - 1 : messages.length;
  return { text: missing ? PLAN_REMINDER : leave, at };
}

/**
 * Splices the patch into the request and returns the text that was added, so
 * the caller can persist the same bytes as a synthetic message.
 */
export function applyPlanReminder(
  messages: ReminderMessage[],
  agent: string | undefined,
): string | undefined {
  const patch = planReminderPatch(messages, agent);
  if (!patch) return undefined;
  messages.splice(patch.at, 0, { role: "user", content: [{ type: "text", text: patch.text }] });
  return patch.text;
}
