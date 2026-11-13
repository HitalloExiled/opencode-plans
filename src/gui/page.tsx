/**
 * The global plans surfaces (the window.bottom launcher and its modal) have no
 * routed session: they read `plans.db` through the desktop's builtin server.
 */

import type { Context, ServerRef } from "@opencode/plugin/gui";
import type { PlansTarget } from "./view";

/** Persisted view state for the global surface, one entry per server. */
export const globalStorageKey = (server: ServerRef): string => `plans:all:${server.id}`;

/** The desktop's own server: `plans.db` is local to it. */
export function builtinServer(ctx: Context): ServerRef | undefined {
  return ctx.servers
    .list()
    .map((id) => ctx.servers.get(id))
    .find((server) => server?.builtin);
}

/** A session-less target for `PlansBody`, always on screen. */
export function globalTarget(server: ServerRef): PlansTarget {
  return {
    mode: "modal",
    server,
    storageKey: globalStorageKey(server),
    visible: () => true,
    projectName: () => "",
  };
}
