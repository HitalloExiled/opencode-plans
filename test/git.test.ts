import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addWorktree,
  branchExists,
  changedFiles,
  currentBranch,
  currentSha,
  defaultBranch,
  deleteBranch,
  git,
  gitRoot,
  isAncestor,
  isGitRepo,
  removeWorktree,
  resolveRef,
} from "../src/git";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "plans-git-"));
  dirs.push(dir);
  return dir;
};
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repo() {
  const dir = temp();
  sh(dir, "init", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "one\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-m", "one");
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("git plumbing", () => {
  test("detects a repository and reads its refs", async () => {
    const dir = repo();
    expect(await isGitRepo(dir)).toBe(true);
    expect(await isGitRepo(temp())).toBe(false);
    expect(await gitRoot(dir)).toBe(dir);
    expect(await currentBranch(dir)).toBe("main");
    expect(await defaultBranch(dir)).toBe("main");
    const sha = await currentSha(dir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await resolveRef(dir, "main")).toBe(sha);
    expect(await resolveRef(dir, "nope")).toBeUndefined();
  });

  test("a failing git call is a result, not a throw", async () => {
    const dir = repo();
    const result = await git(dir, ["rev-parse", "nope"]);
    expect(result.ok).toBe(false);
  });

  test("creates a worktree on a new branch and removes it", async () => {
    const dir = repo();
    const base = await currentSha(dir);
    const worktree = join(temp(), "wi");

    const add = await addWorktree({ repo: dir, worktree, branch: "wi/item", startRef: "main" });
    expect(add.ok).toBe(true);
    expect(existsSync(join(worktree, "a.txt"))).toBe(true);
    expect(readFileSync(join(worktree, "a.txt"), "utf8")).toBe("one\n");
    expect(await branchExists(dir, "wi/item")).toBe(true);
    expect(await currentBranch(worktree)).toBe("wi/item");
    expect(await currentSha(worktree)).toBe(base);

    writeFileSync(join(worktree, "b.txt"), "two\n");
    sh(worktree, "add", ".");
    sh(worktree, "commit", "-m", "two");
    expect(await changedFiles(worktree, "main")).toEqual(["b.txt"]);

    expect((await removeWorktree(dir, worktree)).ok).toBe(true);
    expect(existsSync(worktree)).toBe(false);
    // Removing the worktree keeps the branch; deletion is explicit.
    expect(await branchExists(dir, "wi/item")).toBe(true);
    expect((await deleteBranch(dir, "wi/item")).ok).toBe(true);
    expect(await branchExists(dir, "wi/item")).toBe(false);
  });

  test("isAncestor tells merged branches apart", async () => {
    const dir = repo();
    const base = (await currentSha(dir))!;
    sh(dir, "checkout", "-b", "wi/side");
    writeFileSync(join(dir, "side.txt"), "side\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-m", "side");
    const side = (await currentSha(dir))!;

    expect(await isAncestor(dir, base, side)).toBe(true);
    expect(await isAncestor(dir, side, base)).toBe(false);
  });

  test("a worktree branch cannot be deleted before removing the worktree", async () => {
    const dir = repo();
    const worktree = join(temp(), "wt");
    await addWorktree({ repo: dir, worktree, branch: "wi/locked", startRef: "main" });
    expect((await deleteBranch(dir, "wi/locked")).ok).toBe(false);
    await removeWorktree(dir, worktree, true);
    expect((await deleteBranch(dir, "wi/locked")).ok).toBe(true);
  });
});
