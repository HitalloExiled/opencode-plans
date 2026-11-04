/**
 * Plans GUI — IPC contract.
 *
 * Types are declared next to the runtime Effect schemas so the window and the
 * main process stay in lockstep. Only app-provided modules are importable
 * here: `effect` and `@opencode/plugin/gui`.
 */

import { Ipc } from "@opencode/plugin/gui";
import { Schema } from "effect";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type PlanStatus = "active" | "done" | "abandoned" | "superseded";
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
  projectID?: string | undefined;
  status?: PlanStatus | "all" | undefined;
  limit?: number | undefined;
};

export type UpdateInput = {
  id: string;
  status?: PlanStatus | undefined;
  title?: string | undefined;
  body?: string | undefined;
};

export type StepInput = {
  id: string;
  stepID: string;
  done: boolean;
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
  Schema.Literal("abandoned"),
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
  projectID: optString,
  status: Schema.optional(Schema.Union([planStatusSchema, Schema.Literal("all")])),
  limit: optNum,
});

export const updateInputSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.optional(planStatusSchema),
  title: optString,
  body: optString,
});

export const stepInputSchema = Schema.Struct({
  id: Schema.String,
  stepID: Schema.String,
  done: Schema.Boolean,
});

export const statusSchema = Schema.Struct({
  driver: Schema.Union([Schema.Literal("sqlite"), Schema.Literal("none")]),
  dbPath: Schema.String,
  version: Schema.Number,
  error: optString,
});

/* ------------------------------------------------------------------ */
/* The Ipc                                                             */
/* ------------------------------------------------------------------ */

export const PlansApi = Ipc.define({
  id: "plans",
  methods: {
    status: { output: statusSchema },
    list: { input: listOptionsSchema, output: Schema.Array(planSchema) },
    get: { input: Schema.String, output: Schema.optional(planSchema) },
    update: { input: updateInputSchema, output: planResultSchema },
    setStep: { input: stepInputSchema, output: planResultSchema },
    remove: { input: Schema.String, output: planResultSchema },
  },
});
