import { describe, expect, test } from "bun:test";
import { pauseAgent, planMessageAgents, runAgent } from "../src/flow-rules";

describe("flow -> agents", () => {
  test("native keeps Plan/Build exactly as before the dedicated agents", () => {
    expect(runAgent("native")).toBe("build");
    expect(pauseAgent("native")).toBe("plan");
    expect(planMessageAgents("native")).toEqual(["plan", "planner"]);
  });

  test("dedicated uses the plugin's own agents", () => {
    expect(runAgent("dedicated")).toBe("executor");
    expect(pauseAgent("dedicated")).toBe("planner");
    expect(planMessageAgents("dedicated")).toEqual(["plan", "planner"]);
  });
});
