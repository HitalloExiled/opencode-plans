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
    const list = await handlers.list({ status: "all", scope: "session", sessionID: "s1" });
    expect(list.some((item) => item.id === plan.id)).toBe(true);
    const found = await handlers.get(plan.id);
    expect(found?.id).toBe(plan.id);
    expect(found?.steps).toHaveLength(2);
  });

  test("list scopes session and project", async () => {
    const mine = await makePlan(undefined, "s1");
    const other = await makePlan("# Other\n\n- [ ] X\n", "s2");

    const session = await handlers.list({ status: "all", scope: "session", sessionID: "s1" });
    expect(session.some((item) => item.id === mine.id)).toBe(true);
    expect(session.some((item) => item.id === other.id)).toBe(false);

    const project = await handlers.list({ status: "all", scope: "project" });
    expect(project.some((item) => item.id === mine.id)).toBe(true);
    expect(project.some((item) => item.id === other.id)).toBe(true);
  });

  test("setStep updates progress and notifies the session", async () => {
    const plan = await makePlan();
    notifications.length = 0;

    const result = await handlers.setStep({
      id: plan.id,
      stepID: "s1",
      done: true,
      sessionID: "s1",
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

  test("update can archive and reopen", async () => {
    const plan = await makePlan();
    notifications.length = 0;

    const archived = await handlers.update({ id: plan.id, status: "archived", sessionID: "s1" });
    expect(archived.ok).toBe(true);
    expect(archived.ok && archived.plan?.status).toBe("archived");
    expect(notifications[0]?.text).toContain("arquivado");
    expect(notifications[0]?.description).toContain("Arquivou");

    const reopened = await handlers.update({ id: plan.id, status: "active", sessionID: "s1" });
    expect(reopened.ok).toBe(true);
    expect(reopened.ok && reopened.plan?.status).toBe("active");
  });

  test("remove deletes the plan and notifies", async () => {
    const plan = await makePlan();
    notifications.length = 0;

    const removed = await handlers.remove({ id: plan.id, sessionID: "s1" });
    expect(removed.ok).toBe(true);
    expect(notifications[0]?.text).toContain("removeu");
    expect(notifications[0]?.description).toContain("Removeu");
    expect(await handlers.get(plan.id)).toBeNull();
  });

  test("move changes the session and notifies the destination", async () => {
    const plan = await makePlan(undefined, "s1");
    notifications.length = 0;

    const moved = await handlers.move({ id: plan.id, sessionID: "s2" });
    expect(moved.ok).toBe(true);
    expect(moved.ok && moved.plan?.sessionID).toBe("s2");
    expect(notifications[0]?.sessionID).toBe("s2");
    expect(notifications[0]?.description).toContain("Moveu");

    const session1 = await handlers.list({ status: "all", scope: "session", sessionID: "s1" });
    expect(session1.some((item) => item.id === plan.id)).toBe(false);

    const session2 = await handlers.list({ status: "all", scope: "session", sessionID: "s2" });
    expect(session2.some((item) => item.id === plan.id)).toBe(true);
  });
});
