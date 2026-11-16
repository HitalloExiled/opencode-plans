/**
 * The initiative selected in the overlay, persisted between openings. The
 * Initiative screen sets it when opening Work; Work's selector changes it.
 */

import { Schema } from "effect";
import type { Context, Persisted } from "@opencode/plugin/gui";

const Selection = Schema.Struct({ id: Schema.NullOr(Schema.String) });
type SelectionValue = { id: string | null };

const stores = new Map<Context, Persisted<SelectionValue>>();

export function initiativeSelection(ctx: Context): Persisted<SelectionValue> {
  let store = stores.get(ctx);
  if (!store) {
    store = ctx.storage.store("work:initiative", { schema: Selection, initial: { id: null } });
    stores.set(ctx, store);
  }
  return store;
}
