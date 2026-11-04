/**
 * Plans GUI/server contract.
 *
 * The window talks to the server plugin over RPC, not to a GUI main process:
 * the server entry is the process that owns `plans.db` and hot-reloads with
 * the plugin. That keeps list/read/write on one schema and lets the panel work
 * even while the desktop's GUI host still has an older main entry loaded.
 */

import { Rpc } from "@opencode/schema/rpc";
import { Schema } from "effect";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type PlanStatus = "active" | "done" | "archived" | "superseded";
export type StepStatus = "todo" | "done";

export type PlanStep = {
  id: string;
  position: number;
  text: string;
  status: StepStatus;
};

export type Plan = {
  id: string;
  projectID: string;
  projectDirectory: string;
  sessionID: string;
  messageID?: string | undefined;
  title: string;
  body: string;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
  steps: readonly PlanStep[];
};

export type PlanResult = {
  ok: boolean;
  error?: string | undefined;
  plan?: Plan | undefined;
};

export type ListOptions = {
  status?: PlanStatus | "all" | undefined;
  limit?: number | undefined;
};

export type UpdateInput = {
  id: string;
  status?: PlanStatus | undefined;
  title?: string | undefined;
  body?: string | undefined;
  /** Session to notify about the user's change. */
  sessionID?: string | undefined;
};

export type StepInput = {
  id: string;
  stepID: string;
  done: boolean;
  /** Session to notify about the user's change. */
  sessionID?: string | undefined;
};

export type RemoveInput = {
  id: string;
  /** Session to notify about the user's change. */
  sessionID?: string | undefined;
};

export type Status = {
  driver: "sqlite" | "none";
  dbPath: string;
  version: number;
  error?: string | undefined;
};

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const optString = Schema.optional(Schema.String);
const optNum = Schema.optional(Schema.Number);

export const planStatusSchema = Schema.Union([
  Schema.Literal("active"),
  Schema.Literal("done"),
  Schema.Literal("archived"),
  Schema.Literal("superseded"),
]);

export const stepStatusSchema = Schema.Union([Schema.Literal("todo"), Schema.Literal("done")]);

export const planStepSchema = Schema.Struct({
  id: Schema.String,
  position: Schema.Number,
  text: Schema.String,
  status: stepStatusSchema,
});

export const planSchema = Schema.Struct({
  id: Schema.String,
  projectID: Schema.String,
  projectDirectory: Schema.String,
  sessionID: Schema.String,
  messageID: optString,
  title: Schema.String,
  body: Schema.String,
  status: planStatusSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  completedAt: optString,
  steps: Schema.Array(planStepSchema),
});

export const planResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: optString,
  plan: Schema.optional(planSchema),
});

export const listOptionsSchema = Schema.Struct({
  status: Schema.optional(Schema.Union([planStatusSchema, Schema.Literal("all")])),
  limit: optNum,
});

export const updateInputSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.optional(planStatusSchema),
  title: optString,
  body: optString,
  sessionID: optString,
});

export const stepInputSchema = Schema.Struct({
  id: Schema.String,
  stepID: Schema.String,
  done: Schema.Boolean,
  sessionID: optString,
});

export const removeInputSchema = Schema.Struct({
  id: Schema.String,
  sessionID: optString,
});

export const statusSchema = Schema.Struct({
  driver: Schema.Union([Schema.Literal("sqlite"), Schema.Literal("none")]),
  dbPath: Schema.String,
  version: Schema.Number,
  error: optString,
});

/* ------------------------------------------------------------------ */
/* The RPC                                                             */
/* ------------------------------------------------------------------ */

export const PlansRpc = Rpc.define({
  id: "opencode.plans",
  methods: {
    status: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(statusSchema),
    },
    list: {
      input: Schema.toStandardSchemaV1(listOptionsSchema),
      output: Schema.toStandardSchemaV1(Schema.Array(planSchema)),
    },
    get: {
      input: Schema.toStandardSchemaV1(Schema.String),
      output: Schema.toStandardSchemaV1(Schema.NullOr(planSchema)),
    },
    update: {
      input: Schema.toStandardSchemaV1(updateInputSchema),
      output: Schema.toStandardSchemaV1(planResultSchema),
    },
    setStep: {
      input: Schema.toStandardSchemaV1(stepInputSchema),
      output: Schema.toStandardSchemaV1(planResultSchema),
    },
    remove: {
      input: Schema.toStandardSchemaV1(removeInputSchema),
      output: Schema.toStandardSchemaV1(planResultSchema),
    },
  },
  events: {},
});
