/**
 * End-to-end regression test for the incident in session `ses_e1143f83`: a
 * `planner` session with the flow switch off got none of the read-only
 * contract (no reminder, no `<plans-flow>` tail), only the `edit * deny`
 * permission survived. `applyContextLayers` must give `planner`/`executor`
 * the same bytes in either flow; the flow only names the peer agent.
 */

import { describe, expect, test } from "bun:test";
import { applyContextLayers } from "../index";
import { PLANS_FLOW_OPEN, PLANS_ROUTING_RULE, type InjectMessage } from "../src/inject";
import { PLAN_REMINDER } from "../src/plan-reminder";

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

describe("context layers e2e — agent x flow matrix", () => {
  for (const flow of ["native", "dedicated"] as const) {
    test(`planner (${flow}): reminder + <plans-flow> tail, no routing rule in system`, () => {
      const { system, allText } = run("planner", flow, user());
      expect(system).toHaveLength(0);
      expect(allText).toContain(PLAN_REMINDER.slice(0, 20));
      expect(allText).toContain(PLANS_FLOW_OPEN);
      expect(allText).toContain("Role: planner.");
      if (flow === "native") expect(allText).toContain("switch to the Build agent");
      else expect(allText).toContain("switch to the Executor agent");
      // The "plan files" disambiguation survives even without the routing rule.
      expect(allText).toContain('The Plan-mode reminder about "plan files" does not cover plans.save');
    });

    test(`executor (${flow}): <plans-flow> tail, no reminder, no routing rule`, () => {
      const { system, allText } = run("executor", flow, user());
      expect(system).toHaveLength(0);
      expect(allText).not.toContain(PLAN_REMINDER.slice(0, 20));
      expect(allText).toContain(PLANS_FLOW_OPEN);
      expect(allText).toContain("Role: executor.");
    });

    test(`plan (${flow}): routing rule in system, no reminder, no tail block`, () => {
      const { system, allText } = run("plan", flow, user());
      expect(system).toHaveLength(1);
      expect(system[0]!.text).toBe(PLANS_ROUTING_RULE);
      expect(allText).not.toContain(PLAN_REMINDER.slice(0, 20));
      expect(allText).not.toContain(PLANS_FLOW_OPEN);
    });

    test(`build (${flow}): routing rule in system, nothing in the tail`, () => {
      const { system, last } = run("build", flow, user());
      expect(system).toHaveLength(1);
      expect(system[0]!.text).toBe(PLANS_ROUTING_RULE);
      expect(last.content).toHaveLength(1);
    });
  }

  test("a planner chosen by hand with the switch off (the incident) still gets the contract", () => {
    const { system, allText } = run("planner", "native", user("corrige o scroll do card"));
    expect(system).toHaveLength(0);
    expect(allText).toContain(PLAN_REMINDER.slice(0, 20));
    expect(allText).toContain(PLANS_FLOW_OPEN);
  });

  test("tool step: the tail rides a new user message, does not stack on a second call", () => {
    const system: System = [];
    const messages: InjectMessage[] = [toolStep()];
    applyContextLayers("planner", "dedicated", system, messages);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.role).toBe("user");

    // A second context pass on the same conversation must not duplicate the block.
    applyContextLayers("planner", "dedicated", system, messages);
    const flowBlocks = messages.flatMap((m) => m.content).filter((p) => (p.text ?? "").startsWith(PLANS_FLOW_OPEN));
    expect(flowBlocks).toHaveLength(1);
  });
});
