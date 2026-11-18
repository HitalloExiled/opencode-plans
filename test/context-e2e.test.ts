/**
 * End-to-end regression test for the incident in session `ses_e1143f83`: a
 * `planner` session with the flow switch off got none of the read-only
 * contract (no reminder, no `<plans-flow>` role), only the `edit * deny`
 * permission survived. `applyContextLayers` must give `planner`/`executor`
 * the same reminder treatment in either flow, and `agentSpecs` must give them
 * the same `<plans-flow>` role baked into `system` (the flow only names the
 * peer agent) — no longer replayed into the tail on every request.
 */

import { describe, expect, test } from "bun:test";
import { applyContextLayers } from "../index";
import { PLANS_ROUTING_RULE, type InjectMessage } from "../src/inject";
import { PLAN_DIR, PLANNER_REMINDER } from "../src/plan-reminder";
import { agentSpecs } from "../src/agents";

const PLAN_DIR_MARKER = PLAN_DIR;

type System = Array<{ type: "text"; text: string }>;

function run(agent: string, flow: "native" | "dedicated", last: InjectMessage) {
  const system: System = [];
  const messages: InjectMessage[] = [last];
  applyContextLayers(agent, flow, system, messages);
  const allText = messages.flatMap((m) => m.content).map((p) => p.text ?? "").join("\n");
  return { system, messages, last: messages.at(-1)!, allText };
}

const user = (text = "fix this"): InjectMessage => ({ role: "user", content: [{ type: "text", text }] });
const toolStep = (): InjectMessage => ({ role: "tool", content: [{ type: "text", text: "result" }] });

describe("plans-flow role baked into agent system — agent x flow matrix", () => {
  for (const flow of ["native", "dedicated"] as const) {
    test(`planner (${flow}): system carries the role, naming the right peer`, () => {
      const spec = agentSpecs(flow).find((a) => a.id === "planner")!;
      expect(spec.system).toContain("<plans-flow>");
      expect(spec.system).toContain("Role: planner.");
      if (flow === "native") expect(spec.system).toContain("switch to the Build agent");
      else expect(spec.system).toContain("switch to the Executor agent");
      expect(spec.system).toContain("Tools remain allowed in this role: initiative.*, work.*, plans.*");
    });

    test(`executor (${flow}): system carries the role`, () => {
      const spec = agentSpecs(flow).find((a) => a.id === "executor")!;
      expect(spec.system).toContain("<plans-flow>");
      expect(spec.system).toContain("Role: executor.");
    });
  }
});

describe("context layers e2e — agent x flow matrix (tail: reminder only, system: routing rule)", () => {
  for (const flow of ["native", "dedicated"] as const) {
    test(`planner (${flow}): reminder in the tail, no routing rule in system`, () => {
      const { system, allText } = run("planner", flow, user());
      expect(system).toHaveLength(0);
      expect(allText).toContain(PLANNER_REMINDER);
      expect(allText).not.toContain(PLAN_DIR_MARKER);
    });

    test(`executor (${flow}): no reminder, no routing rule, nothing added to the tail`, () => {
      const { system, last } = run("executor", flow, user());
      expect(system).toHaveLength(0);
      expect(last.content).toHaveLength(1);
    });

  test(`plan (${flow}): routing rule in system, no reminder (core owns it), no tail addition`, () => {
      const { system, last } = run("plan", flow, user());
      expect(system).toHaveLength(1);
      expect(system[0]!.text).toBe(PLANS_ROUTING_RULE);
      expect(last.content).toHaveLength(1);
    });

    test(`build (${flow}): routing rule in system, nothing in the tail`, () => {
      const { system, last } = run("build", flow, user());
      expect(system).toHaveLength(1);
      expect(system[0]!.text).toBe(PLANS_ROUTING_RULE);
      expect(last.content).toHaveLength(1);
    });
  }

  test("a planner chosen by hand with the switch off (the incident) still gets the reminder", () => {
    const { system, allText } = run("planner", "native", user("corrige o scroll do card"));
    expect(system).toHaveLength(0);
    expect(allText).toContain(PLANNER_REMINDER.slice(0, 20));
  });

  test("tool step: the reminder rides a new user message, does not stack on a second call", () => {
    const system: System = [];
    const messages: InjectMessage[] = [toolStep()];
    applyContextLayers("planner", "dedicated", system, messages);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.role).toBe("user");

    // A second context pass on the same conversation must not duplicate the reminder.
    applyContextLayers("planner", "dedicated", system, messages);
    const reminders = messages
      .flatMap((m) => m.content)
      .filter((p) => p.text === PLANNER_REMINDER);
    expect(reminders).toHaveLength(1);
  });
});
