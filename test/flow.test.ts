import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "plans-flow-"));
process.env.PLANS_DB = join(dir, "plans.db");

const { DEFAULT_FLOW, flowPath, getFlow, resetFlowCache, setFlow } = await import("../src/flow");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetFlowCache();
  try {
    rmSync(flowPath());
  } catch {
    /* first run */
  }
});

describe("flow setting", () => {
  test("defaults to native when no file exists", () => {
    expect(DEFAULT_FLOW).toBe("native");
    expect(getFlow()).toBe("native");
  });

  test("persists dedicated next to the database", () => {
    expect(setFlow("dedicated")).toBe("dedicated");
    expect(JSON.parse(readFileSync(flowPath(), "utf8"))).toEqual({ flow: "dedicated" });
    resetFlowCache();
    expect(getFlow()).toBe("dedicated");
  });

  test("an unknown value falls back to native", () => {
    writeFileSync(flowPath(), JSON.stringify({ flow: "bogus" }));
    expect(getFlow()).toBe("native");
  });

  test("setFlow normalizes anything that is not dedicated", () => {
    expect(setFlow("native")).toBe("native");
    resetFlowCache();
    expect(getFlow()).toBe("native");
  });
});
