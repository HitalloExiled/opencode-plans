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
import { getRun, setRunMergeSession, getMergeSessionRepo, setMergeSessionRepo, type Db, type RunRow } from "./store.js";

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

/**
 * Manual executions have no run, so their merge session is per repository: the
 * checkout is the base. Created on the first pending merge, woken on later
 * ones; with nothing queued, no session is made.
 */
export async function wakeManualMerge(
  ctx: Ctx,
  db: Db,
  repo: string,
  /** Boot recovery only creates a missing session; it does not nag a live one. */
  wakeExisting = true,
): Promise<void> {
  const target = repo.trim();
  if (!target) return;
  const pending = db
    .prepare(
      "SELECT 1 AS one FROM merge_queue WHERE repo = ? AND run_id IS NULL AND status IN ('queued', 'merging') LIMIT 1",
    )
    .get(target);
  if (!pending) return;

  const existing = getMergeSessionRepo(db, target);
  if (existing) {
    if (!wakeExisting) return;
    try {
      const locale = await engineLocale(ctx);
      await ctx.session.prompt({
        sessionID: existing as never,
        text: tn(locale, "run.merge.wake"),
        delivery: "queue",
      });
      return;
    } catch {
      // The stored session is gone: fall through and create a fresh one.
    }
  }

  const session = await ctx.session.create({
    agent: runAgent(getFlow()),
    title: `Merge: ${target.split("/").pop() || target}`,
    location: { directory: target },
  });
  setMergeSessionRepo(db, target, String(session.id));
  const locale = await engineLocale(ctx);
  await ctx.session.prompt({
    sessionID: session.id,
    text: tn(locale, "run.merge.manualPrompt", target),
  });
}

/** Best-effort wake for the plan write paths: a failure never fails the write. */
export function wakeManualMergeSoon(ctx: Ctx, db: Db, repo: string | null | undefined): void {
  if (!repo) return;
  void wakeManualMerge(ctx, db, repo).catch((error: unknown) => {
    console.warn(
      `[plans] manual merge session for ${repo} could not be woken: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
