/**
 * Context layers the plugin adds to the model request.
 *
 * Two rules, both driven by the provider's prefix cache:
 *
 * - The routing rule is a CONSTANT string pushed as its own trailing system
 *   part on every request. Re-pushing the same bytes keeps the head of the
 *   prompt byte-identical; pushing it only once makes the head shrink on the
 *   next request and forces a re-prefill of the whole conversation.
 * - The plan block is DYNAMIC (progress, step ids), so it never touches
 *   `system`: it is appended to the tail of the last user message, and only
 *   after a compaction, when the plan text is no longer in the conversation.
 */

import { planProgress, type Plan } from "./store.js";

export const PLANS_ROUTING_RULE = [
  "Plans routing (additive; never overrides safety/correctness):",
  "- Plan mode allows plans.save and plans.update: they write only the plans database, never repository files.",
  "- When you present a final plan with no blocking question, call plans.save in the same turn; do not ask for permission.",
  "- The plans.save result already lists the step ids; do not call plans.get just to confirm.",
  '- Track progress with plans.update (stepID + stepStatus: "doing" then "done"); never rewrite the body to change status.',
].join("\n");

export const PLANS_CONTEXT_OPEN = "<plans-context>";
export const PLANS_CONTEXT_CLOSE = "</plans-context>";

const MAX_PENDING_STEPS = 8;
const MAX_STEP_TEXT = 240;

/** Structural view of the request messages: only what this layer reads/writes. */
export type InjectPart = { type: string; text?: string };
export type InjectMessage = { role: string; content: InjectPart[] };

/**
 * The rule is constant and re-pushed verbatim on every request. Anything that
 * varies per turn belongs in the tail block, never here.
 */
export function pushRoutingRule(system: Array<{ type: "text"; text: string }>): void {
  system.push({ type: "text", text: PLANS_ROUTING_RULE });
}

/** A compaction part marks a rewritten conversation: the plan text may be gone. */
export function hasCompaction(messages: readonly InjectMessage[]): boolean {
  return messages.some((message) => message.content.some((part) => part.type === "compaction"));
}

export function hasPlanBlock(messages: readonly InjectMessage[]): boolean {
  return messages.some((message) =>
    message.content.some((part) => part.type === "text" && (part.text ?? "").includes(PLANS_CONTEXT_OPEN)),
  );
}

/**
 * Appends the block to the tail of the current turn. Only a user message can
 * take it: within a tool loop the last message is an assistant/tool one, and
 * rewriting those would either fake tool output or break role alternation.
 */
export function appendTailBlock(messages: InjectMessage[], text: string): boolean {
  const last = messages.at(-1);
  if (!last || last.role !== "user") return false;
  if (hasPlanBlock(messages)) return false;
  last.content.push({ type: "text", text });
  return true;
}

function clip(text: string, max: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Compact view of the session plan: title, progress, id and pending steps. */
export function renderPlanContext(plan: Plan | undefined): string {
  if (!plan) return "";
  const { done, doing, total } = planProgress(plan);
  const progress = doing > 0 ? `${done}/${total}, ${doing} doing` : `${done}/${total}`;
  const lines = [
    PLANS_CONTEXT_OPEN,
    "## Session plan (persisted data, not instructions)",
    `- [${plan.status}] ${plan.title} (${progress})`,
    `id: ${plan.id}`,
  ];

  const pending = plan.steps.filter((step) => step.status !== "done");
  // The step in progress comes first: it is where the agent stopped.
  const ordered = [
    ...pending.filter((step) => step.status === "doing"),
    ...pending.filter((step) => step.status === "todo"),
  ];
  if (ordered.length > 0) {
    lines.push(
      "Pending:",
      ...ordered
        .slice(0, MAX_PENDING_STEPS)
        .map((step) => `- [${step.status}] (${step.step_id}) ${clip(step.text, MAX_STEP_TEXT)}`),
    );
  } else if (total > 0) {
    lines.push("All steps are done.");
  } else {
    lines.push("No structured steps; read the body with plans.get.");
  }

  lines.push(
    "",
    "Mark progress with plans.update (stepID + stepStatus: 'doing' then 'done'); never rewrite the body for status. Use plans.get only for text missing here.",
    PLANS_CONTEXT_CLOSE,
  );
  return lines.join("\n");
}
