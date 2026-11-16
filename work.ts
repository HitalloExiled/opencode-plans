/**
 * work — tool definitions (registration lives in ./index.ts under the "work"
 * namespace).
 *
 * Work items are the user's needs: a title and a body, grouped by the user's
 * project. They carry no steps; the plan is the how. These tools are read-only
 * today (list/get); writes come with their own USs.
 */

import { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { z } from "zod";
import {
  addWorkItemDep,
  createWorkItem,
  ensureInitiativeForDirectory,
  getPlanByWorkItem,
  getInitiative,
  getWorkItem,
  listWorkItems,
  moveWorkItem,
  removeWorkItemDep,
  requireStore,
  resolveInitiative,
  setWorkItemParent,
  setWorkItemStatus,
  updateWorkItem,
  workItemChildren,
  workItemDeps,
  type WorkItemStatus,
} from "./src/store.js";
import { emitPlanChange } from "./src/plan-events.js";
import { renderWorkItemDetail, renderWorkItemLine, renderWorkItemList } from "./src/work-render.js";
import { MAX_ITEMS_PER_REQUEST, claimItems, findDuplicateItem, type BudgetEntry } from "./src/work-write.js";

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
  initiativeID: z.string().min(1).optional().describe("Defaults to the workspace initiative."),
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
    description: "List work items of an initiative: id, title, status, deps and plan.",
    input: listInput,
    async execute(input: z.infer<typeof listInput>): Promise<ToolResult> {
      try {
        const store = await requireStore();
        const explicit = input.initiativeID ? getInitiative(store.db, input.initiativeID) : undefined;
        if (input.initiativeID && !explicit) {
          return fail(`iniciativa não encontrada: ${input.initiativeID}`);
        }
        const resolved = explicit
          ? { initiative: explicit, repo: undefined }
          : resolveInitiative(store.db, workspaceDirectory(ctx));
        if (!resolved) {
          return {
            content:
              "Nenhum projeto de trabalho para este workspace. Crie a primeira necessidade com work.save; o projeto nasce no primeiro item.",
            metadata: { count: 0 },
          };
        }

        const status = input.status ?? "all";
        const limit = input.limit ?? 50;
        const items = listWorkItems(store.db, resolved.initiative.id)
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
            initiativeName: resolved.initiative.name,
            status,
            items,
            extras,
          }),
          metadata: { count: items.length, initiativeID: resolved.initiative.id, itemIDs: items.map((item) => item.id) },
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
        const initiative = getInitiative(store.db, item.initiative_id);
        if (!initiative) return fail(`iniciativa não encontrada: ${item.initiative_id}`);
        const deps = workItemDeps(store.db, item.id);
        const parent = item.parent_id ? getWorkItem(store.db, item.parent_id) : undefined;
        const plan = getPlanByWorkItem(store.db, item.id);

        return {
          content: renderWorkItemDetail({
            item,
            initiativeName: initiative.name,
            blockedBy: deps.blockedBy,
            blocks: deps.blocks,
            parent,
            children: workItemChildren(store.db, item.id),
            plan,
          }),
          metadata: {
            itemID: item.id,
            initiativeID: initiative.id,
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

/** Agents allowed to close an item: the planner decides, the executor proposes. */
const CLOSING_AGENTS = new Set(["planner", "plan"]);

/** Per-request creation budget, keyed by session + message. */
const budgets = new Map<string, BudgetEntry>();

const needBody = z.string().max(8000).optional().describe("Need body (data).");

const saveInput = z.object({
  initiativeID: z.string().min(1).optional().describe("Defaults to the workspace initiative."),
  items: z
    .array(
      z.object({
        title: z.string().min(1).max(200).describe("Need title."),
        body: needBody,
        parentID: z.string().optional().describe("Root parent id."),
      }),
    )
    .min(1)
    .max(MAX_ITEMS_PER_REQUEST)
    .describe("Needs to create."),
});

const updateInput = z.object({
  id: z.string().min(1).describe("Work item id."),
  status: WORK_STATUS.optional().describe("New status (transitions apply)."),
  title: z.string().min(1).max(200).optional().describe("New title."),
  body: needBody,
  parentID: z.string().nullable().optional().describe("Root parent; null clears."),
  blockedBy: z.array(z.string()).optional().describe("Replace the dependency set."),
  move: z.enum(["up", "down"]).optional().describe("Move one place in status."),
});

export function saveWorkTool(ctx: Ctx) {
  return {
    name: "save",
    description: "Create up to 3 needs in an initiative; dedupes by title and parent.",
    input: saveInput,
    async execute(input: z.infer<typeof saveInput>, toolCtx: ToolContext): Promise<ToolResult> {
      try {
        const store = await requireStore();
        const key = `${String(toolCtx.sessionID)}:${String(toolCtx.messageID)}`;
        // Reserve the whole batch up front: a partial claim would let the next
        // call of the same message see an inconsistent budget.
        if (claimItems(budgets, key, input.items.length, Date.now()) === undefined) {
          return fail(
            `limite de ${MAX_ITEMS_PER_REQUEST} work items por pedido; agrupe as necessidades restantes no próximo pedido`,
          );
        }

        // An explicit initiative skips the workspace resolution: the agent is
        // filing needs for an initiative no directory owns.
        const explicit = input.initiativeID ? getInitiative(store.db, input.initiativeID) : undefined;
        if (input.initiativeID && !explicit) {
          return fail(`iniciativa não encontrada: ${input.initiativeID}`);
        }
        let initiativeID: string;
        let initiativeName: string;
        let targetRepoID: string | undefined;
        if (explicit) {
          initiativeID = explicit.id;
          initiativeName = explicit.name;
          targetRepoID = (explicit.repos.find((repo) => repo.primary) ?? explicit.repos[0])?.id;
        } else {
          const ensured = ensureInitiativeForDirectory(store.db, workspaceDirectory(ctx));
          if (!ensured.ok) return fail(ensured.error);
          initiativeID = ensured.initiative.id;
          initiativeName = ensured.initiative.name;
          targetRepoID = ensured.repo.id;
        }

        const results: { id: string; title: string; status: WorkItemStatus; existing: boolean }[] = [];
        for (const entry of input.items) {
          const parentID = entry.parentID ?? null;
          if (parentID) {
            const parent = getWorkItem(store.db, parentID);
            if (!parent) return fail(`work item não encontrado: ${parentID}`);
            if (parent.initiative_id !== initiativeID) {
              return fail("os itens precisam pertencer à mesma iniciativa");
            }
            if (parent.parent_id) {
              return fail("profundidade máxima de 1: o pai escolhido já é filho de outro item");
            }
          }

          const duplicate = findDuplicateItem(listWorkItems(store.db, initiativeID), {
            title: entry.title,
            parentID,
          });
          if (duplicate) {
            results.push({
              id: duplicate.id,
              title: duplicate.title,
              status: duplicate.status,
              existing: true,
            });
            continue;
          }

          const created = createWorkItem(store.db, {
            initiativeID,
            repoID: targetRepoID,
            title: entry.title,
            body: entry.body,
            // The agent never writes as the user.
            origin: "agent",
          });
          if (!created.ok) return fail(created.error);
          if (parentID) {
            const parented = setWorkItemParent(store.db, { id: created.item.id, parentID });
            if (!parented.ok) return fail(parented.error);
          }
          results.push({
            id: created.item.id,
            title: created.item.title,
            status: created.item.status,
            existing: false,
          });
        }

        emitPlanChange({ sessionID: String(toolCtx.sessionID) });
        const createdCount = results.filter((item) => !item.existing).length;
        return {
          content: [
            `Work items (iniciativa "${initiativeName}"): ${createdCount} criados, ${results.length - createdCount} existentes`,
            ...results.map(
              (item) =>
                `- ${item.existing ? "existente" : "criado"}: ${item.title} (id=${item.id}, status=${item.status})`,
            ),
            "",
            "Use work.update para mudar status, ordem, pai ou dependências.",
          ].join("\n"),
          metadata: {
            initiativeID,
            created: createdCount,
            existing: results.length - createdCount,
            itemIDs: results.map((item) => item.id),
          },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function updateWorkTool(ctx: Ctx) {
  return {
    name: "update",
    description: "Update a work item: status, title, body, parent, deps or order.",
    input: updateInput,
    async execute(input: z.infer<typeof updateInput>, toolCtx: ToolContext): Promise<ToolResult> {
      try {
        const store = await requireStore();
        const item = getWorkItem(store.db, input.id);
        if (!item) return fail(`work item não encontrado: ${input.id}`);

        const closing = input.status === "done" || input.status === "dropped";
        if (closing && !CLOSING_AGENTS.has(String(toolCtx.agent))) {
          return fail(
            "done/dropped só por decisão do planner ou do usuário; proponha o aceite e deixe o item em doing",
          );
        }

        if (input.title !== undefined || input.body !== undefined) {
          const edited = updateWorkItem(store.db, { id: input.id, title: input.title, body: input.body });
          if (!edited.ok) return fail(edited.error);
        }

        if (input.parentID !== undefined) {
          const parented = setWorkItemParent(store.db, { id: input.id, parentID: input.parentID });
          if (!parented.ok) return fail(parented.error);
        }

        if (input.status !== undefined) {
          const moved = setWorkItemStatus(store.db, { id: input.id, status: input.status });
          if (!moved.ok) return fail(moved.error);
        }

        if (input.blockedBy !== undefined) {
          const current = new Set(workItemDeps(store.db, input.id).blockedBy.map((dep) => dep.id));
          const wanted = new Set(input.blockedBy);
          for (const dep of current) {
            if (wanted.has(dep)) continue;
            const removed = removeWorkItemDep(store.db, { itemID: input.id, blocksID: dep });
            if (!removed.ok) return fail(removed.error);
          }
          for (const dep of wanted) {
            if (current.has(dep)) continue;
            const added = addWorkItemDep(store.db, { itemID: input.id, blocksID: dep });
            if (!added.ok) return fail(added.error);
          }
        }

        if (input.move !== undefined) {
          const moved = moveWorkItem(store.db, { id: input.id, direction: input.move });
          if (!moved.ok) return fail(moved.error);
        }

        emitPlanChange({ sessionID: String(toolCtx.sessionID) });
        const updated = getWorkItem(store.db, input.id);
        if (!updated) return fail(`work item não encontrado após a atualização: ${input.id}`);
        const deps = workItemDeps(store.db, updated.id);
        const plan = getPlanByWorkItem(store.db, updated.id);

        return {
          content: [
            "Work item atualizado.",
            renderWorkItemLine(updated, { blockedBy: deps.blockedBy, plan }),
          ].join("\n"),
          metadata: {
            itemID: updated.id,
            status: updated.status,
            planID: plan?.id ?? null,
          },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
