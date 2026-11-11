/**
 * Persisted panel state: which plan is open, the search text and filters.
 *
 * Kept per session through `ctx.storage.store(..., { scope: { session } })`,
 * so closing and reopening the tab restores the same screen.
 */

import { Schema } from "effect";

export type StatusFilter = "active" | "done" | "all";
export type ScopeFilter = "session" | "project";

export type ViewStateValue = {
  selectedID: string | null;
  query: string;
  status: StatusFilter;
  scope: ScopeFilter;
  stepsHeight?: number;
  page?: number;
};

export const ViewState = Schema.Struct({
  selectedID: Schema.NullOr(Schema.String),
  query: Schema.String,
  status: Schema.Union([
    Schema.Literal("active"),
    Schema.Literal("done"),
    Schema.Literal("all"),
  ]),
  scope: Schema.Union([Schema.Literal("session"), Schema.Literal("project")]),
  // Kept optional for states written before the body collapse was removed.
  bodyCollapsed: Schema.optional(Schema.Boolean),
  stepsHeight: Schema.optional(Schema.Number),
  page: Schema.optional(Schema.Number),
});

export const VIEW_INITIAL: ViewStateValue = {
  selectedID: null,
  query: "",
  status: "active",
  scope: "session",
  stepsHeight: 240,
  page: 0,
};
