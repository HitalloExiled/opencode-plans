/**
 * The overlay's open state and its screen. Module state so the titlebar
 * selector (Initiative | Work | Plans) and the modal share it: the selector
 * opens the overlay directly on a screen, and switching it while the overlay
 * is open changes the body.
 */

import { createSignal } from "solid-js";

export type OverlayMode = "work" | "plans";

const [opened, setOpened] = createSignal(false);
const [mode, setMode] = createSignal<OverlayMode>("work");
const [pendingWorkItem, setPendingWorkItem] = createSignal<string | null>(null);

export const plansOverlayOpen = opened;
export const overlayMode = mode;
export const pendingItem = pendingWorkItem;

/** Deep link from a plan to its work item: Work opens the detail on mount. */
export const requestWorkItem = (id: string): void => {
  setPendingWorkItem(id);
};

/** Reads the pending item once; the next Work surface that asks gets nothing. */
export const consumePendingWorkItem = (): string | null => {
  const id = pendingWorkItem();
  if (id !== null) setPendingWorkItem(null);
  return id;
};

export const openPlansOverlay = (next?: OverlayMode): void => {
  if (next) setMode(next);
  setOpened(true);
};

export const closePlansOverlay = (): void => {
  setOpened(false);
};
