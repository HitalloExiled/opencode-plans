/**
 * Process identity for run recovery.
 *
 * A plugin hot reload keeps the same `process.pid` and its in-flight promises
 * are still alive, so a running run must survive it. A real service restart
 * brings a new pid, and only then are the runs recovered (marked interrupted).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { plansDbPath } from "./store.js";

/** Where the last process stamped itself: next to the database, never in it. */
export function runtimePidPath(): string {
  return join(dirname(plansDbPath()), "runtime.json");
}

/**
 * True when `pid` differs from the one stamped at `path` (first run included),
 * and stamps the new pid. An unreadable file counts as a fresh process.
 */
export function pidChanged(path: string, pid: number): boolean {
  let previous: number | undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    previous = typeof raw.pid === "number" ? raw.pid : undefined;
  } catch {
    previous = undefined;
  }
  if (previous === pid) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ pid }));
  } catch {
    /* best effort: without the stamp the next load recovers again */
  }
  return true;
}

/** True on a real start (or after a crash), false on a hot reload. */
export function isFreshProcess(): boolean {
  return pidChanged(runtimePidPath(), process.pid);
}
