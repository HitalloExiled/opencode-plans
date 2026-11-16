import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { DatabaseSync } = (await import("node:sqlite")) as any;

const roots: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "plans-preflight-"));
  roots.push(dir);
  return dir;
};
// runPaths() reads the database location; point it at a throwaway file.
process.env.PLANS_DB = join(temp(), "plans.db");

const store = await import("../src/store");
const {
  claimNextMerge,
  createProject,
  createRun,
  createRunItem,
  createWorkItem,
  enqueueMerge,
  initSchema,
  savePlan,
  setRunItemStatus,
  setWorkItemStatus,
} = store;
type Db = import("../src/store").Db;
const { preflightRun, recoverRuns, runPaths, integrationBranch, itemBranch } = await import("../src/run-engine");
const { getRun, getRunItem, listMergeQueue } = store;

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

function project(db: Db, directory: string, extra: string[] = []) {
  const created = createProject(db, {
    name: "App",
    locations: [{ directory }, ...extra.map((entry) => ({ directory: entry }))],
  });
  if (!created.ok) throw new Error(created.error);
  return created.project;
}

function item(db: Db, projectID: string, title: string, options: { locationID?: string; ready?: boolean } = {}) {
  const created = createWorkItem(db, { projectID, title, locationID: options.locationID });
  if (!created.ok) throw new Error(created.error);
  if (options.ready !== false) setWorkItemStatus(db, { id: created.item.id, status: "ready" });
  return created.item.id;
}

function plan(db: Db, workItemID: string, status: "active" | "done" = "active") {
  const saved = savePlan(db, {
    body: status === "done" ? "# Plan\n\n- [x] one" : "# Plan\n\n- [ ] one",
    projectID: "p1",
    projectDirectory: "/work/app",
    sessionID: "s1",
    workItemID,
    touches: ["src/**"],
  });
  if (!saved.ok) throw new Error(saved.error);
  return saved.plan;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("preflightRun", () => {
  test("selects ready items with an active plan on the base branch", async () => {
    const db = open();
    const dir = repo();
    const app = project(db, dir);
    const id = item(db, app.id, "Build it");
    plan(db, id);

    const result = await preflightRun(db, app.id, dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repo).toBe(dir);
    expect(result.value.baseRef).toBe("main");
    expect(result.value.maxParallel).toBe(2);
    expect(result.value.items.map((entry) => entry.item.id)).toEqual([id]);
  });

  test("ready items without a plan are not part of the run", async () => {
    const db = open();
    const dir = repo();
    const app = project(db, dir);
    const planned = item(db, app.id, "Planned");
    item(db, app.id, "Unplanned");
    plan(db, planned);

    const result = await preflightRun(db, app.id, dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((entry) => entry.item.id)).toEqual([planned]);
  });

  test("no planned item blocks the run", async () => {
    const db = open();
    const dir = repo();
    const app = project(db, dir);
    item(db, app.id, "Unplanned");

    const result = await preflightRun(db, app.id, dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.join(" ")).toContain("nenhum item ready com plano ativo");
  });

  test("a done plan does not run", async () => {
    const db = open();
    const dir = repo();
    const app = project(db, dir);
    const id = item(db, app.id, "Done plan");
    plan(db, id, "done");
    const result = await preflightRun(db, app.id, dir);
    expect(result.ok).toBe(false);
  });

  test("an item in another workspace blocks the run", async () => {
    const db = open();
    const dir = repo();
    const other = repo();
    const app = project(db, dir, [other]);
    const elsewhere = app.locations.find((entry) => entry.directory === other);
    if (!elsewhere) throw new Error("second workspace missing");
    const id = item(db, app.id, "Elsewhere", { locationID: elsewhere.id });
    plan(db, id);

    const result = await preflightRun(db, app.id, dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.join(" ")).toContain("outro workspace");
  });

  test("an active run blocks a new one", async () => {
    const db = open();
    const dir = repo();
    const app = project(db, dir);
    const id = item(db, app.id, "Build it");
    plan(db, id);
    createRun(db, { projectID: app.id, baseRef: "main" });

    const result = await preflightRun(db, app.id, dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.join(" ")).toContain("run ativo");
  });

  test("a directory without git blocks the run", async () => {
    const db = open();
    const dir = temp();
    const app = project(db, dir);
    const id = item(db, app.id, "Build it");
    plan(db, id);
    const result = await preflightRun(db, app.id, dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.join(" ")).toContain("repositório git");
  });
});

describe("run paths", () => {
  test("worktrees live next to the database and branches are named by id", () => {
    expect(runPaths("run-1").integration).toContain(join("worktrees", "run-1", "integration"));
    expect(integrationBranch("run-1")).toBe("run/run-1");
    expect(itemBranch("item-1")).toBe("wi/item-1");
  });
});

describe("recoverRuns", () => {
  test("marks running runs interrupted and returns in-flight work to the queue", () => {
    const db = open();
    const dir = repo();
    const app = project(db, dir);
    const run = createRun(db, { projectID: app.id, baseRef: "main" });
    if (!run.ok) throw new Error(run.error);
    const row = createRunItem(db, { runID: run.run.id, workItemID: "item-1" });
    if (!row.ok) throw new Error(row.error);
    setRunItemStatus(db, { runID: run.run.id, workItemID: "item-1", status: "running", sessionID: "ses_1" });
    enqueueMerge(db, { runID: run.run.id, workItemID: "item-2" });
    claimNextMerge(db, run.run.id);

    expect(recoverRuns(db)).toBe(1);
    expect(getRun(db, run.run.id)?.status).toBe("interrupted");
    expect(getRunItem(db, run.run.id, "item-1")?.status).toBe("queued");
    expect(listMergeQueue(db, run.run.id)[0]?.status).toBe("queued");
  });
});
