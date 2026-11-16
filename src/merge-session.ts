/**
 * The single merge session of a run (F4 s5).
 *
 * The engine never merges: when an item's plan is done it enqueues the item,
 * and this session — one per run, living in the integration worktree — drains
 * the queue with the `merge.*` tools. Creating it is lazy: the first enqueue
 * opens the session; later enqueues wake it with a queued prompt.
 */

import type { Plugin } from "@opencode/plugin";
import { getFlow } from "./flow.js";
import { runAgent } from "./flow-rules.js";
import { notificationLocale, tn, type NotificationLocale } from "./notifications.js";
import { integrationBranch, runPaths } from "./run-engine.js";
import { getRun, setRunMergeSession, type Db, type RunRow } from "./store.js";

type Ctx = Plugin.Context;

export async function engineLocale(ctx: Ctx): Promise<NotificationLocale> {
  try {
    return notificationLocale((await ctx.storage.get("locale")) as string | null | undefined);
  } catch {
    return "en-us";
  }
}

/** The run whose merge session is `sessionID`, if any. */
export function runForMergeSession(db: Db, sessionID: string): RunRow | undefined {
  return db.prepare("SELECT * FROM runs WHERE merge_session_id = ?").get(sessionID) as RunRow | undefined;
}

export type MergeSession = { sessionID: string; created: boolean };

/**
 * Returns the run's merge session, creating it (and its drain prompt) on first
 * use. A run without an integration worktree has nowhere to merge.
 */
export async function ensureMergeSession(
  ctx: Ctx,
  db: Db,
  runID: string,
): Promise<MergeSession | undefined> {
  const run = getRun(db, runID);
  if (!run) return undefined;
  if (run.merge_session_id) return { sessionID: run.merge_session_id, created: false };

  const session = await ctx.session.create({
    agent: runAgent(getFlow()),
    title: `Merge: run ${run.id.slice(0, 8)}`,
    location: { directory: runPaths(run.id).integration },
  });
  const sessionID = String(session.id);
  setRunMergeSession(db, run.id, sessionID);
  const locale = await engineLocale(ctx);
  await ctx.session.prompt({
    sessionID: session.id,
    text: tn(locale, "run.merge.prompt", run.id, integrationBranch(run.id)),
  });
  return { sessionID, created: true };
}

/** Tells the merge session that the queue grew; a fresh one already knows. */
export async function wakeMergeSession(ctx: Ctx, db: Db, runID: string): Promise<void> {
  const ensured = await ensureMergeSession(ctx, db, runID);
  if (!ensured || ensured.created) return;
  const locale = await engineLocale(ctx);
  await ctx.session.prompt({
    sessionID: ensured.sessionID as never,
    text: tn(locale, "run.merge.wake"),
    delivery: "queue",
  });
}
