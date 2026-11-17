/**
 * Opening a session from the overlay.
 *
 * Two rules live here because they are easy to get wrong apart:
 *
 * - The tab belongs to the server that lists the session. The overlay's target
 *   is the builtin server, and `ctx.tabs.open` does nothing when the app does
 *   not list the server passed, so ask the open tabs first and fall back to the
 *   caller's server.
 * - Open the tab BEFORE closing the overlay. Closing first disposes the tree
 *   while the app is still routing, and the render throws `Stale read from
 *   <Show>`, leaving the previous screen on display.
 */

import type { Context } from "@opencode/plugin/gui";
import { closePlansOverlay } from "./overlay-state";

/**
 * Shows the session as a tab and then closes the overlay.
 *
 * @param ctx - The plugin context, for the tab strip and the open sessions.
 * @param sessionID - The session to show.
 * @param serverID - The server to fall back to when no open tab has the session.
 */
export function openSessionTab(ctx: Context, sessionID: string, serverID: string): void {
  const server = ctx.sessions.list().find((entry) => entry.id === sessionID)?.server.id ?? serverID;
  ctx.tabs.open({ server, id: sessionID }, { focus: true });
  closePlansOverlay();
}
