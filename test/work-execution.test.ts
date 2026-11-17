import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { DatabaseSync } = (await import("node:sqlite")) as any;

const roots: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "plans-exec-"));
  roots.push(dir);
  return dir;
};
process.env.PLANS_DB = join(temp(), "plans.db");

const { initSchema, startExecution } = await import("../src/store");
type Db = import("../src/store").Db;
const { beginWork, endWork, executionWorktree, isRepoBusy, treeClean } = await import("../src/work-execution");
const { currentBranch } = await import("../src/git");

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

const open = (): Db => {
  const db = new DatabaseSync(":memory:") as Db;
  initSchema(db);
  return db;
};

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("beginWork", () => {
  test("solo creates the item branch in the working tree and records the execution", async () => {
    const db = open();
    const dir = repo();

    const result = await beginWork({ db, repo: dir, itemID: "item-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("solo");
    expect(result.directory).toBe(dir);
    expect(await currentBranch(dir)).toBe("wi/item-1");
    expect(isRepoBusy(db, dir)).toBe(true);

    expect(endWork(db, result.execution.id).ok).toBe(true);
    expect(isRepoBusy(db, dir)).toBe(false);
  });

  test("a dirty tree is parallel work and gets a worktree", async () => {
    const db = open();
    const dir = repo();
    writeFileSync(join(dir, "dirty.txt"), "wip\n");
    expect(await treeClean(dir)).toBe(false);

    const result = await beginWork({ db, repo: dir, itemID: "item-2" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("worktree");
    expect(result.directory).toBe(executionWorktree("item-2"));
    expect(await currentBranch(dir)).toBe("main");
  });

  test("another execution in the same repository makes it parallel", async () => {
    const db = open();
    const dir = repo();
    const busy = startExecution(db, { repo: dir, mode: "solo", branch: "other", workItemID: "x" });
    if (!busy.ok) throw new Error(busy.error);

    const result = await beginWork({ db, repo: dir, itemID: "item-3" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("worktree");
  });

  test("a path that is not a git repository fails without throwing", async () => {
    const db = open();
    const result = await beginWork({ db, repo: temp(), itemID: "item-4" });
    expect(result.ok).toBe(false);
  });
});
