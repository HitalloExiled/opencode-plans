/**
 * Which agent flow the plugin drives.
 *
 * `native` reproduces the pre-agents behavior byte for byte: Plan/Build, the
 * routing rule for every agent, `/save-plan` capturing `plan`, execute -> build,
 * pause -> plan. `dedicated` uses the plugin's own `planner`/`executor` agents,
 * with their role injected in the request tail.
 *
 * Stored next to `plans.db` (no schema migration) and cached in memory: the
 * context hook runs on every request and must not hit the disk.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { plansDbPath } from "./store.js";

export type PlanFlow = "native" | "dedicated";

/** The mature path: nothing changes for existing sessions. */
export const DEFAULT_FLOW: PlanFlow = "native";

let cached: PlanFlow | undefined;

export function flowPath(): string {
  return join(dirname(plansDbPath()), "flow.json");
}

export function getFlow(): PlanFlow {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(flowPath(), "utf8")) as { flow?: unknown };
    cached = raw.flow === "dedicated" ? "dedicated" : "native";
  } catch {
    cached = DEFAULT_FLOW;
  }
  return cached;
}

export function setFlow(next: PlanFlow): PlanFlow {
  cached = next === "dedicated" ? "dedicated" : "native";
  try {
    mkdirSync(dirname(flowPath()), { recursive: true });
    const tmp = `${flowPath()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ flow: cached }, null, 2)}\n`);
    renameSync(tmp, flowPath());
  } catch (error) {
    console.error(
      `[plans] could not persist the flow: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return cached;
}

/** Test hook: forget the cached value so a temp `$PLANS_DB` is re-read. */
export function resetFlowCache(): void {
  cached = undefined;
}
