/**
 * End-to-end of the run engine with a fake agent (F4 s7).
 *
 * The fake context plays both roles a real run needs: the executor (commits in
 * the item worktree and marks the plan done) and the single merge session
 * (claims the queue, merges, resolves the conflict, finishes). That keeps the
 * test deterministic and offline while exercising the real engine, scheduler,
 * store, worktrees, merge queue and git guards.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "plans-e2e-"));
  roots.push(dir);
  return dir;
};
process.env.PLANS_DB = join(temp(), "plans.db");

const { DatabaseSync } = (await import("node:sqlite")) as any;
const store = await import("../src/store");
const {
  addWorkItemDep,
  claimNextMerge,
  createProject,
  createWorkItem,
  finishMerge,
  getPlanByWorkItem,
  getRun,
  initSchema,
  listMergeQueue,
  listRunItems,
  requireStore,
  savePlan,
  setProjectRunSettings,
  setRunItemStatus,
  setStep,
  setWorkItemStatus,
  stopMergeQueue,
  workItemDeps,
} = store;
const { resumeAfterMerge, startProjectRun, runPaths } = await import("../src/run-engine");
const { currentSha, git } = await import("../src/git");

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

const open = (): import("../src/store").Db => {
  const db = new DatabaseSync(":memory:") as Db;
  initSchema(db);
  return db;
};
type Db = import("../src/store").Db;

/** The fake agent: executor turns and merge-session drains. */
function fakeAgent(input: {
  db: Db;
  failExecution: Set<string>;
  failMerge: Set<string>;
  /** Items that also edit the shared file. */
  shared: Set<string>;
}) {
  const sessions = new Map<string, { kind: "item" | "merge"; itemID?: string; worktree: string }>();
  let series = 0;

  const commit = (worktree: string, name: string, content: string) => {
    writeFileSync(join(worktree, name), content);
    sh(worktree, "add", ".");
    sh(worktree, "commit", "-m", `work: ${name}`);
  };

  const executorTurn = (itemID: string, worktree: string) => {
    commit(worktree, `item-${itemID}.txt`, `item ${itemID}\n`);
    if (input.shared.has(itemID)) commit(worktree, "shared.txt", `${itemID}\n`);
    if (input.failExecution.has(itemID)) return;
    const plan = getPlanByWorkItem(input.db, itemID);
    if (!plan) return;
    for (const step of plan.steps) {
      setStep(input.db, { id: plan.id, stepID: step.step_id, status: "done" });
    }
  };

  let ctxRef: unknown;
  const drain = async (runID: string) => {
    for (;;) {
      const claimed = claimNextMerge(input.db, runID);
      if (!claimed.ok || !claimed.entry) return;
      const entry = claimed.entry;
      if (input.failMerge.has(entry.work_item_id)) {
        finishMerge(input.db, { id: entry.id, status: "failed", error: "conflito não resolvido" });
        setRunItemStatus(input.db, {
          runID,
          workItemID: entry.work_item_id,
          status: "failed",
          error: "conflito não resolvido",
        });
        stopMergeQueue(input.db, runID, "fila parada após merge falho");
        for (const queued of listMergeQueue(input.db, runID).filter(
          (row) => row.status === "failed" && row.id !== entry.id,
        )) {
          setRunItemStatus(input.db, {
            runID,
            workItemID: queued.work_item_id,
            status: "skipped",
            error: "fila de merge parada",
          });
        }
        resumeAfterMerge(ctxRef as never, input.db, runID);
        return;
      }

      const integration = runPaths(runID).integration;
      const merged = await git(integration, ["merge", "--no-edit", `wi/${entry.work_item_id}`]);
      if (!merged.ok) {
        // The agent resolves the conflict by writing the merged content.
        writeFileSync(join(integration, "shared.txt"), "shared-x\nshared-y\n");
        sh(integration, "add", "shared.txt");
        sh(integration, "commit", "-m", "resolve conflict");
      }
      const sha = await currentSha(integration);
      finishMerge(input.db, { id: entry.id, status: "merged", mergedSha: sha });
      setRunItemStatus(input.db, {
        runID,
        workItemID: entry.work_item_id,
        status: "merged",
        mergedSha: sha,
      });
    }
  };

  const ctx = {
    storage: { get: async () => "en-us" },
    session: {
      async create(options: { location?: { directory?: string } }) {
        const id = `ses_fake_${++series}`;
        const directory = options.location?.directory ?? "";
        const kind = directory.endsWith("/integration") ? "merge" : "item";
        const itemID = kind === "item" ? directory.split("/").at(-1) : undefined;
        sessions.set(id, { kind, ...(itemID ? { itemID } : {}), worktree: directory });
        return { id };
      },
      async prompt(request: { sessionID: string }) {
        const meta = sessions.get(request.sessionID);
        if (!meta) return;
        if (meta.kind === "item" && meta.itemID) {
          executorTurn(meta.itemID, meta.worktree);
          return;
        }
        const runID = meta.worktree.split("/").at(-2) ?? "";
        await drain(runID);
      },
      async wait() {
        return undefined;
      },
      async interrupt() {
        return undefined;
      },
    },
  };

  ctxRef = ctx;
  return { ctx, sessions };
}

function setupRun(db: Db, directory: string) {
  const project = createProject(db, { name: "App", locations: [{ directory }] });
  if (!project.ok) throw new Error(project.error);
  return project.project;
}

const makeItem = (db: Db, projectID: string, title: string, touches: string[]) => {
  const created = createWorkItem(db, { projectID, title });
  if (!created.ok) throw new Error(created.error);
  setWorkItemStatus(db, { id: created.item.id, status: "ready" });
  const saved = savePlan(db, {
    body: `# ${title}\n\n- [ ] one`,
    projectID: "p1",
    projectDirectory: "/work/app",
    sessionID: "s1",
    workItemID: created.item.id,
    touches,
  });
  if (!saved.ok) throw new Error(saved.error);
  return created.item.id;
};

const waitFor = async (check: () => boolean, timeoutMs = 8_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("run engine end to end", () => {
  test("parallel items, an implicit chain and a resolved conflict", async () => {
    const db = open();
    const dir = repo();
    const project = setupRun(db, dir);
    const a = makeItem(db, project.id, "Parallel A", ["src/a/**"]);
    const b = makeItem(db, project.id, "Parallel B", ["docs/b/**"]);
    const c = makeItem(db, project.id, "Chain C", ["lib/**"]);
    const d = makeItem(db, project.id, "Chain D", ["lib/**"]);
    const x = makeItem(db, project.id, "Shared X", ["src/x/**"]);
    const y = makeItem(db, project.id, "Shared Y", ["src/y/**"]);

    // Six items in the first pass: X and Y must start from the same tip to
    // really conflict when their branches merge.
    setProjectRunSettings(db, project.id, { maxParallel: 6 });
    const { ctx } = fakeAgent({ db, failExecution: new Set(), failMerge: new Set(), shared: new Set([x, y]) });
    const base = (await currentSha(dir))!;
    const started = await startProjectRun(ctx as never, db, { projectID: project.id, directory: dir });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const finished = await waitFor(() => {
      const run = getRun(db, started.runID);
      return run !== undefined && run.status !== "running";
    });
    expect(finished).toBe(true);

    const run = getRun(db, started.runID)!;
    expect(run.status).toBe("done");
    const items = listRunItems(db, started.runID);
    expect(items.every((item) => item.status === "merged")).toBe(true);

    // The gate: D only started after C was merged.
    const byItem = new Map(items.map((item) => [item.work_item_id, item]));
    expect(Date.parse(byItem.get(d)!.started_at!)).toBeGreaterThanOrEqual(
      Date.parse(byItem.get(c)!.finished_at!),
    );
    // The overlap produced an implicit edge (C and D, X and Y).
    expect(workItemDeps(db, d).blockedBy.map((dep) => dep.id)).toContain(c);
    // The queue is fully drained.
    expect(listMergeQueue(db, started.runID).every((entry) => entry.status === "merged")).toBe(true);

    // The base never moved; the run branch has everything.
    expect(await currentSha(dir)).toBe(base);
    const runBranchFiles = sh(dir, "ls-tree", "-r", "--name-only", `run/${started.runID}`).split("\n");
    for (const item of [a, b, c, d, x, y]) {
      expect(runBranchFiles).toContain(`item-${item}.txt`);
    }
    expect(sh(dir, "show", `run/${started.runID}:shared.txt`)).toBe("shared-x\nshared-y");

    // Item worktrees are disposable and get cleaned up.
    expect(existsSync(runPaths(started.runID).item(a))).toBe(false);
  }, 20_000);

  test("a failed merge fails the run and skips its dependents, base intact", async () => {
    const db = open();
    const dir = repo();
    const project = setupRun(db, dir);
    const p = makeItem(db, project.id, "Fine", ["src/a/**"]);
    const q = makeItem(db, project.id, "Broken merge", ["src/b/**"]);
    const r = makeItem(db, project.id, "Blocked", ["src/c/**"]);
    addWorkItemDep(db, { itemID: r, blocksID: q });

    const { ctx } = fakeAgent({ db, failExecution: new Set(), failMerge: new Set([q]), shared: new Set() });
    const base = (await currentSha(dir))!;
    const started = await startProjectRun(ctx as never, db, { projectID: project.id, directory: dir });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const finished = await waitFor(() => {
      const run = getRun(db, started.runID);
      return run !== undefined && run.status !== "running";
    });
    expect(finished).toBe(true);

    const run = getRun(db, started.runID)!;
    expect(run.status).toBe("failed");
    const items = new Map(listRunItems(db, started.runID).map((item) => [item.work_item_id, item]));
    expect(items.get(p)?.status).toBe("merged");
    expect(items.get(q)?.status).toBe("failed");
    expect(items.get(r)?.status).toBe("skipped");
    expect(await currentSha(dir)).toBe(base);
  }, 20_000);
});
