/**
 * Agents registered by the plans plugin.
 *
 * Two primary agents replace the exceptions we used to force on the native
 * Plan/Build flow: a read-only `planner` that persists the plan with
 * `plans.save`, and an `executor` that works the plan step by step.
 *
 * `ctx.agent.transform(editor => editor.update(id, fn))` **upserts**: the
 * runtime creates the agent when the id does not exist (the same path the
 * config plugin uses for config-defined agents), so no `add` is needed.
 */

import type { Plugin } from "@opencode/plugin";
import { Agent } from "@opencode/schema/agent";

export type AgentPermission = {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
};

export type AgentSpec = {
  id: string;
  name: string;
  description: string;
  system: string;
  permissions: readonly AgentPermission[];
};

export const PLANNER_AGENT: AgentSpec = {
  id: "planner",
  name: "Planner",
  description:
    "Read-only planning agent: discusses the plan and persists it with plans.save (plans.db).",
  permissions: [
    { action: "question", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "deny" },
  ],
  system: [
    "You are a read-only planning agent. Explore the codebase, ask what you need, and discuss the plan in the conversation. Never modify files: the edit permission is denied.",
    "",
    "The plans plugin owns the plan record:",
    "- Every requirement the user states belongs in the plan under construction: add steps or amend it.",
    "- When you present a final plan with no blocking question, call plans.save in the same turn. Never wait for the user to ask.",
    "- plans.save and plans.update write only plans.db, never repository files; the native Plan-mode notes about plan files do not apply to this agent.",
    "- The plans.save result already lists the step ids; do not call plans.get just to confirm.",
    '- Track progress with plans.update (stepID + stepStatus: "doing" then "done"); never rewrite the body to change status.',
    "",
    "To implement the plan, tell the user to switch to the Executor agent or run it from the Plans panel.",
  ].join("\n"),
};

export const EXECUTOR_AGENT: AgentSpec = {
  id: "executor",
  name: "Executor",
  description:
    "Executes a persisted plan step by step, updating its steps with plans.update.",
  permissions: [{ action: "question", resource: "*", effect: "allow" }],
  system: [
    "You execute persisted plans. The user message names the plan id.",
    "- Read the plan with plans.get before starting and follow its steps in order.",
    "- Before working a step, mark it doing with plans.update (id + stepID + stepStatus); when it is done, mark it done.",
    "- Never rewrite the plan body or re-plan: the record is the source of truth; plans.update changes status only.",
    "- If a step is blocked, stop and explain instead of silently skipping it.",
  ].join("\n"),
};

export const AGENTS: readonly AgentSpec[] = [PLANNER_AGENT, EXECUTOR_AGENT];

/** Registers (upserts) the plugin's agents. Call once from `setup`. */
export async function registerAgents(ctx: Plugin.Context) {
  return ctx.agent.transform((editor) => {
    for (const spec of AGENTS) {
      // `update` creates the agent when it does not exist; seed permissions
      // only on creation so a reload never duplicates rules.
      const exists = editor.get(spec.id) !== undefined;
      editor.update(spec.id, (item) => {
        item.name = Agent.Name.make(spec.name);
        item.description = spec.description;
        item.mode = "primary";
        item.system = spec.system;
        if (!exists) item.permissions.push(...spec.permissions);
      });
    }
  });
}
