/**
 * The plugin's own agents: Plan and Build, replicated by behavior.
 *
 * What makes Plan read-only is its permission set plus the reminder the core
 * injects on every request; Build is the same definition with editing
 * allowed. The permission set mirrors Plan/Build byte for byte.
 *
 * The `<plans-flow>` role (`plansFlowBlock` in `inject.ts`) is NOT replayed
 * per request: it is constant per agent (only the peer agent's name varies
 * with the flow, and the flow only changes on a rare toggle, not per turn),
 * so paying its ~500-600 bytes again on every single request is pure waste —
 * it never contributes to cache busting (it lives in the tail either way),
 * only to token cost. It is baked into `item.system` instead, which breaks
 * the previous byte-for-byte parity with native Plan/Build (a deliberate
 * trade; see notes/decision from 2026-11-18). The dynamic reminder
 * (`plan-reminder.ts`, reacts to Plan-mode enter/leave) still has to be
 * spliced per request — there is no per-agent constant for it.
 *
 * One deliberate deviation: the planner drops Plan's `~/.opencode/plan/*`
 * exception. This plugin's plan record lives in `plans.db`, so there is no
 * markdown to allow and every edit stays denied.
 *
 * `ctx.agent.transform(editor => editor.update(id, fn))` **upserts**: the
 * runtime creates the agent when the id does not exist, so no `add` is needed.
 */

import type { Plugin } from "@opencode/plugin";
import { Agent } from "@opencode/schema/agent";
import { plansFlowBlock } from "./inject.js";
import type { PlanFlow } from "./gui/contract.js";
import { runAgent } from "./flow-rules.js";

export type AgentPermission = {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
};

export type AgentSpec = {
  id: string;
  name: string;
  description: string;
  permissions: readonly AgentPermission[];
};

/**
 * Plan's permission set, minus its plan-directory exception.
 *
 * The plugin keeps the plan record in `plans.db`, so there is no markdown file
 * to allow: every edit path stays denied. `edit`, `write` and `patch` are all
 * checked against the `edit` action.
 */
const PLAN_PERMISSIONS: readonly AgentPermission[] = [
  { action: "question", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "deny" },
];

/** Build's own rules (`packages/core/src/plugin/agent.ts`); editing stays open. */
const BUILD_PERMISSIONS: readonly AgentPermission[] = [
  { action: "question", resource: "*", effect: "allow" },
];

export type AgentSpecWithSystem = AgentSpec & { system: string };

/**
 * Builds the two specs for a given flow: the `<plans-flow>` role baked into
 * `system` (constant for the flow; only the peer agent's name changes between
 * native and dedicated), computed once per flow instead of once per request.
 */
export function agentSpecs(flow: PlanFlow): readonly AgentSpecWithSystem[] {
  const peer = runAgent(flow);
  return [
    {
      id: "planner",
      name: "Planner",
      description: "Read-only agent for exploring the codebase and planning work before implementation.",
      permissions: PLAN_PERMISSIONS,
      system: plansFlowBlock("planner", peer)!,
    },
    {
      id: "executor",
      name: "Executor",
      description: "The default agent. Executes tools based on configured permissions.",
      permissions: BUILD_PERMISSIONS,
      system: plansFlowBlock("executor", peer)!,
    },
  ];
}

// Kept for tests/callers that only need identity/permissions, independent of flow.
export const PLANNER_AGENT: AgentSpec = {
  id: "planner",
  name: "Planner",
  description: "Read-only agent for exploring the codebase and planning work before implementation.",
  permissions: PLAN_PERMISSIONS,
};

export const EXECUTOR_AGENT: AgentSpec = {
  id: "executor",
  name: "Executor",
  description: "The default agent. Executes tools based on configured permissions.",
  permissions: BUILD_PERMISSIONS,
};

export const AGENTS: readonly AgentSpec[] = [PLANNER_AGENT, EXECUTOR_AGENT];

/**
 * Upserts our rules by action + resource. Idempotent across reloads, and it
 * leaves the config-level rules (skills, lsp, external directories) alone.
 *
 * A previous plugin version may have left a duplicate rule with the same
 * action + resource and a different effect; only the first match keeps its
 * position, the rest are dropped so ordering cannot resurrect a stale effect.
 */
export function applyPermissions(
  current: AgentPermission[],
  rules: readonly AgentPermission[],
): void {
  for (const rule of rules) {
    const first = current.findIndex(
      (item) => item.action === rule.action && item.resource === rule.resource,
    );
    if (first >= 0) {
      current[first]!.effect = rule.effect;
      for (let index = current.length - 1; index > first; index -= 1) {
        const item = current[index]!;
        if (item.action === rule.action && item.resource === rule.resource) current.splice(index, 1);
      }
      continue;
    }
    current.push({ ...rule });
  }
}

/**
 * Registers (upserts) the plugin's agents. Call once from `setup`, and again
 * whenever the flow toggles (`setFlow`), so the peer agent named inside the
 * planner's `system` stays accurate without ever touching it per request.
 */
export async function registerAgents(ctx: Plugin.Context, flow: PlanFlow) {
  return ctx.agent.transform((editor) => {
    for (const spec of agentSpecs(flow)) {
      editor.update(spec.id, (item) => {
        item.name = Agent.Name.make(spec.name);
        item.description = spec.description;
        item.mode = "primary";
        item.system = spec.system;
        applyPermissions(item.permissions, spec.permissions);
      });
    }
  });
}
