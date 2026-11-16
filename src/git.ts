/**
 * Minimal git plumbing for project runs. Every call spawns `git` with an
 * explicit argument list (never a shell), so paths and branches are data.
 */

import { spawn } from "node:child_process";

export type GitResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; error: string; stdout: string; stderr: string };

/** Runs git in `cwd`; a non-zero exit is a failed result, not a throw. */
export function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolve({ ok: false, error: error.message, stdout, stderr });
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ ok: true, stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }
      const reason = signal ? `git ${args[0] ?? ""} terminou com ${signal}` : (stderr.trim() || stdout.trim() || `git ${args[0] ?? ""} saiu com ${code}`);
      resolve({ ok: false, error: reason, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/** Whether `dir` is inside a git work tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  const result = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout === "true";
}

export async function gitRoot(dir: string): Promise<string | undefined> {
  const result = await git(dir, ["rev-parse", "--show-toplevel"]);
  return result.ok ? result.stdout : undefined;
}

export async function currentSha(dir: string): Promise<string | undefined> {
  const result = await git(dir, ["rev-parse", "HEAD"]);
  return result.ok ? result.stdout : undefined;
}

/** The checked-out branch, or undefined on a detached HEAD. */
export async function currentBranch(dir: string): Promise<string | undefined> {
  const result = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!result.ok || result.stdout === "HEAD") return undefined;
  return result.stdout;
}

/** `base...head` names: what the branch adds on the base. */
export async function changedFiles(dir: string, baseRef: string, headRef = "HEAD"): Promise<string[]> {
  const result = await git(dir, ["diff", "--name-only", `${baseRef}...${headRef}`]);
  if (!result.ok) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** `git merge-base --is-ancestor`: exit 1 is a normal "no", not an error. */
export async function isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await git(dir, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return result.ok;
}

export type WorktreeInput = {
  /** Any directory inside the repository (the main checkout). */
  repo: string;
  /** Absolute path of the new worktree. */
  worktree: string;
  /** New branch name. */
  branch: string;
  /** Ref (or SHA) the branch starts from. */
  startRef: string;
};

/**
 * Creates `worktree` on a new `branch` starting at `startRef`. Fails when the
 * branch already exists: a retry must delete it first, explicitly.
 */
export function addWorktree(input: WorktreeInput): Promise<GitResult> {
  return git(input.repo, ["worktree", "add", "-b", input.branch, input.worktree, input.startRef]);
}

/** Removes the worktree; `force` discards uncommitted files. */
export function removeWorktree(repo: string, worktree: string, force = false): Promise<GitResult> {
  return git(repo, force ? ["worktree", "remove", "--force", worktree] : ["worktree", "remove", worktree]);
}

/** Deletes a branch that is no longer checked out anywhere. */
export function deleteBranch(repo: string, branch: string, force = true): Promise<GitResult> {
  return git(repo, ["branch", force ? "-D" : "-d", branch]);
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  const result = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return result.ok;
}

export async function refExists(repo: string, ref: string): Promise<boolean> {
  const result = await git(repo, ["rev-parse", "--verify", "--quiet", ref]);
  return result.ok;
}

/** Resolves `ref` to a SHA; undefined when it does not exist. */
export async function resolveRef(repo: string, ref: string): Promise<string | undefined> {
  const result = await git(repo, ["rev-parse", "--verify", ref]);
  return result.ok ? result.stdout : undefined;
}

/** The default branch: the remote HEAD, then common local names. */
export async function defaultBranch(repo: string): Promise<string | undefined> {
  const head = await git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.stdout) return head.stdout.replace(/^origin\//, "");
  for (const candidate of ["main", "master", "develop"]) {
    if (await branchExists(repo, candidate)) return candidate;
  }
  return currentBranch(repo);
}
