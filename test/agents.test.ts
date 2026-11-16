import { describe, expect, test } from "bun:test";
import { AGENTS, EXECUTOR_AGENT, PLANNER_AGENT, registerAgents } from "../src/agents";

describe("planner agent", () => {
  test("is read-only and shares the common save contract", () => {
    expect(PLANNER_AGENT.id).toBe("planner");
    expect(PLANNER_AGENT.system).toContain("call plans.save in the same turn");
    expect(PLANNER_AGENT.system).toContain("Never wait for the user to ask");
    expect(PLANNER_AGENT.system).toContain("Every requirement the user states belongs");
    expect(PLANNER_AGENT.system).toContain("Save at most one plan per request");
    expect(PLANNER_AGENT.system).toContain("Only save when you are presenting a plan");
    expect(PLANNER_AGENT.permissions).toContainEqual({
      action: "edit",
      resource: "*",
      effect: "deny",
    });
    expect(PLANNER_AGENT.permissions).toContainEqual({
      action: "question",
      resource: "*",
      effect: "allow",
    });
    // Mirrors the native Plan agent: shell stays available (read-only by
    // instruction), so no shell permission rule is added.
    expect(PLANNER_AGENT.permissions.some((rule) => rule.action === "shell")).toBe(false);
  });
});

describe("executor agent", () => {
  test("shares the planner system byte for byte", () => {
    expect(EXECUTOR_AGENT.id).toBe("executor");
    // The cached prefix is validated up to the first differing byte: a shared
    // system keeps planner <-> executor switches from re-prefilling the head.
    expect(EXECUTOR_AGENT.system).toBe(PLANNER_AGENT.system);
    expect(EXECUTOR_AGENT.system).toContain("never rewrite the body to change status");
  });
});

describe("registerAgents", () => {
  const editor = () => {
    const created = new Map<string, any>();
    const api = {
      get: (id: string) => created.get(id),
      update: (id: string, fn: (item: any) => void) => {
        const item = created.get(id) ?? { permissions: [] as unknown[] };
        fn(item);
        created.set(id, item);
      },
    };
    return { created, api };
  };

  test("upserts both agents as primary", async () => {
    const { created, api } = editor();
    await registerAgents({ agent: { transform: (fn: (e: unknown) => void) => fn(api) } } as never);
    expect([...created.keys()]).toEqual(AGENTS.map((agent) => agent.id));
    expect(created.get("planner").mode).toBe("primary");
    expect(created.get("planner").name).toBe("Planner");
    expect(created.get("planner").permissions).toEqual(PLANNER_AGENT.permissions);
    expect(created.get("executor").name).toBe("Executor");
  });

  test("a reload does not duplicate permissions", async () => {
    const { created, api } = editor();
    const ctx = { agent: { transform: (fn: (e: unknown) => void) => fn(api) } } as never;
    await registerAgents(ctx);
    await registerAgents(ctx);
    expect(created.get("planner").permissions).toHaveLength(2);
    expect(created.get("executor").permissions).toHaveLength(1);
  });
});
