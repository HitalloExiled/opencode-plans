/**
 * initiative — tool definitions (registration lives in ./index.ts under the
 * "initiative" namespace).
 *
 * An initiative is the user's grouping of needs across repositories. The agent
 * creates, lists and reads them here; editing (rename, description, macro view)
 * stays in the panel. Work items are created with `work.save({ initiativeID })`.
 */

import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { notificationLocale, type NotificationLocale } from "./src/notifications.js";
import {
  createInitiative,
  getInitiative,
  initiativeMap,
  listInitiatives,
  listWorkItems,
  requireStore,
} from "./src/store.js";
import { emitPlanChange } from "./src/plan-events.js";
import { renderInitiativeMap } from "./src/work-map.js";

type ToolResult = { content: string; metadata?: Record<string, unknown> };
type Ctx = Plugin.Context;

/** Catalog group label. Code Mode truncates this at ~119 characters. */
export const INITIATIVE_NAMESPACE = {
  name: "initiative",
  description: "User initiatives: groups of needs across repositories.",
} as const;

function fail(error: string): ToolResult {
  return { content: `❌ ${error}`, metadata: { rejected: true } };
}

const listInput = z.object({});

const createInput = z.object({
  name: z.string().min(1).max(200).describe("Initiative name."),
  description: z.string().max(2000).optional().describe("Optional description."),
});

const getInput = z.object({
  id: z.string().min(1).describe("Initiative id."),
});

type GetText = {
  overview: string;
  items: string;
  repos: string;
  base: string;
  primary: string;
  blockedBy: string;
  more: string;
  empty: string;
};

const GET_TEXT: Record<NotificationLocale, GetText> = {
  "en-us": {
    overview: "Macro view",
    items: "Items",
    repos: "Repositories",
    base: "Base branch",
    primary: "primary",
    blockedBy: "blocked by",
    more: "+{0} more items",
    empty: "No work items yet.",
  },
  "pt-br": {
    overview: "Visão macro",
    items: "Itens",
    repos: "Repositórios",
    base: "Branch base",
    primary: "principal",
    blockedBy: "bloqueado por",
    more: "+{0} itens",
    empty: "Nenhum work item ainda.",
  },
};

async function serverLocale(ctx: Ctx): Promise<NotificationLocale> {
  try {
    return notificationLocale((await ctx.storage.get("locale")) as string | null | undefined);
  } catch {
    return "en-us";
  }
}

export function listInitiativeTool(ctx: Ctx) {
  return {
    name: "list",
    description: "List initiatives: id, name, repositories and item counts.",
    input: listInput,
    async execute(_input: z.infer<typeof listInput>): Promise<ToolResult> {
      try {
        const store = await requireStore();
        const initiatives = listInitiatives(store.db);
        if (initiatives.length === 0) {
          return {
            content: "Nenhuma iniciativa ainda. Crie a primeira com initiative.create.",
            metadata: { count: 0 },
          };
        }
        const lines = initiatives.map((initiative) => {
          const items = listWorkItems(store.db, initiative.id).length;
          return `- ${initiative.name} (id=${initiative.id}, ${items} itens, ${initiative.repos.length} repositórios)`;
        });
        return {
          content: [`Initiatives (${initiatives.length}):`, ...lines].join("\n"),
          metadata: {
            count: initiatives.length,
            initiativeIDs: initiatives.map((initiative) => initiative.id),
          },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function createInitiativeTool(ctx: Ctx) {
  return {
    name: "create",
    description: "Create an initiative from a name and an optional description.",
    input: createInput,
    async execute(input: z.infer<typeof createInput>): Promise<ToolResult> {
      try {
        const store = await requireStore();
        const result = createInitiative(store.db, {
          name: input.name,
          description: input.description,
        });
        if (!result.ok) return fail(result.error);
        emitPlanChange({ sessionID: "" });
        return {
          content: `Iniciativa "${result.initiative.name}" criada (id=${result.initiative.id}). Repositórios entram pelo Planejar; use work.save com initiativeID para criar itens.`,
          metadata: { initiativeID: result.initiative.id, name: result.initiative.name },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/**
 * The macro view plus the work map: what a planning session needs to place a
 * card in the initiative without already having the seed.
 */
export function getInitiativeTool(ctx: Ctx) {
  return {
    name: "get",
    description: "Read an initiative: macro view, repositories and the work map.",
    input: getInput,
    async execute(input: z.infer<typeof getInput>): Promise<ToolResult> {
      try {
        const store = await requireStore();
        const initiative = getInitiative(store.db, input.id);
        if (!initiative) return fail(`iniciativa não encontrada: ${input.id}`);
        const text = GET_TEXT[await serverLocale(ctx)];
        const items = initiativeMap(store.db, initiative.id);
        const map = renderInitiativeMap(items, { blockedBy: text.blockedBy, more: text.more });
        const repos = initiative.repos.length
          ? initiative.repos
              .map((repo) => `${repo.directory}${repo.primary ? ` (${text.primary})` : ""}`)
              .join(", ")
          : "—";
        const lines = [
          `# ${initiative.name} (id=${initiative.id})`,
          ...(initiative.description ? ["", initiative.description] : []),
          "",
          `${text.repos}: ${repos}`,
          ...(initiative.base_branch ? [`${text.base}: ${initiative.base_branch}`] : []),
          ...(initiative.overview ? ["", `## ${text.overview}`, "", initiative.overview] : []),
          "",
          `## ${text.items} (${items.length})`,
          ...(map ? ["", map] : ["", text.empty]),
        ];
        return {
          content: lines.join("\n"),
          metadata: {
            initiativeID: initiative.id,
            items: items.length,
            itemIDs: items.map((item) => item.id),
            hasOverview: Boolean(initiative.overview),
          },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
