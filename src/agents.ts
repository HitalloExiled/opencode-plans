/**
 * The plugin's own agents, cloned from the runtime's Plan and Build.
 *
 * Plan and Build carry no `system`. What makes Plan read-only is its permission
 * set plus the reminder the core injects on every request; Build is the same
 * definition with editing allowed. Cloning both — instead of carrying a system
 * prompt of our own — keeps what the model sees identical, which is the only
 * way the dedicated flow can behave like the native one.
 *
 * `ctx.agent.transform(editor => editor.update(id, fn))` **upserts**: the
 * runtime creates the agent when the id does not exist, so no `add` is needed.
 */

import type { Plugin } from "@opencode/plugin";
import { Agent } from "@opencode/schema/agent";
import { join } from "node:path";
import { PLAN_DIR } from "./plan-reminder.js";

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

/** Plan's own rules (`packages/core/src/plugin/plan.ts`). */
const PLAN_PERMISSIONS: readonly AgentPermission[] = [
  { action: "question", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "deny" },
  { action: "edit", resource: join(PLAN_DIR, "*"), effect: "allow" },
];

/** Build's own rules (`packages/core/src/plugin/agent.ts`); editing stays open. */
const BUILD_PERMISSIONS: readonly AgentPermission[] = [
  { action: "question", resource: "*", effect: "allow" },
];

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

/** Registers (upserts) the plugin's agents. Call once from `setup`. */
export async function registerAgents(ctx: Plugin.Context) {
  return ctx.agent.transform((editor) => {
    for (const spec of AGENTS) {
      editor.update(spec.id, (item) => {
        item.name = Agent.Name.make(spec.name);
        item.description = spec.description;
        item.mode = "primary";
        // Plan/Build send no system part; anything here would be a byte the
        // native agent never sends.
        item.system = undefined;
        applyPermissions(item.permissions, spec.permissions);
      });
    }
  });
}
