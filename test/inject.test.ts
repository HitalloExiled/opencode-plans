/**
 * Injection tests — pure functions only, no database.
 */

import { describe, expect, test } from "bun:test";
import {
  appendTailBlock,
  hasCompaction,
  hasPlanBlock,
  EXECUTOR_FLOW,
  PLANNER_FLOW,
  PLANS_FLOW_OPEN,
  PLANS_ROUTING_RULE,
  plansFlowBlock,
  pushRoutingRule,
  renderPlanContext,
  type InjectMessage,
} from "../src/inject";
import type { Plan, StepRow, StepStatus } from "../src/store";
import {
  PLANS_NAMESPACE,
  deleteTool,
  doctorTool,
  getTool,
  listTool,
  saveTool,
  updateTool,
} from "../plans";
import { WORK_NAMESPACE, getWorkTool, listWorkTool, saveWorkTool, updateWorkTool } from "../work";

const user = (text: string): InjectMessage => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): InjectMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const toolResult = (text: string): InjectMessage => ({ role: "tool", content: [{ type: "text", text }] });

const BLOCK = "<plans-context>plan</plans-context>";

const step = (step_id: string, text: string, status: StepStatus, position: number): StepRow => ({
  plan_id: "plan-1",
  position,
  step_id,
  text,
  status,
});

const planWith = (steps: StepRow[] = []): Plan => ({
  id: "plan-1",
  project_id: "prj_1",
  project_directory: "/work",
  session_id: "ses_1",
  message_id: "msg_1",
  title: "Ship it",
  body: "# Ship it",
  status: "active",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  completed_at: null,
  work_item_id: null,
  steps,
});

describe("routing rule", () => {
  test("is byte-identical on every request", () => {
    const first: Array<{ type: "text"; text: string }> = [];
    const second: Array<{ type: "text"; text: string }> = [];
    pushRoutingRule(first);
    pushRoutingRule(second);
    expect(second).toEqual(first);
  });

  test("stays as its own trailing system part", () => {
    const system: Array<{ type: "text"; text: string }> = [{ type: "text", text: "core instructions" }];
    pushRoutingRule(system);
    expect(system).toHaveLength(2);
    expect(system.at(-1)?.text).toBe(PLANS_ROUTING_RULE);
  });

  test("makes saving the expected behavior, not a permission", () => {
    expect(PLANS_ROUTING_RULE).toContain("Saving is expected, not optional");
    expect(PLANS_ROUTING_RULE).toContain("call plans.save in the same turn");
    expect(PLANS_ROUTING_RULE).toContain("Never wait for the user to ask");
    expect(PLANS_ROUTING_RULE).toContain("do not call plans.get just to confirm");
    expect(PLANS_ROUTING_RULE).not.toContain("undefined");
  });

  test("separates plans.db from the Plan-mode plan files", () => {
    expect(PLANS_ROUTING_RULE).toContain('The Plan-mode reminder about "plan files" does not cover plans.save');
    expect(PLANS_ROUTING_RULE).toContain("markdown files under ~/.opencode/plan");
    expect(PLANS_ROUTING_RULE).toContain("these tools write only plans.db");
    expect(PLANS_ROUTING_RULE).toContain("Never write a markdown copy as a substitute");
    expect(PLANS_ROUTING_RULE).toContain("plans.db is the only plan record");
  });

  test("keeps every stated requirement inside the plan under construction", () => {
    expect(PLANS_ROUTING_RULE).toContain("every requirement the user states belongs in the plan under construction");
  });
});

describe("plans-flow extension", () => {
  test("carries the shared contract plus the role", () => {
    const planner = plansFlowBlock("planner")!;
    expect(planner.startsWith(PLANS_FLOW_OPEN)).toBe(true);
    expect(planner.endsWith("</plans-flow>")).toBe(true);
    expect(planner).toContain("call plans.save in the same turn");
    expect(planner).toContain("Save at most one plan per request");
    expect(planner).toContain("do not call plans.get just to confirm");
    expect(planner).toContain("plans.update");
    expect(planner).toContain(PLANNER_FLOW);
    expect(planner).not.toContain(EXECUTOR_FLOW);
  });

  test("the planner keeps Plan mode and the executor reads the plan", () => {
    expect(PLANNER_FLOW).toContain("switch to the Executor agent");
    // The clone drops Plan's plan-directory exception, so the flow must say
    // that every edit fails instead of inviting a markdown write.
    expect(PLANNER_FLOW).toContain("File edits are denied");
    expect(PLANNER_FLOW).toContain("~/.opencode/plan");
    expect(PLANNER_FLOW).toContain("plans.db");
    expect(plansFlowBlock("planner")).not.toContain("are scratch");
    expect(EXECUTOR_FLOW).toContain("plans.get");
    expect(EXECUTOR_FLOW).toContain("doing");
    expect(EXECUTOR_FLOW).toContain("done");
    // The executor proposes acceptance; done/dropped stay a human decision.
    expect(EXECUTOR_FLOW).toContain("ready for acceptance");
    expect(EXECUTOR_FLOW).toContain("do not mark the work item done");
  });

  test("native agents and subagents get no block", () => {
    expect(plansFlowBlock("plan")).toBeUndefined();
    expect(plansFlowBlock("build")).toBeUndefined();
    expect(plansFlowBlock(undefined)).toBeUndefined();
  });

  test("rides the tail and coexists with the plan context", () => {
    const messages = [user("a")];
    expect(appendTailBlock(messages, plansFlowBlock("planner")!, PLANS_FLOW_OPEN)).toBe(true);
    // A second layer can still append its own block.
    expect(appendTailBlock(messages, BLOCK)).toBe(true);
    expect(messages[0]!.content.at(-1)?.text).toBe(BLOCK);
    expect(messages[0]!.content.at(-2)?.text).toContain(PLANS_FLOW_OPEN);
  });

  test("is idempotent per tag", () => {
    const messages = [user("a")];
    expect(appendTailBlock(messages, plansFlowBlock("executor")!, PLANS_FLOW_OPEN)).toBe(true);
    expect(appendTailBlock(messages, plansFlowBlock("executor")!, PLANS_FLOW_OPEN)).toBe(false);
    expect(messages[0]!.content).toHaveLength(2);
  });
});

describe("tail block", () => {
  test("appends to the last user message and keeps the same message", () => {
    const messages = [user("hi")];
    const before = messages[0];
    expect(appendTailBlock(messages, BLOCK)).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe(before);
    expect(messages[0]!.content.at(-1)?.text).toBe(BLOCK);
  });

  test("does not touch the earlier messages", () => {
    const messages = [user("a"), assistant("b"), user("c")];
    const prefix = messages.slice(0, 2);
    expect(appendTailBlock(messages, BLOCK)).toBe(true);
    expect(messages[0]).toBe(prefix[0]);
    expect(messages[1]).toBe(prefix[1]);
    expect(messages[2]!.content).toHaveLength(2);
  });

  test("appends a user message when the turn resumes on a tool step", () => {
    const messages = [user("a"), toolResult("r")];
    expect(appendTailBlock(messages, BLOCK)).toBe(true);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({ role: "user", content: [{ type: "text", text: BLOCK }] });
  });

  test("refuses a turn that ends on an assistant message", () => {
    expect(appendTailBlock([user("a"), assistant("b")], BLOCK)).toBe(false);
    expect(appendTailBlock([], BLOCK)).toBe(false);
  });

  test("is idempotent", () => {
    const messages = [user("a")];
    expect(appendTailBlock(messages, BLOCK)).toBe(true);
    expect(appendTailBlock(messages, "<plans-context>again</plans-context>")).toBe(false);
    expect(messages[0]!.content).toHaveLength(2);
  });

  test("skips when the conversation already carries a block", () => {
    const messages = [assistant("<plans-context>old</plans-context>"), user("b")];
    expect(hasPlanBlock(messages)).toBe(true);
    expect(appendTailBlock(messages, BLOCK)).toBe(false);
    expect(messages.at(-1)!.content).toHaveLength(1);
  });

  test("a compaction summary quoting the tag mid-text is not a block", () => {
    const summary = `## Objective\n- verify that <plans-context> lands after compaction`;
    const messages = [user(summary)];
    expect(hasPlanBlock(messages)).toBe(false);
    expect(appendTailBlock(messages, BLOCK)).toBe(true);
    expect(messages[0]!.content).toHaveLength(2);
  });
});

describe("compaction detection", () => {
  test("finds a compaction part anywhere in the request", () => {
    expect(hasCompaction([user("a"), { role: "user", content: [{ type: "compaction" }] }])).toBe(true);
    expect(hasCompaction([user("a"), assistant("b")])).toBe(false);
    expect(hasCompaction([])).toBe(false);
  });
});

describe("renderPlanContext", () => {
  test("renders the session plan with progress and pending ids", () => {
    const text = renderPlanContext(
      planWith([
        step("s1", "one", "done", 0),
        step("s2", "two", "todo", 1),
        step("s3", "three", "doing", 2),
      ]),
    );
    expect(text).toContain("<plans-context>");
    expect(text).toContain("</plans-context>");
    expect(text).toContain("id: plan-1");
    expect(text).toContain("1/3, 1 doing");
    expect(text).toContain("(s2) two");
    expect(text).toContain("(s3) three");
    expect(text).not.toContain("(s1)");
    // The step in progress comes first: it is where the agent stopped.
    expect(text.indexOf("(s3)")).toBeLessThan(text.indexOf("(s2)"));
  });

  test("caps pending steps at eight", () => {
    const steps = Array.from({ length: 12 }, (_, index) =>
      step(`s${index + 1}`, `step ${index + 1}`, "todo", index),
    );
    const text = renderPlanContext(planWith(steps));
    expect(text.match(/^- \[todo\] \(s\d+\)/gm)).toHaveLength(8);
  });

  test("reports a finished plan and an unstructured one", () => {
    expect(renderPlanContext(planWith([step("s1", "one", "done", 0)]))).toContain("All steps are done.");
    expect(renderPlanContext(planWith([]))).toContain("No structured steps");
  });

  test("returns nothing without a plan", () => {
    expect(renderPlanContext(undefined)).toBe("");
  });
});

describe("catalog budget", () => {
  // The Code Mode catalog truncates a tool description with an ellipsis around
  // 119 characters; anything past that never reaches the model.
  const BUDGET = 110;

  test("plans.save shows the Plan-mode permission inside the budget", () => {
    const visible = saveTool({} as never).description.slice(0, BUDGET);
    expect(visible).toContain("Plan mode allows it");
    expect(visible).toContain("plans.db");
  });

  test("plans.update shows the call shape inside the budget", () => {
    const visible = updateTool({} as never).description.slice(0, BUDGET);
    expect(visible).toContain("stepID + stepStatus");
  });

  const allTools = () => [
    saveTool({} as never),
    listTool({} as never),
    getTool({} as never),
    updateTool({} as never),
    deleteTool({} as never),
    doctorTool({} as never),
    listWorkTool({} as never),
    getWorkTool({} as never),
    saveWorkTool({} as never),
    updateWorkTool({} as never),
  ];

  function shapeOf(input: unknown): Record<string, { description?: string }> {
    const schema = input as {
      shape?: Record<string, { description?: string }>;
      _def?: { schema?: { shape?: Record<string, { description?: string }> } };
    };
    return schema.shape ?? schema._def?.schema?.shape ?? {};
  }

  test("every tool and the namespace fit the budget", () => {
    expect(PLANS_NAMESPACE.description.length).toBeLessThanOrEqual(BUDGET);
    expect(WORK_NAMESPACE.description.length).toBeLessThanOrEqual(BUDGET);
    for (const tool of allTools()) {
      expect(tool.description.length, tool.name).toBeLessThanOrEqual(BUDGET);
    }
  });

  test("keeps every parameter description short enough for the catalog", () => {
    for (const tool of allTools()) {
      for (const [name, property] of Object.entries(shapeOf(tool.input))) {
        const description = property.description ?? "";
        expect(description.length, `${tool.name}.${name}`).toBeGreaterThan(0);
        expect(
          description.split(/\s+/).filter(Boolean).length,
          `${tool.name}.${name}`,
        ).toBeLessThanOrEqual(6);
      }
    }
  });
});
