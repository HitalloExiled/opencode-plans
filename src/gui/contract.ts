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
  workItemID?: string | undefined;
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

export type InitiativeRepo = {
  id: string;
  directory: string;
  label: string;
  primary: boolean;
  position: number;
};

export type Initiative = {
  id: string;
  name: string;
  description?: string | undefined;
  createdAt: string;
  updatedAt: string;
  repos: readonly InitiativeRepo[];
  /** Run settings (F4). */
  baseBranch?: string | undefined;
  maxParallel?: number | undefined;
  verifyCommand?: string | undefined;
};

export type InitiativeResult = {
  ok: boolean;
  error?: string | undefined;
  initiative?: Initiative | undefined;
  /** The workspace has items; send `confirm: true` to remove it anyway. */
  needsConfirmation?: boolean | undefined;
  items?: number | undefined;
};

export type CreateInitiativeInput = {
  name: string;
  repos: readonly { directory: string; label?: string | undefined }[];
};

export type InitiativeRepoInput = {
  initiativeID: string;
  directory: string;
  label?: string | undefined;
};

export type InitiativeRepoRef = {
  initiativeID: string;
  repoID: string;
};

export type RemoveInitiativeRepoInput = InitiativeRepoRef & {
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
  initiativeID: string;
  repoID?: string | undefined;
  parentID?: string | undefined;
  title: string;
  status: WorkItemStatus;
  rank: number;
  origin: WorkOrigin;
  createdAt: string;
  updatedAt: string;
};

export type WorkGroup = {
  initiative: Initiative;
  items: readonly WorkItem[];
};

export type WorkListInput = {
  scope: "initiative" | "all";
  /** Session directory; resolves the project for `scope: "project"`. */
  directory?: string | undefined;
};

export type WorkItemDetail = {
  item: WorkItem & { body: string; closedAt?: string | undefined };
  initiative: Initiative;
  /** Items this one depends on. */
  blockedBy: readonly WorkItem[];
  /** Items that depend on this one. */
  blocks: readonly WorkItem[];
  /** Root parent, when this item is a child. */
  parent?: WorkItem | null | undefined;
  /** Direct children when this item is a root. */
  children: readonly WorkItem[];
  /** The plan that executes this item, when it has one. */
  plan?: PlanSummary | null | undefined;
};

export type SaveWorkItemInput = {
  id?: string | undefined;
  /** Required when creating: resolves (or creates) the initiative. */
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

export type WorkItemDepInput = {
  itemID: string;
  blocksID: string;
};

export type SetWorkItemParentInput = {
  id: string;
  /** null clears the parent. */
  parentID?: string | null | undefined;
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
  workItemID: optString,
  touches: Schema.optional(Schema.Array(Schema.String)),
  steps: Schema.Array(planStepSchema),
});

export type PlanSummary = {
  id: string;
  title: string;
  status: PlanStatus;
  done: number;
  total: number;
  updatedAt: string;
  /** Session that owns the plan; opening it shows the plan there. */
  sessionID: string;
};

export const planSummarySchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: planStatusSchema,
  done: Schema.Number,
  total: Schema.Number,
  updatedAt: Schema.String,
  sessionID: Schema.String,
});

export const planResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: optString,
  plan: Schema.optional(planSchema),
});

export const initiativeRepoSchema = Schema.Struct({
  id: Schema.String,
  directory: Schema.String,
  label: Schema.String,
  primary: Schema.Boolean,
  position: Schema.Number,
});

export const initiativeSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: optString,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  repos: Schema.Array(initiativeRepoSchema),
  baseBranch: optString,
  maxParallel: Schema.optional(Schema.Number),
  verifyCommand: optString,
});

export const initiativeResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: optString,
  initiative: Schema.optional(initiativeSchema),
  needsConfirmation: Schema.optional(Schema.Boolean),
  items: optNum,
});

export const createInitiativeInputSchema = Schema.Struct({
  name: Schema.String,
  description: optString,
  repos: Schema.optional(Schema.Array(Schema.Struct({ directory: Schema.String, label: optString }))),
});

export const updateInitiativeInputSchema = Schema.Struct({
  id: Schema.String,
  name: optString,
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

export const initiativeRepoInputSchema = Schema.Struct({
  initiativeID: Schema.String,
  directory: Schema.String,
  label: optString,
});

export const initiativeRepoRefSchema = Schema.Struct({
  initiativeID: Schema.String,
  repoID: Schema.String,
});

export const removeInitiativeRepoInputSchema = Schema.Struct({
  initiativeID: Schema.String,
  repoID: Schema.String,
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
  initiativeID: Schema.String,
  repoID: optString,
  parentID: optString,
  title: Schema.String,
  status: workStatusSchema,
  rank: Schema.Number,
  origin: workOriginSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export const workGroupSchema = Schema.Struct({
  initiative: initiativeSchema,
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
  initiative: initiativeSchema,
  blockedBy: Schema.Array(workItemSchema),
  blocks: Schema.Array(workItemSchema),
  parent: Schema.optional(Schema.NullOr(workItemSchema)),
  children: Schema.Array(workItemSchema),
  plan: Schema.optional(Schema.NullOr(planSummarySchema)),
});

export const opResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: optString,
});

export const workItemResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: optString,
  item: Schema.optional(workItemSchema),
});

export type WorkGraphPlan = {
  id: string;
  title: string;
  status: string;
  done: number;
  total: number;
};

export type WorkGraphNode = {
  id: string;
  title: string;
  status: string;
  rank: number;
  createdAt: string;
  plan?: WorkGraphPlan | undefined;
};

export type WorkGraphEdge = {
  itemID: string;
  blocksID: string;
  kind: "explicit" | "implicit";
  reason?: string | undefined;
};

export type WorkGraph = { nodes: WorkGraphNode[]; edges: WorkGraphEdge[] };

export const workGraphPlanSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  done: Schema.Number,
  total: Schema.Number,
});

export const workGraphNodeSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  rank: Schema.Number,
  createdAt: Schema.String,
  plan: Schema.optional(workGraphPlanSchema),
});

export const workGraphEdgeSchema = Schema.Struct({
  itemID: Schema.String,
  blocksID: Schema.String,
  kind: Schema.Union([Schema.Literal("explicit"), Schema.Literal("implicit")]),
  reason: optString,
});

export const workGraphSchema = Schema.Struct({
  nodes: Schema.Array(workGraphNodeSchema),
  edges: Schema.Array(workGraphEdgeSchema),
});

export const workGraphInputSchema = Schema.Struct({ initiativeID: Schema.String });

export const setWorkItemRepoInputSchema = Schema.Struct({
  id: Schema.String,
  repoID: Schema.String,
});

export const ensureInitiativeRepoInputSchema = Schema.Struct({
  initiativeID: Schema.String,
  directory: Schema.String,
});

export const ensureRepoResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: optString,
  repo: Schema.optional(initiativeRepoSchema),
  created: Schema.optional(Schema.Boolean),
});

export const workItemIdInputSchema = Schema.Struct({
  id: Schema.String,
});

export const saveWorkItemInputSchema = Schema.Struct({
  id: optString,
  directory: optString,
  initiativeID: optString,
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

export const placeWorkItemInputSchema = Schema.Struct({
  id: Schema.String,
  status: workStatusSchema,
  /** Zero-based index inside the destination column. */
  position: Schema.Number,
});

export const workItemDepInputSchema = Schema.Struct({
  itemID: Schema.String,
  blocksID: Schema.String,
});

export const setWorkItemParentInputSchema = Schema.Struct({
  id: Schema.String,
  parentID: Schema.optional(Schema.NullOr(Schema.String)),
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

export const setPlanWorkItemInputSchema = Schema.Struct({
  id: Schema.String,
  workItemID: Schema.NullOr(Schema.String),
});

export const saveInputSchema = Schema.Struct({
  id: optString,
  title: Schema.String,
  body: Schema.String,
  steps: Schema.optional(Schema.Array(Schema.String)),
  sessionID: Schema.String,
  workItemID: optString,
  touches: Schema.optional(Schema.Array(Schema.String)),
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
/* Initiative runs (F4)                                                   */
/* ------------------------------------------------------------------ */

export type RunItemView = {
  itemID: string;
  title: string;
  status: string;
  branch?: string | undefined;
  worktree?: string | undefined;
  sessionID?: string | undefined;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  mergedSha?: string | undefined;
  error?: string | undefined;
};

export type MergeEntryView = {
  id: string;
  itemID: string;
  title: string;
  status: string;
  enqueuedAt: string;
  claimedAt?: string | undefined;
  finishedAt?: string | undefined;
  error?: string | undefined;
};

export type RunView = {
  id: string;
  initiativeID: string;
  baseRef: string;
  status: string;
  maxParallel: number;
  mergeSessionID?: string | undefined;
  startedAt: string;
  finishedAt?: string | undefined;
  error?: string | undefined;
  items: RunItemView[];
  queue: MergeEntryView[];
};

export type PreflightView = {
  ok: boolean;
  blockers: string[];
  baseRef?: string | undefined;
  maxParallel?: number | undefined;
  items: {
    itemID: string;
    title: string;
    planID: string;
    planTitle: string;
    deps: string[];
  }[];
};

export const runItemViewSchema = Schema.Struct({
  itemID: Schema.String,
  title: Schema.String,
  status: Schema.String,
  branch: optString,
  worktree: optString,
  sessionID: optString,
  startedAt: optString,
  finishedAt: optString,
  mergedSha: optString,
  error: optString,
});

export const mergeEntryViewSchema = Schema.Struct({
  id: Schema.String,
  itemID: Schema.String,
  title: Schema.String,
  status: Schema.String,
  enqueuedAt: Schema.String,
  claimedAt: optString,
  finishedAt: optString,
  error: optString,
});

export const runViewSchema = Schema.Struct({
  id: Schema.String,
  initiativeID: Schema.String,
  baseRef: Schema.String,
  status: Schema.String,
  maxParallel: Schema.Number,
  mergeSessionID: optString,
  startedAt: Schema.String,
  finishedAt: optString,
  error: optString,
  items: Schema.Array(runItemViewSchema),
  queue: Schema.Array(mergeEntryViewSchema),
});

export const preflightViewSchema = Schema.Struct({
  ok: Schema.Boolean,
  blockers: Schema.Array(Schema.String),
  baseRef: optString,
  maxParallel: Schema.optional(Schema.Number),
  items: Schema.Array(
    Schema.Struct({
      itemID: Schema.String,
      title: Schema.String,
      planID: Schema.String,
      planTitle: Schema.String,
      deps: Schema.Array(Schema.String),
    }),
  ),
});

export const runStartViewSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: optString,
  runID: optString,
});

export const runIDInputSchema = Schema.Struct({ runID: Schema.String });

export const runProjectInputSchema = Schema.Struct({
  initiativeID: Schema.String,
  directory: Schema.String,
});

export const runRetryInputSchema = Schema.Struct({
  runID: Schema.String,
  itemID: Schema.String,
});

export const runSettingsInputSchema = Schema.Struct({
  initiativeID: Schema.String,
  baseBranch: Schema.optional(Schema.NullOr(Schema.String)),
  maxParallel: Schema.optional(Schema.Number),
  verifyCommand: Schema.optional(Schema.NullOr(Schema.String)),
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
    setPlanWorkItem: {
      input: Schema.toStandardSchemaV1(setPlanWorkItemInputSchema),
      output: Schema.toStandardSchemaV1(opResultSchema),
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
    listInitiatives: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Schema.Array(initiativeSchema)),
    },
    createInitiative: {
      input: Schema.toStandardSchemaV1(createInitiativeInputSchema),
      output: Schema.toStandardSchemaV1(initiativeResultSchema),
    },
    updateInitiative: {
      input: Schema.toStandardSchemaV1(updateInitiativeInputSchema),
      output: Schema.toStandardSchemaV1(initiativeResultSchema),
    },
    addInitiativeRepo: {
      input: Schema.toStandardSchemaV1(initiativeRepoInputSchema),
      output: Schema.toStandardSchemaV1(initiativeResultSchema),
    },
    removeInitiativeRepo: {
      input: Schema.toStandardSchemaV1(removeInitiativeRepoInputSchema),
      output: Schema.toStandardSchemaV1(initiativeResultSchema),
    },
    setInitiativePrimary: {
      input: Schema.toStandardSchemaV1(initiativeRepoRefSchema),
      output: Schema.toStandardSchemaV1(initiativeResultSchema),
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
    placeWorkItem: {
      input: Schema.toStandardSchemaV1(placeWorkItemInputSchema),
      output: Schema.toStandardSchemaV1(workItemResultSchema),
    },
    getWorkGraph: {
      input: Schema.toStandardSchemaV1(workGraphInputSchema),
      output: Schema.toStandardSchemaV1(workGraphSchema),
    },
    deleteWorkItem: {
      input: Schema.toStandardSchemaV1(workItemIdInputSchema),
      output: Schema.toStandardSchemaV1(opResultSchema),
    },
    deleteInitiative: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String })),
      output: Schema.toStandardSchemaV1(opResultSchema),
    },
    setWorkItemRepo: {
      input: Schema.toStandardSchemaV1(setWorkItemRepoInputSchema),
      output: Schema.toStandardSchemaV1(workItemResultSchema),
    },
    ensureInitiativeRepo: {
      input: Schema.toStandardSchemaV1(ensureInitiativeRepoInputSchema),
      output: Schema.toStandardSchemaV1(ensureRepoResultSchema),
    },
    addWorkItemDep: {
      input: Schema.toStandardSchemaV1(workItemDepInputSchema),
      output: Schema.toStandardSchemaV1(opResultSchema),
    },
    setWorkItemParent: {
      input: Schema.toStandardSchemaV1(setWorkItemParentInputSchema),
      output: Schema.toStandardSchemaV1(opResultSchema),
    },
    removeWorkItemDep: {
      input: Schema.toStandardSchemaV1(workItemDepInputSchema),
      output: Schema.toStandardSchemaV1(opResultSchema),
    },
    runPreflight: {
      input: Schema.toStandardSchemaV1(runProjectInputSchema),
      output: Schema.toStandardSchemaV1(preflightViewSchema),
    },
    runStart: {
      input: Schema.toStandardSchemaV1(runProjectInputSchema),
      output: Schema.toStandardSchemaV1(runStartViewSchema),
    },
    runActive: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ initiativeID: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.NullOr(runViewSchema)),
    },
    runGet: {
      input: Schema.toStandardSchemaV1(runIDInputSchema),
      output: Schema.toStandardSchemaV1(Schema.NullOr(runViewSchema)),
    },
    runCancel: {
      input: Schema.toStandardSchemaV1(runIDInputSchema),
      output: Schema.toStandardSchemaV1(opResultSchema),
    },
    runRetry: {
      input: Schema.toStandardSchemaV1(runRetryInputSchema),
      output: Schema.toStandardSchemaV1(opResultSchema),
    },
    runSettings: {
      input: Schema.toStandardSchemaV1(runSettingsInputSchema),
      output: Schema.toStandardSchemaV1(initiativeResultSchema),
    },
  },
  events: {
    changed: { schema: Schema.toStandardSchemaV1(planChangeSchema) },
  },
});
