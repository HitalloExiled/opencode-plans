/**
 * Idempotence and detection helpers for the post-turn save nudge.
 *
 * The claim is process-global (shared across plugin reloads) and the marker is
 * also persisted in plugin storage by the caller, so a plan message is nudged
 * at most once even when several guard instances or events race.
 */

import type { CapturedPlan } from "./capture.js";
import { extractSteps, normalizeStepText } from "./plan-body.js";
import { getPlanByMessageID, listPlans, type Store } from "./store.js";

const NUDGED_KEY = Symbol.for("opencode.plans.saveGuard.nudged");
const globalState = globalThis as unknown as Record<symbol, Set<string> | undefined>;
const nudged = (globalState[NUDGED_KEY] ??= new Set<string>());

/** Claim a plan message. False when another instance already claimed it. */
export function claimSaveNudge(messageID: string): boolean {
  if (nudged.has(messageID)) return false;
  nudged.add(messageID);
  return true;
}

/** Durable storage key for a claimed plan message. */
export function saveNudgeKey(messageID: string): string {
  return `plans:save-nudge:${messageID}`;
}

/**
 * Whether the captured plan message already has a matching saved plan.
 *
 * Session-scoped on purpose: session ids are unique and a `move` keeps the
 * same `session_id`, while the guard instance's `ctx.location` can belong to
 * another project (the home instance receives events for every project). A
 * project filter here would miss the plan and nudge a saved message.
 */
export function planAlreadySaved(
  store: Store,
  sessionID: string,
  captured: CapturedPlan,
): boolean {
  if (captured.messageID && getPlanByMessageID(store.db, captured.messageID)) return true;
  const target = extractSteps(captured.body).map((step) => normalizeStepText(step.text));
  if (target.length === 0) return true;
  const plans = listPlans(store.db, {
    sessionID,
    status: "all",
    limit: 50,
  });
  return plans.some((plan) => {
    const texts = plan.steps.map((step) => normalizeStepText(step.text));
    return texts.length === target.length && texts.every((text, index) => text === target[index]);
  });
}
