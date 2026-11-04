/**
 * GUI main tests — the IPC provider's write methods must notify the session
 * when the user changes a plan from the panel.
 *
 * Uses a throwaway `$PLANS_DB` and a fake MainContext, so it exercises the
 * real store + real provider wiring without Electron.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "plans-gui-"));
process.env.PLANS_DB = join(dir, "plans.db");

const { main } = await import("../src/gui/main");
const { requireStore, savePlan } = await import("../src/store");

type SyntheticInput = {
  sessionID: string;
  text: string;
  description?: string;
  resume?: boolean;
  metadata?: Record<string, unknown>;
};

const notifications: SyntheticInput[] = [];
let impl: {
  setStep(input: { id: string; stepID: string; done: boolean; sessionID?: string }): Promise<{ ok: boolean }>;
  update(input: { id: string; status?: string; sessionID?: string }): Promise<{ ok: boolean }>;
  remove(input: { id: string; sessionID?: string }): Promise<{ ok: boolean }>;
};

const ctx = {
  provide(_token: unknown, implementation: typeof impl) {
    impl = implementation;
    return { emit() {}, dispose() {} };
  },
  client: {
    session: {
      async synthetic(input: SyntheticInput) {
        notifications.push(input);
        return {};
      },
    },
  },
  log: { write() {} },
};

main(ctx as never);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("plans GUI main notifications", () => {
  test("setStep notifies the session without resuming the agent", async () => {
    const store = await requireStore();
    const saved = savePlan(store.db, {
      body: "# Plan\n\n- [ ] One\n- [ ] Two\n",
      projectID: "p1",
      projectDirectory: "/tmp/p1",
      sessionID: "s1",
    });
    if (!saved.ok) throw new Error(saved.error);

    const result = await impl.setStep({
      id: saved.plan.id,
      stepID: "s1",
      done: true,
      sessionID: "s1",
    });
    expect(result.ok).toBe(true);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.sessionID).toBe("s1");
    expect(notifications[0]?.text).toContain("concluído");
    expect(notifications[0]?.text).toContain("1/2");
    expect(notifications[0]?.description).toBe("Painel Planos");
    expect(notifications[0]?.resume).toBe(false);
    expect(notifications[0]?.metadata?.source).toBe("plans");
  });

  test("update notifies the status change", async () => {
    const store = await requireStore();
    const plan = savePlan(store.db, {
      body: "# Plan\n\n- [ ] One\n",
      projectID: "p1",
      projectDirectory: "/tmp/p1",
      sessionID: "s1",
    });
    if (!plan.ok) throw new Error(plan.error);

    notifications.length = 0;
    const result = await impl.update({
      id: plan.plan.id,
      status: "archived",
      sessionID: "s1",
    });
    expect(result.ok).toBe(true);
    expect(notifications[0]?.text).toContain("arquivado");
  });

  test("remove notifies the deletion", async () => {
    const store = await requireStore();
    const plan = savePlan(store.db, {
      body: "# Plan\n\n- [ ] One\n",
      projectID: "p1",
      projectDirectory: "/tmp/p1",
      sessionID: "s1",
    });
    if (!plan.ok) throw new Error(plan.error);

    notifications.length = 0;
    const result = await impl.remove({ id: plan.plan.id, sessionID: "s1" });
    expect(result.ok).toBe(true);
    expect(notifications[0]?.text).toContain("removeu");
  });
});
