/**
 * Server-side bus for plan writes.
 *
 * The tools and the RPC handlers both write `plans.db` in the server process;
 * the GUI learns about those writes through a `PlansRpc` event. Keeping the
 * bus here decouples the writers from the RPC registration, which is created
 * in `index.ts` before the tools run.
 */

import type { PlanChange } from "./gui/contract.js";

type Listener = (change: PlanChange) => void;

const listeners = new Set<Listener>();

/** Registers a listener; the returned function removes it. */
export function onPlanChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tells every listener that a plan was written. Never throws at the writer. */
export function emitPlanChange(change: PlanChange): void {
  for (const listener of listeners) {
    try {
      listener(change);
    } catch (error) {
      console.error(
        `[plans] plan change listener failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
