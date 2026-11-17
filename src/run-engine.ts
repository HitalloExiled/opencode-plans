/**
 * Initiative run engine (F4). The pure decisions live in `run-scheduler.ts`; this
 * module owns the side effects: preflight, the integration branch, one
 * worktree/branch and one executor session per item, the wait for the plan to
 * finish, and the hand-off to the merge queue.
 *
 * The engine never merges and never writes to the base branch: it accumulates
 * branches, enqueues finished items and lets the single merge session drain
 * the queue (F4 s5).
 */

import { mkdirSync } from "node:fs";
import type { Plugin } from "@opencode/plugin";
import {
  addWorktree,
  branchExists,
  currentSha,
  defaultBranch,
  deleteBranch,
  isGitRepo,
  refExists,
  removeWorktree,
} from "./git.js";
import { getFlow } from "./flow.js";
import { runAgent } from "./flow-rules.js";
import { tn } from "./notifications.js";
import { emitPlanChange } from "./plan-events.js";
import {
  activeRun,
  createRun,
  createRunItem,
  enqueueMerge,
  getPlan,
  getPlanByWorkItem,
  getInitiative,
  getRun,
  getRunItem,
  getWorkItem,
  listRunItems,
  listWorkItems,
  normalizeWorkspaceDirectory,
  plansDbPath,
  recomputeImplicitDeps,
  requireStore,
  setRunItemStatus,
  setRunStatus,
  workItemDeps,
  type Db,
  type Plan,
  type Initiative,
  type RunItemRow,
  type RunItemStatus,
  type RunRow,
  type WorkItemRow,
} from "./store.js";
import { findDependencyCycle } from "./work-footprint.js";
import { scheduleRun, summarizeRun, type SchedulerItem } from "./run-scheduler.js";
import { integrationBranch, itemBranch, runPaths } from "./run-paths.js";
import { engineLocale, wakeMergeSession } from "./merge-session.js";
import { git } from "./git.js";
import { beginWork, endWork, isRepoBusy, treeClean } from "./work-execution.js";

export { runPaths, integrationBranch, itemBranch } from "./run-paths.js";

type Ctx = Plugin.Context;

/* ------------------------------------------------------------------ */
/* Preflight                                                           */
/* ------------------------------------------------------------------ */

export type PreflightItem = { item: WorkItemRow; plan: Plan; deps: string[] };

export type Preflight = {
  initiative: Initiative;
  repo: string;
  baseRef: string;
  maxParallel: number;
  items: PreflightItem[];
};

/** Why a run cannot start, as data: the UI translates `code` and fills `args`. */
export type BlockerCode =
  | "initiative_missing"
  | "no_repo"
  | "directory_not_in_initiative"
  | "not_git"
  | "no_base_ref"
  | "base_ref_missing"
  | "active_run"
  | "no_ready_item"
  | "plan_without_steps"
  | "item_other_repo"
  | "item_without_repo"
  | "items_in_different_repos"
  | "dep_not_in_run"
  | "cycle";

export type PreflightBlocker = { code: BlockerCode; args?: readonly string[] };

export type PreflightResult = { ok: true; value: Preflight } | { ok: false; blockers: PreflightBlocker[] };

/** The repositório the run operates on: the session's repo when it is one. */
function runLocation(initiative: Initiative, directory: string): Initiative["repos"][number] | undefined {
  const target = normalizeWorkspaceDirectory(directory);
  return (
    initiative.repos
      .filter((repo) => {
        const base = normalizeWorkspaceDirectory(repo.directory);
        return target === base || target.startsWith(base === "/" ? "/" : `${base}/`);
      })
      .sort((a, b) => b.directory.length - a.directory.length)[0] ?? initiative.repos.find((entry) => entry.primary)
  );
}

/**
 * Everything a run needs before touching anything: a git repo, a base ref, no
 * active run, at least one ready item with an active plan, all items in the
 * same repositório and a graph without cycles. Ready items without a plan are
 * simply not part of this run.
 *
 * The repository is not required on the initiative: an item resolves to its own
 * `repo_id`, else to the project its plan was saved from, so a grouped backlog
 * runs from what its plans already know.
 */
export async function preflightRun(db: Db, initiativeID: string, directory: string): Promise<PreflightResult> {
  const blockers: PreflightBlocker[] = [];
  const initiative = getInitiative(db, initiativeID);
  if (!initiative) {
    return { ok: false, blockers: [{ code: "initiative_missing", args: [initiativeID] }] };
  }

  const active = activeRun(db, initiativeID);
  if (active) blockers.push({ code: "active_run", args: [active.id] });

  // The footprint may have changed since the last plan save; the scheduler
  // depends on it being current.
  recomputeImplicitDeps(db, initiativeID);

  // The repository the surface points at (the session's, when it belongs to
  // the initiative). Empty for an initiative with no repository: then the
  // plans decide.
  const repoEntry = runLocation(initiative, directory);
  const declared = normalizeWorkspaceDirectory(repoEntry?.directory ?? directory);

  const ready = listWorkItems(db, initiativeID).filter((item) => item.status === "ready");
  const readyIDs = new Set(ready.map((item) => item.id));
  const candidates: { item: WorkItemRow; plan: Plan; deps: string[]; dir: string }[] = [];
  for (const item of ready) {
    const plan = getPlanByWorkItem(db, item.id);
    if (!plan || plan.status !== "active") continue;
    if (plan.steps.length === 0) {
      blockers.push({ code: "plan_without_steps", args: [item.title] });
      continue;
    }
    const itemRepo = item.repo_id ? initiative.repos.find((entry) => entry.id === item.repo_id) : undefined;
    // Its own repository, the declared one, else the project the plan was saved
    // from — a repo-less initiative still runs from what its plans know.
    const dir = normalizeWorkspaceDirectory(itemRepo?.directory || declared || plan.project_directory || "");
    if (!dir) {
      blockers.push({ code: "item_without_repo", args: [item.title] });
      continue;
    }

    const deps: string[] = [];
    for (const dep of workItemDeps(db, item.id).blockedBy) {
      if (readyIDs.has(dep.id) && getPlanByWorkItem(db, dep.id)?.status === "active") {
        deps.push(dep.id);
        continue;
      }
      if (dep.status === "done" || dep.status === "dropped") continue;
      blockers.push({ code: "dep_not_in_run", args: [item.title, dep.title] });
    }
    candidates.push({ item, plan, deps, dir });
  }

  // One repository per run: the declared one, else the project the plans point
  // at. Plans that disagree without a declared repository block the run.
  const dirs = [...new Set(candidates.map((entry) => entry.dir))];
  if (!declared && dirs.length > 1) {
    blockers.push({ code: "items_in_different_repos", args: [dirs[0]!, dirs[1]!] });
  }
  const repo = declared || dirs[0] || "";
  if (!repo) return { ok: false, blockers: [...blockers, { code: "no_repo" }] };

  if (!(await isGitRepo(repo))) blockers.push({ code: "not_git", args: [repo] });
  const baseRef = initiative.base_branch?.trim() || (await defaultBranch(repo));
  if (!baseRef) blockers.push({ code: "no_base_ref" });
  else if (!(await refExists(repo, baseRef))) blockers.push({ code: "base_ref_missing", args: [baseRef] });

  const selected: PreflightItem[] = [];
  for (const entry of candidates) {
    if (entry.dir !== repo) {
      blockers.push({ code: "item_other_repo", args: [entry.item.title] });
      continue;
    }
    selected.push({ item: entry.item, plan: entry.plan, deps: entry.deps });
  }
  if (selected.length === 0) blockers.push({ code: "no_ready_item" });

  const cycle = findDependencyCycle(
    selected.flatMap((entry) => entry.deps.map((dep) => ({ itemID: entry.item.id, blocksID: dep }))),
  );
  if (cycle) blockers.push({ code: "cycle", args: [cycle.join(" -> ")] });

  if (blockers.length > 0) return { ok: false, blockers };
  return {
    ok: true,
    value: {
      initiative,
      repo,
      baseRef: baseRef!,
      maxParallel: initiative.max_parallel,
      items: selected,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Runtime                                                             */
/* ------------------------------------------------------------------ */

type Controller = { cancelled: boolean };

const controllers = new Map<string, Controller>();

function notifyChange(sessionID?: string | null): void {
  emitPlanChange({ sessionID: sessionID ?? "" });
}

/**
 * The repo of a run: the one persisted at start (derived from the plans), with
 * the initiative's primary as the fallback for runs older than schema v9.
 */
function runRepo(db: Db, run: RunRow): string {
  if (run.repo) return run.repo;
  const initiative = getInitiative(db, run.initiative_id);
  const repo = initiative?.repos.find((entry) => entry.primary) ?? initiative?.repos[0];
  return repo?.directory ?? "";
}

export type StartRunInput = { initiativeID: string; directory: string };
/** A preflight failure comes back as `blockers`; anything else as `error`. */
export type StartRunResult =
  | { ok: true; runID: string }
  | { ok: false; error?: string; blockers?: readonly PreflightBlocker[] };

/**
 * The single-item run: the item works in the repository on `wi/<item>` and,
 * when the plan is done, `run/<id>` is created pointing at its head. Nothing
 * touches the base branch and no merge session is needed — there is nothing to
 * merge. Cancel and plan checks mirror `executeItem`, so the same invariants
 * hold without the integration worktree.
 */
function startSoloRun(
  ctx: Ctx,
  db: Db,
  initiativeID: string,
  pre: Preflight,
  entry: PreflightItem,
): StartRunResult {
  const created = createRun(db, {
    initiativeID,
    baseRef: pre.baseRef,
    maxParallel: 1,
    repo: pre.repo,
  });
  if (!created.ok) return { ok: false, error: created.error };
  const run = created.run;

  const item = createRunItem(db, { runID: run.id, workItemID: entry.item.id, planID: entry.plan.id });
  if (!item.ok) {
    setRunStatus(db, { id: run.id, status: "failed", error: item.error });
    return { ok: false, error: item.error };
  }

  controllers.set(run.id, { cancelled: false });
  notifyChange();
  void executeSoloItem(ctx, db, run, entry).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[plans] solo run ${run.id} failed: ${message}`);
    if (getRun(db, run.id)?.status !== "running") return;
    setRunItemStatus(db, { runID: run.id, workItemID: entry.item.id, status: "failed", error: message });
    setRunStatus(db, { id: run.id, status: "failed", error: message });
    notifyChange();
  });
  return { ok: true, runID: run.id };
}

async function executeSoloItem(ctx: Ctx, db: Db, run: RunRow, entry: PreflightItem): Promise<void> {
  const repo = runRepo(db, run);
  const work = await beginWork({
    db,
    repo,
    itemID: entry.item.id,
    planID: entry.plan.id,
    force: "solo",
  });
  if (!work.ok) throw new Error(work.error);

  // A cancel that lands mid-flight owns the outcome, exactly like the
  // integration path: never overwrite it.
  const stillRunning = (): boolean =>
    controllers.get(run.id)?.cancelled !== true &&
    getRun(db, run.id)?.status === "running" &&
    getRunItem(db, run.id, entry.item.id)?.status === "running";

  setRunItemStatus(db, {
    runID: run.id,
    workItemID: entry.item.id,
    status: "running",
    branch: work.branch,
  });
  notifyChange();

  try {
    const locale = await engineLocale(ctx);
    const session = await ctx.session.create({
      agent: runAgent(getFlow()),
      title: `Run: ${entry.item.title}`,
      location: { directory: work.directory },
    });
    if (!stillRunning()) {
      await ctx.session.interrupt({ sessionID: session.id }).catch(() => undefined);
      return;
    }
    setRunItemStatus(db, {
      runID: run.id,
      workItemID: entry.item.id,
      status: "running",
      sessionID: session.id,
    });

    await ctx.session.prompt({
      sessionID: session.id,
      text: tn(locale, "run.item.prompt", entry.plan.title, entry.plan.id, entry.item.title, entry.item.id),
    });
    if (!stillRunning()) return;

    const plan = getPlan(db, entry.plan.id);
    if (!plan || plan.status !== "done") {
      throw new Error(`o plano não foi concluído (status: ${plan?.status ?? "ausente"})`);
    }
    // One item, one branch: the integration is the item's head.
    const branch = await git(repo, ["branch", integrationBranch(run.id), itemBranch(entry.item.id)]);
    if (!branch.ok) throw new Error(`integração: ${branch.error}`);
    setRunItemStatus(db, {
      runID: run.id,
      workItemID: entry.item.id,
      status: "merged",
      mergedSha: (await currentSha(repo)) ?? undefined,
    });
    setRunStatus(db, { id: run.id, status: "done" });
  } finally {
    endWork(db, work.execution.id);
    notifyChange();
  }
}

/**
 * Starts a initiative run: preflight, the run row, the integration worktree and
 * the item rows, then the first scheduling pass. The call returns as soon as
 * the run is launched; items execute in the background.
 */
export async function startProjectRun(ctx: Ctx, db: Db, input: StartRunInput): Promise<StartRunResult> {
  const pre = await preflightRun(db, input.initiativeID, input.directory);
  if (!pre.ok) return { ok: false, blockers: pre.blockers };

  // A single item, with nobody else in the repository and a clean tree, needs
  // neither an integration worktree nor a merge session: it runs in place on
  // wi/<item> and the integration branch is created from its head.
  if (pre.value.items.length === 1) {
    const only = pre.value.items[0]!;
    if (!isRepoBusy(db, pre.value.repo) && (await treeClean(pre.value.repo))) {
      return startSoloRun(ctx, db, input.initiativeID, pre.value, only);
    }
  }

  const created = createRun(db, {
    initiativeID: input.initiativeID,
    baseRef: pre.value.baseRef,
    maxParallel: pre.value.maxParallel,
    repo: pre.value.repo,
  });
  if (!created.ok) return { ok: false, error: created.error };
  const run = created.run;

  const paths = runPaths(run.id);
  try {
    mkdirSync(paths.root, { recursive: true });
  } catch {
    /* git creates the leaf; the root keeps the tree together */
  }
  const integration = await addWorktree({
    repo: pre.value.repo,
    worktree: paths.integration,
    branch: integrationBranch(run.id),
    startRef: pre.value.baseRef,
  });
  if (!integration.ok) {
    setRunStatus(db, { id: run.id, status: "failed", error: integration.error });
    return { ok: false, error: `não foi possível criar a integração: ${integration.error}` };
  }

  for (const entry of pre.value.items) {
    const item = createRunItem(db, {
      runID: run.id,
      workItemID: entry.item.id,
      planID: entry.plan.id,
    });
    if (!item.ok) {
      setRunStatus(db, { id: run.id, status: "failed", error: item.error });
      return { ok: false, error: item.error };
    }
  }

  controllers.set(run.id, { cancelled: false });
  notifyChange();
  void pump(ctx, db, run.id).catch((error: unknown) => {
    console.error(`[plans] run ${run.id} pump failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return { ok: true, runID: run.id };
}

/** One scheduling pass: skip, start, and finish when nothing is pending. */
async function pump(ctx: Ctx, db: Db, runID: string): Promise<void> {
  const controller = controllers.get(runID);
  if (!controller || controller.cancelled) return;
  const run = getRun(db, runID);
  if (!run || run.status !== "running") return;

  const items = listRunItems(db, runID);
  const entries: SchedulerItem[] = items.map((item) => ({
    id: item.work_item_id,
    status: item.status as RunItemStatus,
    deps: workItemDeps(db, item.work_item_id).blockedBy
      .map((dep) => dep.id)
      .filter((dep) => items.some((entry) => entry.work_item_id === dep)),
  }));
  const decision = scheduleRun(entries, run.max_parallel);

  for (const id of decision.skip) {
    setRunItemStatus(db, {
      runID,
      workItemID: id,
      status: "skipped",
      error: "dependência falhou",
    });
  }
  for (const id of decision.start) {
    // Mark first: two pumps must never launch the same item twice.
    const current = getRunItem(db, runID, id);
    if (!current) continue;
    setRunItemStatus(db, { runID, workItemID: id, status: "running" });
    void executeItem(ctx, db, run, current).catch((error: unknown) => {
      console.error(`[plans] run ${runID} item ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      setRunItemStatus(db, {
        runID,
        workItemID: id,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      void pump(ctx, db, runID).catch(() => undefined);
    });
  }

  if (decision.done) finishRun(ctx, db, runID);
  notifyChange();
}

/**
 * One item: branch from the integration tip, a session in its worktree, the
 * plan prompt, and the wait. A finished plan goes to the merge queue; anything
 * else fails the item.
 */
async function executeItem(ctx: Ctx, db: Db, run: RunRow, item: RunItemRow): Promise<void> {
  const repo = runRepo(db, run);
  const detail = getWorkItem(db, item.work_item_id);
  const plan = item.plan_id ? getPlan(db, item.plan_id) : undefined;
  if (!detail || !plan) throw new Error("item ou plano sumiu antes de executar");

  const worktree = runPaths(run.id).item(item.work_item_id);
  const branch = itemBranch(item.work_item_id);
  const paths = runPaths(run.id);

  // A retry starts from the current integration tip; the old branch is gone.
  if (await branchExists(repo, branch)) await deleteBranch(repo, branch);
  const tip = (await currentSha(paths.integration)) ?? run.base_ref;
  const added = await addWorktree({ repo, worktree, branch, startRef: tip });
  if (!added.ok) throw new Error(`worktree: ${added.error}`);

  // A cancel may land during the git work: the item is closed, so undo quietly.
  const stillRunning = (): boolean =>
    controllers.get(run.id)?.cancelled !== true &&
    getRun(db, run.id)?.status === "running" &&
    getRunItem(db, run.id, item.work_item_id)?.status === "running";

  if (!stillRunning()) {
    await removeWorktree(repo, worktree, true).catch(() => undefined);
    return;
  }

  const session = await ctx.session.create({
    agent: runAgent(getFlow()),
    title: `Run: ${detail.title}`,
    location: { directory: worktree },
  });

  if (!stillRunning()) {
    await ctx.session.interrupt({ sessionID: session.id }).catch(() => undefined);
    return;
  }

  setRunItemStatus(db, {
    runID: run.id,
    workItemID: item.work_item_id,
    status: "running",
    branch,
    worktree,
    sessionID: String(session.id),
  });

  const locale = await engineLocale(ctx);
  await ctx.session.prompt({
    sessionID: session.id,
    text: tn(locale, "run.item.prompt", plan.title, plan.id, detail.title, detail.id),
  });
  await ctx.session.wait({ sessionID: session.id });

  // A cancel (or a finished run) may land while the turn was in flight: the
  // item was already closed by cancelProjectRun, so touch nothing.
  const controller = controllers.get(run.id);
  const currentRun = getRun(db, run.id);
  const currentItem = getRunItem(db, run.id, item.work_item_id);
  if (controller?.cancelled || currentRun?.status !== "running" || currentItem?.status !== "running") {
    return;
  }

  const after = getPlan(db, plan.id);
  if (after?.status === "done") {
    setRunItemStatus(db, {
      runID: run.id,
      workItemID: item.work_item_id,
      status: "merging",
      error: null,
    });
    enqueueMerge(db, { runID: run.id, workItemID: item.work_item_id });
    // The queue drains in one dedicated session; wake it (or create it now).
    await wakeMergeSession(ctx, db, run.id).catch((error: unknown) => {
      console.error(
        `[plans] run ${run.id} could not wake the merge session: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  } else {
    setRunItemStatus(db, {
      runID: run.id,
      workItemID: item.work_item_id,
      status: "failed",
      error: `o plano não foi concluído (status: ${after?.status ?? "ausente"})`,
    });
  }
  notifyChange(String(session.id));
  await pump(ctx, db, run.id);
}

/** Called by the merge tools once an entry is merged or failed. */
export function resumeAfterMerge(ctx: Ctx, db: Db, runID: string): void {
  void pump(ctx, db, runID).catch((error: unknown) => {
    console.error(`[plans] run ${runID} resume failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function finishRun(ctx: Ctx, db: Db, runID: string): void {
  const items = listRunItems(db, runID);
  const summary = summarizeRun(items);
  if (summary.status === "running") return;

  setRunStatus(db, {
    id: runID,
    status: summary.status,
    error: summary.failed > 0 ? `${summary.failed} item(ns) falharam` : null,
  });
  controllers.delete(runID);

  const run = getRun(db, runID);
  if (!run) return;
  const repo = runRepo(db, run);
  const paths = runPaths(runID);
  // Keep the integration worktree until the user reviews it; item worktrees
  // are disposable once their branches exist.
  for (const item of items) {
    void removeWorktree(repo, paths.item(item.work_item_id), true).catch(() => undefined);
  }
}

/** Cancels a run: stop launching, interrupt the sessions, close the items. */
export async function cancelProjectRun(ctx: Ctx, db: Db, runID: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const run = getRun(db, runID);
  if (!run) return { ok: false, error: `run não encontrado: ${runID}` };
  const controller = controllers.get(runID);
  if (controller) controller.cancelled = true;

  for (const item of listRunItems(db, runID)) {
    if (item.status === "running" && item.session_id) {
      await ctx.session.interrupt({ sessionID: item.session_id as never }).catch(() => undefined);
    }
    if (item.status === "queued" || item.status === "running" || item.status === "merging") {
      setRunItemStatus(db, {
        runID,
        workItemID: item.work_item_id,
        status: "skipped",
        error: "run cancelada",
      });
    }
  }
  setRunStatus(db, { id: runID, status: "cancelled", error: "cancelada pelo usuário" });
  controllers.delete(runID);
  notifyChange();
  return { ok: true };
}

/** Sends a failed item back to the queue; the branch is recreated on launch. */
export async function retryRunItem(
  ctx: Ctx,
  db: Db,
  runID: string,
  itemID: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const run = getRun(db, runID);
  if (!run) return { ok: false, error: `run não encontrado: ${runID}` };
  if (run.status === "done" || run.status === "failed" || run.status === "cancelled") {
    return { ok: false, error: "o run já terminou; inicie um novo run" };
  }
  const item = getRunItem(db, runID, itemID);
  if (!item) return { ok: false, error: `item não encontrado no run: ${itemID}` };
  if (item.status !== "failed" && item.status !== "skipped") {
    return { ok: false, error: `só itens falhos ou pulados podem ser retentados: ${item.status}` };
  }

  const repo = runRepo(db, run);
  const worktree = runPaths(runID).item(itemID);
  await removeWorktree(repo, worktree, true).catch(() => undefined);
  if (await branchExists(repo, itemBranch(itemID))) await deleteBranch(repo, itemBranch(itemID));
  if (!controllers.has(runID)) controllers.set(runID, { cancelled: false });
  setRunItemStatus(db, { runID, workItemID: itemID, status: "queued", error: null });
  notifyChange();
  void pump(ctx, db, runID).catch(() => undefined);
  return { ok: true };
}

/**
 * Resumes an interrupted run: the queued items go back to the scheduler. Their
 * worktrees and branches are cleaned first, so `executeItem` starts them from
 * the current integration tip exactly like a retry.
 */
export async function resumeProjectRun(
  ctx: Ctx,
  db: Db,
  runID: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const run = getRun(db, runID);
  if (!run) return { ok: false, error: `run não encontrado: ${runID}` };
  if (run.status !== "interrupted") {
    return { ok: false, error: `só runs interrompidas podem ser retomadas: ${run.status}` };
  }

  const repo = runRepo(db, run);
  for (const item of listRunItems(db, runID)) {
    if (item.status !== "queued") continue;
    await removeWorktree(repo, runPaths(runID).item(item.work_item_id), true).catch(() => undefined);
    if (await branchExists(repo, itemBranch(item.work_item_id))) {
      await deleteBranch(repo, itemBranch(item.work_item_id)).catch(() => undefined);
    }
    setRunItemStatus(db, { runID, workItemID: item.work_item_id, status: "queued", error: null });
  }

  const resumed = setRunStatus(db, { id: runID, status: "running", error: null });
  if (!resumed.ok) return { ok: false, error: resumed.error };
  controllers.set(runID, { cancelled: false });
  notifyChange();
  void pump(ctx, db, runID).catch(() => undefined);
  return { ok: true };
}

/**
 * After a service restart nothing resumes on its own: runs marked running
 * become interrupted, in-flight merges go back to queued and running items
 * return to the queue. The user decides whether to retry.
 */
export function recoverRuns(db: Db): number {
  const rows = db.prepare("SELECT id FROM runs WHERE status = 'running'").all() as { id: string }[];
  for (const row of rows) {
    setRunStatus(db, { id: row.id, status: "interrupted", error: "serviço reiniciou; run interrompida" });
  }
  db.prepare("UPDATE merge_queue SET status = 'queued', claimed_at = NULL WHERE status = 'merging'").run();
  db.prepare("UPDATE run_items SET status = 'queued' WHERE status IN ('running', 'merging')").run();
  return rows.length;
}
