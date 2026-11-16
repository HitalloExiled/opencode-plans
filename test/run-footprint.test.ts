import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import {
  addWorkItemDep,
  createInitiative,
  createWorkItem,
  getPlan,
  initSchema,
  recomputeImplicitDeps,
  renderPlanFull,
  savePlan,
  setWorkItemStatus,
  workItemDeps,
  type Db,
} from "../src/store";

const open = (): Db => {
  const db = new DatabaseSync(":memory:") as Db;
  initSchema(db);
  return db;
};

function setup() {
  const db = open();
  const project = createInitiative(db, { name: "App", repos: [{ directory: "/work/app" }] });
  if (!project.ok) throw new Error(project.error);
  const item = (title: string) => {
    const created = createWorkItem(db, { initiativeID: project.initiative.id, title });
    if (!created.ok) throw new Error(created.error);
    setWorkItemStatus(db, { id: created.item.id, status: "ready" });
    return created.item.id;
  };
  const plan = (workItemID: string, touches: string[]) => {
    const saved = savePlan(db, {
      body: `# Plan ${workItemID}\n\n- [ ] one`,
      projectID: "p1",
      projectDirectory: "/work/app",
      sessionID: "s1",
      workItemID,
      touches,
    });
    if (!saved.ok) throw new Error(saved.error);
    return saved.plan;
  };
  return { db, initiativeID: project.initiative.id, item, plan };
}

const implicitDeps = (db: Db, itemID: string) =>
  db
    .prepare("SELECT blocks_id, kind, reason FROM work_item_deps WHERE item_id = ? ORDER BY blocks_id")
    .all(itemID) as { blocks_id: string; kind: string; reason: string | null }[];

describe("plan footprint", () => {
  test("savePlan stores the touches and getPlan returns them", () => {
    const { db, item, plan } = setup();
    const a = item("A");
    plan(a, ["src/**", "src/**", " docs/a.md "]);
    const stored = getPlan(db, (db.prepare("SELECT id FROM plans").get() as { id: string }).id)!;
    expect(stored.touches).toEqual(["docs/a.md", "src/**"]);
    expect(renderPlanFull(stored)).toContain("touches: docs/a.md, src/**");
  });

  test("a plan update without touches keeps them; an empty list clears", () => {
    const { db, item, plan } = setup();
    const a = item("A");
    const saved = plan(a, ["src/**"]);
    const kept = savePlan(db, {
      id: saved.id,
      body: "# Plan\n\n- [ ] two",
      projectID: "p1",
      projectDirectory: "/work/app",
      sessionID: "s1",
    });
    expect(kept.ok).toBe(true);
    expect(getPlan(db, saved.id)?.touches).toEqual(["src/**"]);

    const cleared = savePlan(db, {
      id: saved.id,
      body: "# Plan\n\n- [ ] three",
      projectID: "p1",
      projectDirectory: "/work/app",
      sessionID: "s1",
      touches: [],
    });
    expect(cleared.ok).toBe(true);
    expect(getPlan(db, saved.id)?.touches).toEqual([]);
  });
});

describe("recomputeImplicitDeps", () => {
  test("overlapping footprints get a deterministic implicit edge with the reason", () => {
    const { db, initiativeID, item, plan } = setup();
    const a = item("A");
    const b = item("B");
    plan(a, ["src/**"]);
    plan(b, ["src/a.ts"]);

    const result = recomputeImplicitDeps(db, initiativeID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.added).toBe(1);
    expect(result.edges).toEqual([{ itemID: b, blocksID: a }]);

    const rows = implicitDeps(db, b);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("implicit");
    expect(JSON.parse(rows[0]!.reason!)).toEqual(["src/** ∩ src/a.ts"]);
    expect(workItemDeps(db, b).blockedBy.map((dep) => dep.id)).toEqual([a]);
  });

  test("rerunning replaces the implicit edges instead of duplicating", () => {
    const { db, initiativeID, item, plan } = setup();
    const a = item("A");
    const b = item("B");
    plan(a, ["src/**"]);
    plan(b, ["src/a.ts"]);
    recomputeImplicitDeps(db, initiativeID);
    recomputeImplicitDeps(db, initiativeID);
    expect(implicitDeps(db, b)).toHaveLength(1);
  });

  test("disjoint footprints stay parallel; an explicit order wins over the implicit one", () => {
    const { db, initiativeID, item, plan } = setup();
    const a = item("A");
    const b = item("B");
    const c = item("C");
    plan(a, ["src/**"]);
    plan(b, ["src/a.ts"]);
    plan(c, ["docs/**"]);

    addWorkItemDep(db, { itemID: a, blocksID: b });
    const result = recomputeImplicitDeps(db, initiativeID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A and B are already ordered by the explicit edge; C touches another tree.
    expect(result.added).toBe(0);
    expect(workItemDeps(db, a).blockedBy.map((dep) => dep.id)).toEqual([b]);
  });

  test("items without a plan do not take part", () => {
    const { db, initiativeID, item, plan } = setup();
    const a = item("A");
    item("No plan");
    plan(a, ["src/**"]);
    const result = recomputeImplicitDeps(db, initiativeID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.added).toBe(0);
  });

  test("an unknown footprint serializes against everything", () => {
    const { db, initiativeID, item, plan } = setup();
    const a = item("A");
    const b = item("B");
    plan(a, []);
    plan(b, ["src/a.ts"]);
    const result = recomputeImplicitDeps(db, initiativeID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edges).toEqual([{ itemID: b, blocksID: a }]);
    expect(JSON.parse(implicitDeps(db, b)[0]!.reason!)).toEqual(["*"]);
  });
});
