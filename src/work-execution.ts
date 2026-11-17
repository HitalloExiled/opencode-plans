/**
 * Where and how a plan execution runs.
 *
 * Solo means nobody else is working in the repository and the tree is clean: the
 * branch is created in the working tree and the agent edits in place. Anything
 * else is parallel work and gets a worktree, so the user's checkout is left
 * alone. The decision is made at execution time — only then is concurrency
 * knowable — and never at item creation.
 */

import { dirname, join } from "node:path";
import {
  activeExecutions,
  finishExecution,
  getInitiative,
  plansDbPath,
  startExecution,
  type Db,
  type ExecutionRow,
} from "./store.js";
import { addWorktree, branchExists, git, isGitRepo } from "./git.js";
import { itemBranch } from "./run-paths.js";

export type WorkMode = "solo" | "worktree";

export type BeginWorkInput = {
  db: Db;
  repo: string;
  itemID: string;
  planID?: string | null;
  sessionID?: string | null;
  /** The caller already decided; used by the single-item run, whose own row
   * would otherwise make the repository look busy. */
  force?: WorkMode | undefined;
};

export type BeginWorkResult =
  | { ok: true; mode: WorkMode; branch: string; directory: string; execution: ExecutionRow }
  | { ok: false; error: string };

function primaryRepo(db: Db, initiativeID: string): string {
  const initiative = getInitiative(db, initiativeID);
  return initiative?.repos.find((entry) => entry.primary)?.directory ?? initiative?.repos[0]?.directory ?? "";
}

/** A repository is busy while another execution or a run is in flight there. */
export function isRepoBusy(db: Db, repo: string, exceptID?: string): boolean {
  if (activeExecutions(db, repo, exceptID).length > 0) return true;
  const runs = db
    .prepare("SELECT initiative_id, repo FROM runs WHERE status IN ('running', 'interrupted')")
    .all() as { initiative_id: string; repo: string | null }[];
  return runs.some((run) => (run.repo ?? primaryRepo(db, run.initiative_id)) === repo);
}

/** Uncommitted changes anywhere: solo must never mix with the user's work. */
export async function treeClean(repo: string): Promise<boolean> {
  const result = await git(repo, ["status", "--porcelain"]);
  return result.ok && result.stdout === "";
}

export function executionWorktree(itemID: string): string {
  return join(dirname(plansDbPath()), "worktrees", "executions", itemID);
}

function gitError(result: { error?: string; stderr?: string }, fallback: string): string {
  return result.error || result.stderr || fallback;
}

/**
 * Creates the branch (and, when the work is parallel, the worktree) and records
 * the execution. A failure here must never block the caller from running the
 * plan: the caller falls back to its previous behavior.
 */
export async function beginWork(input: BeginWorkInput): Promise<BeginWorkResult> {
  const repo = input.repo.trim();
  if (!repo) return { ok: false, error: "o plano não tem repositório para executar" };
  if (!(await isGitRepo(repo))) return { ok: false, error: `não é um repositório git: ${repo}` };

  const branch = itemBranch(input.itemID);
  const solo = input.force ? input.force === "solo" : !isRepoBusy(input.db, repo) && (await treeClean(repo));

  if (solo) {
    const switched = (await branchExists(repo, branch))
      ? await git(repo, ["switch", branch])
      : await git(repo, ["switch", "-c", branch]);
    if (!switched.ok) {
      return { ok: false, error: `não foi possível entrar em ${branch}: ${gitError(switched, "git switch")}` };
    }
    const recorded = startExecution(input.db, {
      repo,
      workItemID: input.itemID,
      planID: input.planID ?? null,
      sessionID: input.sessionID ?? null,
      mode: "solo",
      branch,
    });
    if (!recorded.ok) return recorded;
    return { ok: true, mode: "solo", branch, directory: repo, execution: recorded.execution };
  }

  const worktree = executionWorktree(input.itemID);
  if (await branchExists(repo, branch)) {
    // A previous attempt left the branch behind: start it over from HEAD.
    await git(repo, ["branch", "-D", branch]);
  }
  const added = await addWorktree({ repo, worktree, branch, startRef: "HEAD" });
  if (!added.ok) {
    return { ok: false, error: `não foi possível criar o worktree: ${gitError(added, "git worktree")}` };
  }
  const recorded = startExecution(input.db, {
    repo,
    workItemID: input.itemID,
    planID: input.planID ?? null,
    sessionID: input.sessionID ?? null,
    mode: "worktree",
    branch,
    worktree,
  });
  if (!recorded.ok) return recorded;
  return { ok: true, mode: "worktree", branch, directory: worktree, execution: recorded.execution };
}

/** Closes the execution row; the branch stays where it is. */
export function endWork(db: Db, executionID: string): { ok: true } | { ok: false; error: string } {
  const result = finishExecution(db, executionID);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
