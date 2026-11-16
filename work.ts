/**
 * work — tool definitions (registration lives in ./index.ts under the "work"
 * namespace).
 *
 * Work items are the user's needs: a title and a body, grouped by the user's
 * project. They carry no steps; the plan is the how. These tools are read-only
 * today (list/get); writes come with their own USs.
 */

import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import {
  getPlanByWorkItem,
  getProject,
  getWorkItem,
  listWorkItems,
  requireStore,
  resolveProject,
  workItemChildren,
  workItemDeps,
  type WorkItemStatus,
} from "./src/store.js";
import { renderWorkItemDetail, renderWorkItemList } from "./src/work-render.js";

type ToolResult = { content: string; metadata?: Record<string, unknown> };
type Ctx = Plugin.Context;

/** Catalog group label. Code Mode truncates this at ~119 characters. */
export const WORK_NAMESPACE = {
  name: "work",
  description: "Work items (needs): list, read and plan backlog across the project.",
} as const;

function fail(error: string): ToolResult {
  return { content: `❌ ${error}`, metadata: { rejected: true } };
}

/** The user's project is resolved by directory, not by the OpenCode project id. */
function workspaceDirectory(ctx: Ctx): string {
  return String(ctx.location.project.canonical ?? ctx.location.directory);
}

const WORK_STATUS = z.enum(["backlog", "ready", "doing", "blocked", "done", "dropped"]);

const listInput = z.object({
  status: z
    .union([WORK_STATUS, z.literal("all")])
    .default("all")
    .describe("Status filter; hides dropped by default."),
  limit: z.number().int().min(1).max(100).optional().describe("Max items (default 50)."),
});

// Same shape as plans.get: a bare id is accepted, the schema stays an object.
const getInput = z.preprocess(
  (value) => (typeof value === "string" ? { id: value } : value),
  z.object({
    id: z.string().min(1).describe("Work item id."),
  }),
);

export function listWorkTool(ctx: Ctx) {
  return {
    name: "list",
    description: "List work items of this project: id, title, status, rank, deps and plan.",
    input: listInput,
    async execute(input: z.infer<typeof listInput>): Promise<ToolResult> {
      try {
        const store = await requireStore();
        const resolved = resolveProject(store.db, workspaceDirectory(ctx));
        if (!resolved) {
          return {
            content:
              "Nenhum projeto de trabalho para este workspace. Crie a primeira necessidade com work.save; o projeto nasce no primeiro item.",
            metadata: { count: 0 },
          };
        }

        const status = input.status ?? "all";
        const limit = input.limit ?? 50;
        const items = listWorkItems(store.db, resolved.project.id)
          .filter((item) => (status === "all" ? item.status !== "dropped" : item.status === status))
          .slice(0, limit);

        const extras = new Map<
          string,
          { blockedBy: ReturnType<typeof workItemDeps>["blockedBy"]; plan: ReturnType<typeof getPlanByWorkItem> }
        >();
        for (const item of items) {
          extras.set(item.id, {
            blockedBy: workItemDeps(store.db, item.id).blockedBy,
            plan: getPlanByWorkItem(store.db, item.id),
          });
        }

        return {
          content: renderWorkItemList({
            projectName: resolved.project.name,
            status,
            items,
            extras,
          }),
          metadata: { count: items.length, projectID: resolved.project.id, itemIDs: items.map((item) => item.id) },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function getWorkTool(ctx: Ctx) {
  return {
    name: "get",
    description: "Read one work item: need body, deps, parent and plan. Bare id accepted.",
    input: getInput,
    async execute(input: z.infer<typeof getInput>): Promise<ToolResult> {
      try {
        const store = await requireStore();
        const item = getWorkItem(store.db, input.id);
        if (!item) return fail(`work item não encontrado: ${input.id}`);
        const project = getProject(store.db, item.project_id);
        if (!project) return fail(`projeto não encontrado: ${item.project_id}`);
        const deps = workItemDeps(store.db, item.id);
        const parent = item.parent_id ? getWorkItem(store.db, item.parent_id) : undefined;
        const plan = getPlanByWorkItem(store.db, item.id);

        return {
          content: renderWorkItemDetail({
            item,
            projectName: project.name,
            blockedBy: deps.blockedBy,
            blocks: deps.blocks,
            parent,
            children: workItemChildren(store.db, item.id),
            plan,
          }),
          metadata: {
            itemID: item.id,
            projectID: project.id,
            status: item.status as WorkItemStatus,
            planID: plan?.id ?? null,
          },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
