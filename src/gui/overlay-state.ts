/**
 * Whether the global Work/Plans overlay is open. Lives in its own module so
 * the surface can close it (e.g. after starting a planning session) without
 * importing the launcher back.
 */

import { createSignal } from "solid-js";

const [opened, setOpened] = createSignal(false);

export const plansOverlayOpen = opened;
export const openPlansOverlay = (): void => {
  setOpened(true);
};
export const closePlansOverlay = (): void => {
  setOpened(false);
};
