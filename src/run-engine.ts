/**
 * Project run engine (F4). The pure decisions live in `run-scheduler.ts`; this
 * module owns the side effects: preflight, the integration branch, one
 * worktree/branch and one executor session per item, the wait for the plan to
 * finish, and the hand-off to the merge queue.
 *
 * The engine never merges and never writes to the base branch: it accumulates
 * branches, enqueues finished items and lets the single merge session drain
 * the queue (F4 s5).
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { notificationLocale, tn, type NotificationLocale } from "./notifications.js";
import { emitPlanChange } from "./plan-events.js";
import {
  activeRun,
  createRun,
  createRunItem,
  enqueueMerge,
  getPlan,
  getPlanByWorkItem,
  getProject,
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
  type Project,
  type RunItemRow,
  type RunItemStatus,
  type RunRow,
  type WorkItemRow,
} from "./store.js";
import { findDependencyCycle } from "./work-footprint.js";
import { scheduleRun, summarizeRun, type SchedulerItem } from "./run-scheduler.js";

type Ctx = Plugin.Context;

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

/** Worktrees live next to `plans.db`, never inside the user's repo. */
export function runPaths(runID: string) {
  const root = join(dirname(plansDbPath()), "worktrees", runID);
  return {
    root,
    integration: join(root, "integration"),
    item: (itemID: string) => join(root, "items", itemID),
  };
}

export function integrationBranch(runID: string): string {
  return `run/${runID}`;
}

export function itemBranch(itemID: string): string {
  return `wi/${itemID}`;
}

/* ------------------------------------------------------------------ */
/* Preflight                                                           */
/* ------------------------------------------------------------------ */

export type PreflightItem = { item: WorkItemRow; plan: Plan; deps: string[] };

export type Preflight = {
  project: Project;
  repo: string;
  baseRef: string;
  maxParallel: number;
  items: PreflightItem[];
};

export type PreflightResult = { ok: true; value: Preflight } | { ok: false; blockers: string[] };

/** The workspace the run operates on: the session's location when it is one. */
function runLocation(project: Project, directory: string): Project["locations"][number] | undefined {
  const target = normalizeWorkspaceDirectory(directory);
  return (
    project.locations
      .filter((location) => {
        const base = normalizeWorkspaceDirectory(location.directory);
        return target === base || target.startsWith(base === "/" ? "/" : `${base}/`);
      })
      .sort((a, b) => b.directory.length - a.directory.length)[0] ?? project.locations.find((entry) => entry.primary)
  );
}

/**
 * Everything a run needs before touching anything: a git repo, a base ref, no
 * active run, at least one ready item with an active plan, all items in the
 * same workspace and a graph without cycles. Ready items without a plan are
 * simply not part of this run.
 */
export async function preflightRun(db: Db, projectID: string, directory: string): Promise<PreflightResult> {
  const blockers: string[] = [];
  const project = getProject(db, projectID);
  if (!project) return { ok: false, blockers: [`projeto não encontrado: ${projectID}`] };

  const location = runLocation(project, directory);
  const repo = normalizeWorkspaceDirectory(location?.directory ?? directory);
  if (!location) blockers.push(`o diretório não é um workspace do projeto: ${directory}`);

  if (!(await isGitRepo(repo))) blockers.push(`não é um repositório git: ${repo}`);
  const baseRef = project.base_branch?.trim() || (await defaultBranch(repo));
  if (!baseRef) blockers.push("base_ref não definido e nenhuma branch padrão encontrada");
  else if (!(await refExists(repo, baseRef))) blockers.push(`base_ref não existe: ${baseRef}`);

  const active = activeRun(db, projectID);
  if (active) blockers.push(`já existe um run ativo: ${active.id}`);

  // The footprint may have changed since the last plan save; the scheduler
  // depends on it being current.
  recomputeImplicitDeps(db, projectID);

  const ready = listWorkItems(db, projectID).filter((item) => item.status === "ready");
  const readyIDs = new Set(ready.map((item) => item.id));
  const selected: PreflightItem[] = [];
  for (const item of ready) {
    const plan = getPlanByWorkItem(db, item.id);
    if (!plan || plan.status !== "active") continue;
    if (plan.steps.length === 0) {
      blockers.push(`plano sem passos: ${item.title}`);
      continue;
    }
    const itemLocation = item.location_id
      ? project.locations.find((entry) => entry.id === item.location_id)
      : location;
    if (itemLocation && normalizeWorkspaceDirectory(itemLocation.directory) !== repo) {
      blockers.push(`item em outro workspace: ${item.title}`);
      continue;
    }

    const deps: string[] = [];
    for (const dep of workItemDeps(db, item.id).blockedBy) {
      if (readyIDs.has(dep.id) && getPlanByWorkItem(db, dep.id)?.status === "active") {
        deps.push(dep.id);
        continue;
      }
      if (dep.status === "done" || dep.status === "dropped") continue;
      blockers.push(`"${item.title}" depende de "${dep.title}", que não entra no run`);
    }
    selected.push({ item, plan, deps });
  }
  if (selected.length === 0) blockers.push("nenhum item ready com plano ativo");

  const cycle = findDependencyCycle(
    selected.flatMap((entry) => entry.deps.map((dep) => ({ itemID: entry.item.id, blocksID: dep }))),
  );
  if (cycle) blockers.push(`ciclo de dependências: ${cycle.join(" -> ")}`);

  if (blockers.length > 0) return { ok: false, blockers };
  return {
    ok: true,
    value: {
      project,
      repo,
      baseRef: baseRef!,
      maxParallel: project.max_parallel,
      items: selected,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Runtime                                                             */
/* ------------------------------------------------------------------ */

type Controller = { cancelled: boolean };

const controllers = new Map<string, Controller>();

async function engineLocale(ctx: Ctx): Promise<NotificationLocale> {
  try {
    return notificationLocale((await ctx.storage.get("locale")) as string | null | undefined);
  } catch {
    return "en-us";
  }
}

function notifyChange(sessionID?: string | null): void {
  emitPlanChange({ sessionID: sessionID ?? "" });
}

/** The repo of a run: the project's primary workspace (preflight enforces one). */
function runRepo(db: Db, run: RunRow): string {
  const project = getProject(db, run.project_id);
  const location = project?.locations.find((entry) => entry.primary) ?? project?.locations[0];
  return location?.directory ?? "";
}

export type StartRunInput = { projectID: string; directory: string };
export type StartRunResult = { ok: true; runID: string } | { ok: false; error: string };

/**
 * Starts a project run: preflight, the run row, the integration worktree and
 * the item rows, then the first scheduling pass. The call returns as soon as
 * the run is launched; items execute in the background.
 */
export async function startProjectRun(ctx: Ctx, db: Db, input: StartRunInput): Promise<StartRunResult> {
  const pre = await preflightRun(db, input.projectID, input.directory);
  if (!pre.ok) return { ok: false, error: pre.blockers.join("; ") };

  const created = createRun(db, {
    projectID: input.projectID,
    baseRef: pre.value.baseRef,
    maxParallel: pre.value.maxParallel,
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

  const session = await ctx.session.create({
    agent: runAgent(getFlow()),
    title: `Run: ${detail.title}`,
    location: { directory: worktree },
  });

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

  const controller = controllers.get(run.id);
  if (controller?.cancelled) return;

  const after = getPlan(db, plan.id);
  if (after?.status === "done") {
    setRunItemStatus(db, {
      runID: run.id,
      workItemID: item.work_item_id,
      status: "merging",
      error: null,
    });
    enqueueMerge(db, { runID: run.id, workItemID: item.work_item_id });
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
