import { describe, expect, test } from "bun:test";
import { flowAgentFor, pauseAgent, planMessageAgents, runAgent } from "../src/flow-rules";

describe("flow -> agents", () => {
  test("native keeps Plan/Build exactly as before the dedicated agents", () => {
    expect(runAgent("native")).toBe("build");
    expect(pauseAgent("native")).toBe("plan");
    expect(planMessageAgents("native")).toEqual(["plan"]);
  });

  test("dedicated uses the plugin's own agents", () => {
    expect(runAgent("dedicated")).toBe("executor");
    expect(pauseAgent("dedicated")).toBe("planner");
    expect(planMessageAgents("dedicated")).toEqual(["plan", "planner"]);
  });
});

describe("flowAgentFor keeps the session role", () => {
  test("a planning session stays planning in both flows", () => {
    expect(flowAgentFor("plan", "dedicated")).toBe("planner");
    expect(flowAgentFor("planner", "native")).toBe("plan");
    expect(flowAgentFor("plan", "native")).toBe("plan");
    expect(flowAgentFor("planner", "dedicated")).toBe("planner");
  });

  test("an executing session stays executing in both flows", () => {
    expect(flowAgentFor("build", "dedicated")).toBe("executor");
    expect(flowAgentFor("executor", "native")).toBe("build");
    expect(flowAgentFor("build", "native")).toBe("build");
    expect(flowAgentFor("executor", "dedicated")).toBe("executor");
  });

  test("any other agent is left alone", () => {
    expect(flowAgentFor("custom", "dedicated")).toBeUndefined();
    expect(flowAgentFor("custom", "native")).toBeUndefined();
    expect(flowAgentFor(undefined, "dedicated")).toBeUndefined();
    expect(flowAgentFor("", "native")).toBeUndefined();
  });
});
