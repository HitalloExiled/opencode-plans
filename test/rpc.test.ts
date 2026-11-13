/**
 * RPC handler tests — the server-side path the panel uses.
 *
 * A throwaway `$PLANS_DB` and a fake plugin context exercise the real store
 * and handlers, including the synthetic notification to the session.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "plans-rpc-"));
process.env.PLANS_DB = join(dir, "plans.db");

const { createRpcHandlers } = await import("../src/rpc");
const { requireStore, savePlan } = await import("../src/store");
const { bodyWithoutSteps } = await import("../src/plan-body");
const { onPlanChange } = await import("../src/plan-events");
const { saveTool, updateTool, getTool } = await import("../plans");

type SyntheticInput = {
  sessionID: string;
  text: string;
  description?: string;
  resume?: boolean;
  metadata?: Record<string, unknown>;
};

const notifications: SyntheticInput[] = [];
const ctx = {
  location: { project: { id: "p1", canonical: "/tmp/p1" }, directory: "/tmp/p1" },
  session: {
    async synthetic(input: SyntheticInput) {
      notifications.push(input);
      return {};
    },
  },
};

const handlers = createRpcHandlers(ctx as never);

// The RPC type expects a per-call context as the second argument; these tests
// bind the fake context once in `createRpcHandlers`, so erase that parameter.
type Unary<F> = F extends (input: infer I, ...rest: any[]) => infer R ? (input: I) => R : never;
const h = handlers as unknown as { [K in keyof typeof handlers]: Unary<(typeof handlers)[K]> };

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const makePlan = async (body = "# Plan\n\n- [ ] One\n- [ ] Two\n", sessionID = "s1") => {
  const store = await requireStore();
  const saved = savePlan(store.db, {
    body,
    projectID: "p1",
    projectDirectory: "/tmp/p1",
    sessionID,
  });
  if (!saved.ok) throw new Error(saved.error);
  return saved.plan;
};

describe("plans RPC handlers", () => {
  test("list and get return the panel shape for the current project", async () => {
    const plan = await makePlan();
    const list = await h.list({ status: "all", scope: "session", sessionID: "s1" });
    expect(list.some((item) => item.id === plan.id)).toBe(true);
    const found = await h.get(plan.id);
    expect(found?.id).toBe(plan.id);
    expect(found?.steps).toHaveLength(2);
  });

  test("list scopes session and project", async () => {
    const mine = await makePlan(undefined, "s1");
    const other = await makePlan("# Other\n\n- [ ] X\n", "s2");

    const session = await h.list({ status: "all", scope: "session", sessionID: "s1" });
    expect(session.some((item) => item.id === mine.id)).toBe(true);
    expect(session.some((item) => item.id === other.id)).toBe(false);

    const project = await h.list({ status: "all", scope: "project" });
    expect(project.some((item) => item.id === mine.id)).toBe(true);
    expect(project.some((item) => item.id === other.id)).toBe(true);
  });

  test("list scope all ignores project and session, and counts the same set", async () => {
    const here = await makePlan(undefined, "s1");
    const store = await requireStore();
    const elsewhere = savePlan(store.db, {
      body: "# Elsewhere\n\n- [ ] Y\n",
      projectID: "p2",
      projectDirectory: "/tmp/p2",
      sessionID: "s9",
    });
    if (!elsewhere.ok) throw new Error(elsewhere.error);

    const all = await h.list({ status: "all", scope: "all" });
    expect(all.some((item) => item.id === here.id)).toBe(true);
    expect(all.some((item) => item.id === elsewhere.plan.id)).toBe(true);

    const project = await h.list({ status: "all", scope: "project" });
    expect(project.some((item) => item.id === elsewhere.plan.id)).toBe(false);

    const page = await h.list({ status: "all", scope: "all", limit: 1, offset: 1 });
    expect(page).toHaveLength(1);

    const total = await h.count({ status: "all", scope: "all" });
    expect(total).toBe(all.length);
  });

  test("setStep updates progress and notifies the session", async () => {
    const plan = await makePlan();
    notifications.length = 0;

    const result = await h.setStep({
      id: plan.id,
      stepID: "s1",
      status: "done",
      sessionID: "s1",
      locale: "pt-br",
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.plan?.steps.find((step) => step.id === "s1")?.status).toBe("done");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.sessionID).toBe("s1");
    expect(notifications[0]?.text).toContain("concluído");
    expect(notifications[0]?.text).toContain("1/2");
    expect(notifications[0]?.description).toContain("Concluiu");
    expect(notifications[0]?.resume).toBe(false);
  });

  test("setStep doing notifies and is reflected in the plan", async () => {
    const plan = await makePlan();
    notifications.length = 0;

    const result = await h.setStep({
      id: plan.id,
      stepID: "s2",
      status: "doing",
      sessionID: "s1",
      locale: "pt-br",
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.plan?.steps.find((step) => step.id === "s2")?.status).toBe("doing");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.text).toContain("em andamento");
    expect(notifications[0]?.description).toContain("Iniciou");
  });

  test("setStep notifies the plan's own session", async () => {
    const plan = await makePlan(undefined, "s2");
    notifications.length = 0;

    const result = await h.setStep({
      id: plan.id,
      stepID: "s1",
      status: "done",
      sessionID: "s1",
    });

    expect(result.ok).toBe(true);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.sessionID).toBe("s2");
  });

  test("setStep reopens a doing step as todo", async () => {
    const plan = await makePlan();
    await h.setStep({ id: plan.id, stepID: "s1", status: "doing", sessionID: "s1" });
    notifications.length = 0;

    const result = await h.setStep({
      id: plan.id,
      stepID: "s1",
      status: "todo",
      sessionID: "s1",
      locale: "pt-br",
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.plan?.steps.find((step) => step.id === "s1")?.status).toBe("todo");
    expect(notifications[0]?.description).toContain("Reabriu");
  });

  test("update can archive and reopen", async () => {
    const plan = await makePlan();
    notifications.length = 0;

    const archived = await h.update({
      id: plan.id,
      status: "archived",
      sessionID: "s1",
      locale: "pt-br",
    });
    expect(archived.ok).toBe(true);
    expect(archived.ok && archived.plan?.status).toBe("archived");
    expect(notifications[0]?.text).toContain("arquivado");
    expect(notifications[0]?.description).toContain("Arquivou");

    const reopened = await h.update({
      id: plan.id,
      status: "active",
      sessionID: "s1",
      locale: "pt-br",
    });
    expect(reopened.ok).toBe(true);
    expect(reopened.ok && reopened.plan?.status).toBe("active");
  });

  test("remove deletes the plan and notifies", async () => {
    const plan = await makePlan();
    notifications.length = 0;

    const removed = await h.remove({ id: plan.id, sessionID: "s1", locale: "pt-br" });
    expect(removed.ok).toBe(true);
    expect(notifications[0]?.text).toContain("removeu");
    expect(notifications[0]?.description).toContain("Removeu");
    expect(await h.get(plan.id)).toBeNull();
  });

  test("move changes the session and notifies the destination", async () => {
    const plan = await makePlan(undefined, "s1");
    notifications.length = 0;

    const moved = await h.move({ id: plan.id, sessionID: "s2", locale: "pt-br" });
    expect(moved.ok).toBe(true);
    expect(moved.ok && moved.plan?.sessionID).toBe("s2");
    expect(notifications[0]?.sessionID).toBe("s2");
    expect(notifications[0]?.description).toContain("Moveu");

    const session1 = await h.list({ status: "all", scope: "session", sessionID: "s1" });
    expect(session1.some((item) => item.id === plan.id)).toBe(false);

    const session2 = await h.list({ status: "all", scope: "session", sessionID: "s2" });
    expect(session2.some((item) => item.id === plan.id)).toBe(true);
  });

  test("save creates a plan and preserves step status on edit", async () => {
    const created = await h.save({
      title: "Draft",
      body: "# Draft\n\n## Passos\n\n- [ ] A\n- [ ] B\n",
      steps: ["A", "B"],
      sessionID: "s1",
    });
    expect(created.ok).toBe(true);
    if (!created.ok || !created.plan) throw new Error("plan not created");
    const id = created.plan.id;

    const done = await h.setStep({ id, stepID: "s1", status: "done", sessionID: "s1" });
    expect(done.ok).toBe(true);

    const updated = await h.save({
      id,
      title: "Draft v2",
      body: "# Draft v2\n\n## Passos\n\n- [ ] A\n- [ ] B\n- [ ] C\n",
      steps: ["A", "B", "C"],
      sessionID: "s1",
    });
    expect(updated.ok).toBe(true);
    expect(updated.ok && updated.plan?.title).toBe("Draft v2");
    expect(updated.ok && updated.plan?.steps).toHaveLength(3);
    expect(updated.ok && updated.plan?.steps.find((step) => step.id === "s1")?.status).toBe("done");
  });

  test("save rejects a plan from another session", async () => {
    const plan = await makePlan(undefined, "s2");
    const result = await h.save({
      id: plan.id,
      title: "Hijack",
      body: "# Hijack\n\n## Passos\n\n- [ ] A\n",
      steps: ["A"],
      sessionID: "s1",
    });
    expect(result.ok).toBe(false);
  });

  test("save preserves arbitrary body sections and hides the step section from the detail", async () => {
    const body = [
      "# Sections",
      "",
      "## Objetivo",
      "Manter o corpo editável.",
      "",
      "## Critérios",
      "- funciona",
      "",
      "## Limitações",
      "- nenhuma",
      "",
      "## Passos",
      "",
      "- [ ] A",
      "- [ ] B",
      "",
    ].join("\n");
    const created = await h.save({
      title: "Sections",
      body,
      steps: ["A", "B"],
      sessionID: "s1",
    });
    expect(created.ok).toBe(true);
    if (!created.ok || !created.plan) throw new Error("plan not created");
    const id = created.plan.id;

    const found = await h.get(id);
    expect(found).not.toBeNull();
    const without = bodyWithoutSteps(found!.body);
    expect(without).toContain("## Critérios");
    expect(without).toContain("## Limitações");
    expect(without).not.toContain("## Passos");
    expect(without).not.toContain("- [ ] A");

    const edited = body.replace("## Limitações", "## Riscos\n- baixo\n\n## Limitações");
    const updated = await h.save({
      id,
      title: "Sections v2",
      body: edited,
      steps: ["A", "B"],
      sessionID: "s1",
    });
    expect(updated.ok).toBe(true);
    const after = await h.get(id);
    expect(after).not.toBeNull();
    expect(bodyWithoutSteps(after!.body)).toContain("## Riscos");
  });

  test("notifications fall back to en-us when the locale is missing or unknown", async () => {
    const plan = await makePlan();
    notifications.length = 0;

    await h.setStep({ id: plan.id, stepID: "s1", status: "done", sessionID: "s1" });
    expect(notifications[0]?.text).toContain("done");
    expect(notifications[0]?.description).toContain("Completed");

    notifications.length = 0;
    await h.setStep({
      id: plan.id,
      stepID: "s2",
      status: "todo",
      sessionID: "s1",
      locale: "fr-fr",
    });
    expect(notifications[0]?.text).toContain("pending");
    expect(notifications[0]?.description).toContain("Reopened");
  });
});

describe("plans.update tool guards", () => {
  const toolCtx = { sessionID: "s1", messageID: "m1" } as never;
  const run = (input: Record<string, unknown>) =>
    updateTool(ctx as never).execute(input as never, toolCtx);

  test("marks a step by stepID and plans.get exposes its id", async () => {
    const plan = await makePlan();
    const result = await run({ id: plan.id, stepID: "s1", stepStatus: "doing" });
    expect(result.content).not.toContain("❌");
    expect(result.content).toContain("Plano atualizado");

    const detail = await getTool(ctx as never).execute({ id: plan.id } as never, toolCtx);
    expect(detail.content).toContain("- [~] (s1) One");
    expect(detail.content).toContain("- [ ] (s2) Two");
  });

  test("rejects body combined with a step status", async () => {
    const plan = await makePlan();
    const result = await run({
      id: plan.id,
      body: "# Plan\n\n- [x] One\n- [ ] Two\n",
      stepStatus: "done",
    });
    expect(result.content).toContain("❌");
    expect(result.content).toContain("não combine body");
  });

  test("rejects a body that only toggles checkboxes", async () => {
    const plan = await makePlan();
    const result = await run({
      id: plan.id,
      body: "# Plan\n\n- [x] One\n- [ ] Two\n",
    });
    expect(result.content).toContain("❌");
    expect(result.content).toContain("só troca os checkboxes");
  });

  test("allows a body that changes the step text", async () => {
    const plan = await makePlan();
    const result = await run({
      id: plan.id,
      body: "# Plan\n\n- [x] Uno\n- [ ] Two\n",
    });
    expect(result.content).not.toContain("❌");
  });
});

describe("plan change events", () => {
  type Change = { sessionID: string; planID?: string | undefined };

  const collect = () => {
    const changes: Change[] = [];
    const off = onPlanChange((change) => changes.push(change));
    return { changes, off };
  };

  test("save, setStep, move and remove publish the affected sessions", async () => {
    const { changes, off } = collect();
    try {
      const created = await h.save({
        title: "Events",
        body: "# Events\n\n## Passos\n\n- [ ] A\n- [ ] B\n",
        steps: ["A", "B"],
        sessionID: "s1",
      });
      if (!created.ok || !created.plan) throw new Error("plan not created");
      const id = created.plan.id;
      expect(changes).toEqual([{ sessionID: "s1", planID: id }]);

      changes.length = 0;
      await h.setStep({ id, stepID: "s1", status: "done", sessionID: "s1" });
      expect(changes).toEqual([{ sessionID: "s1", planID: id }]);

      changes.length = 0;
      await h.move({ id, sessionID: "s2" });
      expect(changes).toEqual([
        { sessionID: "s1", planID: id },
        { sessionID: "s2", planID: id },
      ]);

      changes.length = 0;
      await h.remove({ id, sessionID: "s2" });
      expect(changes).toEqual([{ sessionID: "s2", planID: id }]);
    } finally {
      off();
    }
  });

  test("plans.save from the agent publishes the tool's session", async () => {
    const { changes, off } = collect();
    try {
      const result = await saveTool(ctx as never).execute(
        {
          title: "From the agent",
          body: "# From the agent\n\n## Passos\n\n- [ ] A\n",
          steps: ["A"],
        } as never,
        { sessionID: "s3", messageID: "m1" } as never,
      );
      expect(result.content).toContain("Plano salvo");
      expect(changes).toHaveLength(1);
      expect(changes[0]?.sessionID).toBe("s3");
      expect(changes[0]?.planID).toBeTruthy();
    } finally {
      off();
    }
  });

  test("a failed write publishes nothing", async () => {
    const { changes, off } = collect();
    try {
      const missing = await h.update({ id: "nope", status: "archived" });
      expect(missing.ok).toBe(false);
      expect(changes).toEqual([]);
    } finally {
      off();
    }
  });
});
