import { describe, expect, test } from "bun:test";
import {
  agentSpecs,
  AGENTS,
  EXECUTOR_AGENT,
  PLANNER_AGENT,
  registerAgents,
  type AgentPermission,
} from "../src/agents";

// The runtime's own definitions, read from `GET /api/agent` and the core
// plugins (`packages/core/src/plugin/plan.ts`, `plugin/agent.ts`), minus
// Plan's `~/.opencode/plan/*` exception: this plugin has no markdown to allow.
const PLAN_RULES: readonly AgentPermission[] = [
  { action: "question", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "deny" },
];
const BUILD_RULES: readonly AgentPermission[] = [{ action: "question", resource: "*", effect: "allow" }];

describe("planner agent", () => {
  test("clones Plan: same description, no system, every edit denied", () => {
    expect(PLANNER_AGENT.id).toBe("planner");
    expect(PLANNER_AGENT.name).toBe("Planner");
    expect(PLANNER_AGENT.description).toBe(
      "Read-only agent for exploring the codebase and planning work before implementation.",
    );
    expect(PLANNER_AGENT.permissions).toEqual(PLAN_RULES);
    // Plan carries no system prompt; its behavior is the permission set plus
    // the reminder the core injects per request.
    expect("system" in PLANNER_AGENT).toBe(false);
    // Mirrors Plan: shell stays available (read-only by instruction).
    expect(PLANNER_AGENT.permissions.some((rule) => rule.action === "shell")).toBe(false);
  });
});

describe("executor agent", () => {
  test("clones Build: same description, no system, editing open", () => {
    expect(EXECUTOR_AGENT.id).toBe("executor");
    expect(EXECUTOR_AGENT.name).toBe("Executor");
    expect(EXECUTOR_AGENT.description).toBe(
      "The default agent. Executes tools based on configured permissions.",
    );
    expect(EXECUTOR_AGENT.permissions).toEqual(BUILD_RULES);
    expect("system" in EXECUTOR_AGENT).toBe(false);
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

  test("upserts both agents as primary, with the plans-flow role baked into system", async () => {
    const { created, api } = editor();
    await registerAgents({ agent: { transform: (fn: (e: unknown) => void) => fn(api) } } as never, "native");
    expect([...created.keys()]).toEqual(AGENTS.map((agent) => agent.id));
    expect(created.get("planner").mode).toBe("primary");
    expect(created.get("planner").name).toBe("Planner");
    expect(created.get("planner").permissions).toEqual(PLAN_RULES);
    expect(created.get("planner").system).toContain("<plans-flow>");
    expect(created.get("planner").system).toContain("Role: planner.");
    expect(created.get("executor").name).toBe("Executor");
    expect(created.get("executor").permissions).toEqual(BUILD_RULES);
    expect(created.get("executor").system).toContain("Role: executor.");
  });

  test("names the peer agent per flow, without re-computing per request", () => {
    expect(agentSpecs("native").find((a) => a.id === "planner")!.system).toContain(
      "switch to the Build agent",
    );
    expect(agentSpecs("dedicated").find((a) => a.id === "planner")!.system).toContain(
      "switch to the Executor agent",
    );
  });

  test("a reload neither duplicates nor downgrades permissions", async () => {
    const { created, api } = editor();
    const ctx = { agent: { transform: (fn: (e: unknown) => void) => fn(api) } } as never;
    await registerAgents(ctx, "native");
    // A previous plugin version may have left an extra rule behind.
    created.get("planner").permissions.push({ action: "edit", resource: "*", effect: "allow" });
    await registerAgents(ctx, "native");
    expect(created.get("planner").permissions).toHaveLength(2);
    expect(created.get("planner").permissions).toContainEqual({
      action: "edit",
      resource: "*",
      effect: "deny",
    });
    expect(created.get("executor").permissions).toHaveLength(1);
  });
});
