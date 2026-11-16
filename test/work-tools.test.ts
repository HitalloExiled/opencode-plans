/**
 * work.save / work.update handlers over a throwaway database: dedupe, the
 * per-request budget, origin and the closing rule.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "plans-work-tools-"));
process.env.PLANS_DB = join(dir, "plans.db");

const { saveWorkTool, updateWorkTool } = await import("../work");
const { getWorkItem, requireStore, workItemDeps } = await import("../src/store");

const ctx = { location: { project: { id: "opencode-1", canonical: dir }, directory: dir } };
const toolCtx = (messageID: string, agent = "planner") =>
  ({ sessionID: "ses_1", messageID, agent }) as never;

const save = saveWorkTool(ctx as never).execute;
const update = updateWorkTool(ctx as never).execute;

type Saved = { created: number; existing: number; itemIDs: string[] };

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("work.save", () => {
  test("creates agent-owned items and dedupes by title", async () => {
    const first = (await save({ items: [{ title: "Fix the build" }] }, toolCtx("m1"))) as {
      content: string;
      metadata?: Saved;
    };
    expect(first.metadata?.created).toBe(1);
    const id = first.metadata!.itemIDs[0]!;

    const store = await requireStore();
    expect(getWorkItem(store.db, id)?.origin).toBe("agent");

    const second = (await save({ items: [{ title: "  fix  THE build " }] }, toolCtx("m1"))) as {
      content: string;
      metadata?: Saved;
    };
    expect(second.metadata?.created).toBe(0);
    expect(second.metadata?.existing).toBe(1);
    expect(second.metadata?.itemIDs).toEqual([id]);
  });

  test("caps a request at three items across calls", async () => {
    const batch = (await save(
      { items: [{ title: "A" }, { title: "B" }, { title: "C" }] },
      toolCtx("m2"),
    )) as { metadata?: Saved };
    expect(batch.metadata?.created).toBe(3);

    const extra = (await save({ items: [{ title: "D" }] }, toolCtx("m2"))) as {
      content: string;
      metadata?: Record<string, unknown>;
    };
    expect(extra.content.startsWith("❌")).toBe(true);
    expect(extra.metadata?.rejected).toBe(true);
  });

  test("a closed item does not absorb the same title", async () => {
    const created = (await save({ items: [{ title: "Old need" }] }, toolCtx("m3"))) as {
      metadata?: Saved;
    };
    const id = created.metadata!.itemIDs[0]!;
    await update({ id, status: "dropped" }, toolCtx("m3", "planner"));

    const again = (await save({ items: [{ title: "Old need" }] }, toolCtx("m4"))) as {
      metadata?: Saved;
    };
    expect(again.metadata?.created).toBe(1);
    expect(again.metadata?.itemIDs[0]).not.toBe(id);
  });
});

describe("work.update", () => {
  test("the executor cannot close an item", async () => {
    const created = (await save({ items: [{ title: "Close me" }] }, toolCtx("m5"))) as {
      metadata?: Saved;
    };
    const id = created.metadata!.itemIDs[0]!;
    const result = (await update({ id, status: "done" }, toolCtx("m5", "executor"))) as {
      content: string;
    };
    expect(result.content).toContain("done/dropped só por decisão do planner");
  });

  test("replaces dependencies and rejects a cycle", async () => {
    const created = (await save(
      { items: [{ title: "Dep A" }, { title: "Dep B" }] },
      toolCtx("m6"),
    )) as { metadata?: Saved };
    const [a, b] = created.metadata!.itemIDs as [string, string];

    const linked = (await update({ id: a, blockedBy: [b] }, toolCtx("m6"))) as { content: string };
    expect(linked.content).toContain("atualizado");

    const store = await requireStore();
    expect(workItemDeps(store.db, a).blockedBy.map((dep) => dep.id)).toEqual([b]);

    const cycle = (await update({ id: b, blockedBy: [a] }, toolCtx("m6"))) as { content: string };
    expect(cycle.content.startsWith("❌")).toBe(true);

    const cleared = (await update({ id: a, blockedBy: [] }, toolCtx("m6"))) as { content: string };
    expect(cleared.content).not.toContain("❌");
    expect(workItemDeps(store.db, a).blockedBy).toEqual([]);
  });
});
