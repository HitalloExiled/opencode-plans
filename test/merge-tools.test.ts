import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "plans-merge-"));
  roots.push(dir);
  return dir;
};
process.env.PLANS_DB = join(temp(), "plans.db");

const store = await import("../src/store");
const {
  claimNextMerge,
  createProject,
  createRun,
  createRunItem,
  createWorkItem,
  enqueueMerge,
  getMergeEntry,
  getRunItem,
  requireStore,
  setRunItemStatus,
  setRunMergeSession,
} = store;
const { addWorktree, currentSha } = await import("../src/git");
const { runPaths } = await import("../src/run-paths");
const { mergeDoneTool, mergeFailTool, mergeListTool, mergeNextTool } = await import("../merge");

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

/** One run with a repository, the integration worktree and N work items. */
async function setup(itemTitles: string[]) {
  const store = await requireStore();
  const db = store.db;
  const dir = repo();
  const project = createProject(db, { name: "App", locations: [{ directory: dir }] });
  if (!project.ok) throw new Error(project.error);
  const run = createRun(db, { projectID: project.project.id, baseRef: "main" });
  if (!run.ok) throw new Error(run.error);
  const paths = runPaths(run.run.id);
  const integration = await addWorktree({
    repo: dir,
    worktree: paths.integration,
    branch: `run/${run.run.id}`,
    startRef: "main",
  });
  if (!integration.ok) throw new Error(integration.error);
  const sessionID = `ses_merge_${crypto.randomUUID()}`;
  setRunMergeSession(db, run.run.id, sessionID);

  const items = itemTitles.map((title) => {
    const created = createWorkItem(db, { projectID: project.project.id, title });
    if (!created.ok) throw new Error(created.error);
    createRunItem(db, { runID: run.run.id, workItemID: created.item.id });
    setRunItemStatus(db, { runID: run.run.id, workItemID: created.item.id, status: "merging" });
    enqueueMerge(db, { runID: run.run.id, workItemID: created.item.id });
    return created.item.id;
  });

  return { db, dir, runID: run.run.id, items, paths, sessionID };
}

/** Commits a file on `wi/<item>` and, optionally, merges it into the run. */
async function branch(input: { dir: string; paths: ReturnType<typeof runPaths>; itemID: string; merge: boolean }) {
  const worktree = input.paths.item(input.itemID);
  const added = await addWorktree({
    repo: input.dir,
    worktree,
    branch: `wi/${input.itemID}`,
    startRef: `run/${input.paths.integration.split("/").at(-2)}`,
  });
  if (!added.ok) throw new Error(added.error);
  writeFileSync(join(worktree, `${input.itemID}.txt`), "work\n");
  sh(worktree, "add", ".");
  sh(worktree, "commit", "-m", `item ${input.itemID}`);
  if (input.merge) {
    sh(input.paths.integration, "merge", "--no-edit", `wi/${input.itemID}`);
  }
}

const toolCtx = (sessionID = "ses_merge") => ({ sessionID }) as never;
const fakeCtx = {} as never;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("merge tools", () => {
  test("only the run's merge session may use them", async () => {
    const result = (await mergeListTool(fakeCtx).execute({}, toolCtx("other"))) as { content: string };
    expect(result.content).toContain("não é a sessão de merge");
  });

  test("done requires the branch to be contained in the integration HEAD", async () => {
    const { dir, runID, items, paths, db, sessionID } = await setup(["Not merged"]);
    await branch({ dir, paths, itemID: items[0]!, merge: false });
    const claimed = claimNextMerge(db, runID);
    if (!claimed.ok || !claimed.entry) throw new Error("claim failed");

    const result = (await mergeDoneTool(fakeCtx).execute(
      { entryID: claimed.entry.id },
      toolCtx(sessionID),
    )) as { content: string };
    expect(result.content).toContain("não está contida");
    expect(getRunItem(db, runID, items[0]!)?.status).toBe("merging");
  });

  test("done marks the item merged with the integration sha", async () => {
    const { dir, runID, items, paths, db, sessionID } = await setup(["Merged"]);
    await branch({ dir, paths, itemID: items[0]!, merge: true });
    const claimed = claimNextMerge(db, runID);
    if (!claimed.ok || !claimed.entry) throw new Error("claim failed");

    const result = (await mergeDoneTool(fakeCtx).execute(
      { entryID: claimed.entry.id },
      toolCtx(sessionID),
    )) as { content: string };
    expect(result.content).toContain("Merge concluído");

    const sha = await currentSha(paths.integration);
    expect(getRunItem(db, runID, items[0]!)?.status).toBe("merged");
    expect(getRunItem(db, runID, items[0]!)?.merged_sha).toBe(sha);
    expect(getMergeEntry(db, claimed.entry.id)?.status).toBe("merged");
    expect((await mergeListTool(fakeCtx).execute({}, toolCtx(sessionID)) as { content: string }).content).toContain(
      "[merged]",
    );
  });

  test("next claims FIFO and reports an empty queue", async () => {
    const { runID, items, db, sessionID } = await setup(["A", "B"]);
    const first = (await mergeNextTool(fakeCtx).execute({}, toolCtx(sessionID))) as {
      content: string;
      metadata?: { entry?: string | null };
    };
    expect(first.content).toContain(items[0]!);
    expect(first.metadata?.entry).toBeTruthy();

    const busy = (await mergeNextTool(fakeCtx).execute({}, toolCtx(sessionID))) as { content: string };
    expect(busy.content).toContain("Nenhum item na fila");
    expect(getRunItem(db, runID, items[0]!)?.status).toBe("merging");
  });

  test("a failed merge stops the queue and skips the queued items", async () => {
    const { runID, items, db, sessionID } = await setup(["Broken", "Later"]);
    const claimed = claimNextMerge(db, runID);
    if (!claimed.ok || !claimed.entry) throw new Error("claim failed");

    const result = (await mergeFailTool(fakeCtx).execute(
      { entryID: claimed.entry.id, error: "conflito no a.ts" },
      toolCtx(sessionID),
    )) as { content: string };
    expect(result.content).toContain("A fila parou");

    expect(getMergeEntry(db, claimed.entry.id)?.status).toBe("failed");
    expect(getRunItem(db, runID, items[0]!)?.status).toBe("failed");
    expect(getRunItem(db, runID, items[1]!)?.status).toBe("skipped");
    const stopped = (await mergeNextTool(fakeCtx).execute({}, toolCtx(sessionID))) as { content: string };
    expect(stopped.content).toContain("fila parou");
  });
});
