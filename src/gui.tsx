/**
 * Plans GUI — the `./gui-experimental` entry.
 *
 * The panel reads and writes plans through the server plugin's RPC
 * (`PlansRpc`), so there is no GUI main-process data layer: the same
 * hot-reloaded server process owns plans.db and serves the window.
 */

import { Plugin } from "@opencode/plugin/gui";
import { setup } from "./gui/setup";

const definition = Plugin.define({
  stores: {},
  setup,
});

export default definition;
export type Definition = typeof definition;
