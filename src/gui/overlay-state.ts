/**
 * The overlay's open state and its screen. Module state so the titlebar
 * selector (Initiative | Work | Plans) and the modal share it: the selector
 * opens the overlay directly on a screen, and switching it while the overlay
 * is open changes the body.
 */

import { createSignal } from "solid-js";

export type OverlayMode = "initiatives" | "work" | "plans";

const [opened, setOpened] = createSignal(false);
const [mode, setMode] = createSignal<OverlayMode>("initiatives");

export const plansOverlayOpen = opened;
export const overlayMode = mode;

export const openPlansOverlay = (next?: OverlayMode): void => {
  if (next) setMode(next);
  setOpened(true);
};

export const closePlansOverlay = (): void => {
  setOpened(false);
};
