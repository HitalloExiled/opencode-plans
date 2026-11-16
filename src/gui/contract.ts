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
export type StepStatus = "todo" | "doing" | "done";
export type PlanScope = "session" | "project" | "all";
export type PlanFlow = "native" | "dedicated";

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
  scope?: PlanScope | undefined;
  sessionID?: string | undefined;
  status?: PlanStatus | "all" | undefined;
  limit?: number | undefined;
  /** Rows to skip, for the global page's infinite scroll. */
  offset?: number | undefined;
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
  status: StepStatus;
  /** Session to notify about the user's change. */
  sessionID?: string | undefined;
};

export type RemoveInput = {
  id: string;
  /** Session to notify about the user's change. */
  sessionID?: string | undefined;
};

export type MoveInput = {
  id: string;
  /** Destination session. */
  sessionID: string;
};

export type Status = {
  driver: "sqlite" | "none";
  dbPath: string;
  version: number;
  error?: string | undefined;
};

export type ProjectLocation = {
  id: string;
  directory: string;
  label: string;
  primary: boolean;
  position: number;
};

export type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  locations: readonly ProjectLocation[];
};

export type ProjectResult = {
  ok: boolean;
  error?: string | undefined;
  project?: Project | undefined;
  /** The workspace has items; send `confirm: true` to remove it anyway. */
  needsConfirmation?: boolean | undefined;
  items?: number | undefined;
};

export type CreateProjectInput = {
  name: string;
  locations: readonly { directory: string; label?: string | undefined }[];
};

export type ProjectLocationInput = {
  projectID: string;
  directory: string;
  label?: string | undefined;
};

export type ProjectLocationRef = {
  projectID: string;
  locationID: string;
};

export type RemoveProjectLocationInput = ProjectLocationRef & {
  confirm?: boolean | undefined;
};

export type WorkItemStatus = "backlog" | "ready" | "doing" | "blocked" | "done" | "dropped";
export type WorkOrigin = "user" | "agent";

/** UI order of the status sections and board columns. */
export const WORK_STATUS_ORDER = ["doing", "ready", "blocked", "backlog", "done", "dropped"] as const;

/** Allowed status moves. Same-status is a no-op; anything else is rejected. */
export const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  backlog: ["ready", "dropped"],
  ready: ["doing", "blocked", "backlog", "dropped"],
  doing: ["done", "blocked", "ready", "dropped"],
  blocked: ["ready", "doing", "dropped"],
  done: ["ready"],
  dropped: ["backlog", "ready"],
};

export type WorkItem = {
  id: string;
  projectID: string;
  locationID?: string | undefined;
  parentID?: string | undefined;
  title: string;
  status: WorkItemStatus;
  rank: number;
  origin: WorkOrigin;
  createdAt: string;
  updatedAt: string;
};

export type WorkGroup = {
  project: Project;
  items: readonly WorkItem[];
};

export type WorkListInput = {
  scope: "project" | "all";
  /** Session directory; resolves the project for `scope: "project"`. */
  directory?: string | undefined;
};

export type WorkItemDetail = {
  item: WorkItem & { body: string; closedAt?: string | undefined };
  project: Project;
};

export type SaveWorkItemInput = {
  id?: string | undefined;
  /** Required when creating: resolves (or creates) the project. */
  directory?: string | undefined;
  title: string;
  body?: string | undefined;
};

export type WorkItemResult = {
  ok: boolean;
  error?: string | undefined;
  item?: WorkItem | undefined;
};

export type MoveWorkItemInput = {
  id: string;
  direction: "up" | "down";
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

export const planFlowSchema = Schema.Union([Schema.Literal("native"), Schema.Literal("dedicated")]);

export const planScopeSchema = Schema.Union([
  Schema.Literal("session"),
  Schema.Literal("project"),
  Schema.Literal("all"),
]);

export const stepStatusSchema = Schema.Union([
  Schema.Literal("todo"),
  Schema.Literal("doing"),
  Schema.Literal("done"),
]);

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

export const projectLocationSchema = Schema.Struct({
  id: Schema.String,
  directory: Schema.String,
  label: Schema.String,
  primary: Schema.Boolean,
  position: Schema.Number,
});

export const projectSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  locations: Schema.Array(projectLocationSchema),
});

export const projectResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: optString,
  project: Schema.optional(projectSchema),
  needsConfirmation: Schema.optional(Schema.Boolean),
  items: optNum,
});

export const createProjectInputSchema = Schema.Struct({
  name: Schema.String,
  locations: Schema.Array(Schema.Struct({ directory: Schema.String, label: optString })),
});

export const renameProjectInputSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

export const projectLocationInputSchema = Schema.Struct({
  projectID: Schema.String,
  directory: Schema.String,
  label: optString,
});

export const projectLocationRefSchema = Schema.Struct({
  projectID: Schema.String,
  locationID: Schema.String,
});

export const removeProjectLocationInputSchema = Schema.Struct({
  projectID: Schema.String,
  locationID: Schema.String,
  confirm: Schema.optional(Schema.Boolean),
});

export const workStatusSchema = Schema.Union([
  Schema.Literal("backlog"),
  Schema.Literal("ready"),
  Schema.Literal("doing"),
  Schema.Literal("blocked"),
  Schema.Literal("done"),
  Schema.Literal("dropped"),
]);

export const workOriginSchema = Schema.Union([Schema.Literal("user"), Schema.Literal("agent")]);

export const workItemSchema = Schema.Struct({
  id: Schema.String,
  projectID: Schema.String,
  locationID: optString,
  parentID: optString,
  title: Schema.String,
  status: workStatusSchema,
  rank: Schema.Number,
  origin: workOriginSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export const workGroupSchema = Schema.Struct({
  project: projectSchema,
  items: Schema.Array(workItemSchema),
});

export const workListInputSchema = Schema.Struct({
  scope: Schema.Union([Schema.Literal("project"), Schema.Literal("all")]),
  directory: optString,
});

export const workItemFullSchema = Schema.Struct({
  ...workItemSchema.fields,
  body: Schema.String,
  closedAt: optString,
});

export const workItemDetailSchema = Schema.Struct({
  item: workItemFullSchema,
  project: projectSchema,
});

export const workItemResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: optString,
  item: Schema.optional(workItemSchema),
});

export const workItemIdInputSchema = Schema.Struct({
  id: Schema.String,
});

export const saveWorkItemInputSchema = Schema.Struct({
  id: optString,
  directory: optString,
  title: Schema.String,
  body: optString,
});

export const setWorkItemStatusInputSchema = Schema.Struct({
  id: Schema.String,
  status: workStatusSchema,
});

export const moveWorkItemInputSchema = Schema.Struct({
  id: Schema.String,
  direction: Schema.Union([Schema.Literal("up"), Schema.Literal("down")]),
});

export const listOptionsSchema = Schema.Struct({
  scope: Schema.optional(planScopeSchema),
  sessionID: optString,
  status: Schema.optional(Schema.Union([planStatusSchema, Schema.Literal("all")])),
  limit: optNum,
  offset: optNum,
});

export const countOptionsSchema = Schema.Struct({
  scope: Schema.optional(planScopeSchema),
  sessionID: optString,
  status: Schema.optional(Schema.Union([planStatusSchema, Schema.Literal("all")])),
});

export const updateInputSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.optional(planStatusSchema),
  title: optString,
  body: optString,
  sessionID: optString,
  locale: optString,
});

export const saveInputSchema = Schema.Struct({
  id: optString,
  title: Schema.String,
  body: Schema.String,
  steps: Schema.optional(Schema.Array(Schema.String)),
  sessionID: Schema.String,
  locale: optString,
});

export const stepInputSchema = Schema.Struct({
  id: Schema.String,
  stepID: Schema.String,
  status: stepStatusSchema,
  sessionID: optString,
  locale: optString,
});

export const removeInputSchema = Schema.Struct({
  id: Schema.String,
  sessionID: optString,
  locale: optString,
});

export const moveInputSchema = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  locale: optString,
});

export const statusSchema = Schema.Struct({
  driver: Schema.Union([Schema.Literal("sqlite"), Schema.Literal("none")]),
  dbPath: Schema.String,
  version: Schema.Number,
  error: optString,
});

/**
 * A write to `plans.db`. `sessionID` is the plan's session after the write
 * (the destination, for a move); `planID` is omitted when several plans
 * changed at once.
 */
export type PlanChange = {
  sessionID: string;
  planID?: string | undefined;
};

export const planChangeSchema = Schema.Struct({
  sessionID: Schema.String,
  planID: optString,
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
    count: {
      input: Schema.toStandardSchemaV1(countOptionsSchema),
      output: Schema.toStandardSchemaV1(Schema.Number),
    },
    get: {
      input: Schema.toStandardSchemaV1(Schema.String),
      output: Schema.toStandardSchemaV1(Schema.NullOr(planSchema)),
    },
    save: {
      input: Schema.toStandardSchemaV1(saveInputSchema),
      output: Schema.toStandardSchemaV1(planResultSchema),
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
    move: {
      input: Schema.toStandardSchemaV1(moveInputSchema),
      output: Schema.toStandardSchemaV1(planResultSchema),
    },
    setLocale: {
      input: Schema.toStandardSchemaV1(Schema.String),
      output: Schema.toStandardSchemaV1(Schema.Null),
    },
    getFlow: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(planFlowSchema),
    },
    setFlow: {
      input: Schema.toStandardSchemaV1(planFlowSchema),
      output: Schema.toStandardSchemaV1(planFlowSchema),
    },
    listProjects: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Schema.Array(projectSchema)),
    },
    createProject: {
      input: Schema.toStandardSchemaV1(createProjectInputSchema),
      output: Schema.toStandardSchemaV1(projectResultSchema),
    },
    renameProject: {
      input: Schema.toStandardSchemaV1(renameProjectInputSchema),
      output: Schema.toStandardSchemaV1(projectResultSchema),
    },
    addProjectLocation: {
      input: Schema.toStandardSchemaV1(projectLocationInputSchema),
      output: Schema.toStandardSchemaV1(projectResultSchema),
    },
    removeProjectLocation: {
      input: Schema.toStandardSchemaV1(removeProjectLocationInputSchema),
      output: Schema.toStandardSchemaV1(projectResultSchema),
    },
    setProjectPrimary: {
      input: Schema.toStandardSchemaV1(projectLocationRefSchema),
      output: Schema.toStandardSchemaV1(projectResultSchema),
    },
    listWorkItems: {
      input: Schema.toStandardSchemaV1(workListInputSchema),
      output: Schema.toStandardSchemaV1(Schema.Array(workGroupSchema)),
    },
    getWorkItem: {
      input: Schema.toStandardSchemaV1(workItemIdInputSchema),
      output: Schema.toStandardSchemaV1(Schema.NullOr(workItemDetailSchema)),
    },
    saveWorkItem: {
      input: Schema.toStandardSchemaV1(saveWorkItemInputSchema),
      output: Schema.toStandardSchemaV1(workItemResultSchema),
    },
    setWorkItemStatus: {
      input: Schema.toStandardSchemaV1(setWorkItemStatusInputSchema),
      output: Schema.toStandardSchemaV1(workItemResultSchema),
    },
    moveWorkItem: {
      input: Schema.toStandardSchemaV1(moveWorkItemInputSchema),
      output: Schema.toStandardSchemaV1(workItemResultSchema),
    },
  },
  events: {
    changed: { schema: Schema.toStandardSchemaV1(planChangeSchema) },
  },
});
