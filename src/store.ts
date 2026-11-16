/**
 * Plans store — the single data layer behind both the GUI panel and the
 * `plans.*` server tools.
 *
 * It reads AND writes `plans.db` directly (no external CLI): the schema and
 * migrations are applied on first open (idempotent, gated by
 * `PRAGMA user_version`), and every mutation is plain SQL.
 *
 * SQLite access goes through the runtime's built-in `node:sqlite`
 * (`DatabaseSync`): in-process, synchronous and available in Bun, the
 * Electron main process and plain Node. That is the same backend the notes
 * plugin uses, so the GUI main process and the Bun server tools share one
 * implementation.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { WORK_ITEM_TRANSITIONS } from "./gui/contract.js";
import { computeImplicitDeps, type FootprintItem } from "./work-footprint.js";

import {
  buildTemplate,
  cleanStepText,
  extractSteps,
  normalizeStepText,
  renderPlanBody,
  STEPS_PLACEHOLDER,
} from "./plan-body.js";

/* ------------------------------------------------------------------ */
/* DB path                                                             */
/* ------------------------------------------------------------------ */

function expanduser(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : p;
}

/** `$PLANS_DB`, else `$XDG_DATA_HOME/opencode/plans/plans.db`. */
export function plansDbPath(): string {
  const override = process.env.PLANS_DB;
  if (override) return expanduser(override);
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "plans", "plans.db");
}

/* ------------------------------------------------------------------ */
/* Minimal synchronous DB interface (node:sqlite shaped)               */
/* ------------------------------------------------------------------ */

export type DbStatement = {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
};

export type Db = {
  prepare(sql: string): DbStatement;
  exec?(sql: string): void;
  close?(): void;
};

/* ------------------------------------------------------------------ */
/* Backend: native node:sqlite (DatabaseSync)                          */
/* ------------------------------------------------------------------ */

type NativeStatement = {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
};

type NativeDatabase = {
  prepare(sql: string): NativeStatement;
  exec(sql: string): void;
  close(): void;
};

type NativeModule = {
  DatabaseSync?: new (path: string, options?: { timeout?: number }) => NativeDatabase;
  default?: { DatabaseSync?: new (path: string, options?: { timeout?: number }) => NativeDatabase };
};

async function nativeDb(path: string): Promise<Db> {
  const mod = (await import("node:sqlite")) as NativeModule;
  const Database = mod.DatabaseSync ?? mod.default?.DatabaseSync;
  if (typeof Database !== "function") {
    throw new Error("node:sqlite não expõe DatabaseSync");
  }

  const db = new Database(path, { timeout: 5000 });
  // The GUI main process and the Bun server tools use separate connections.
  // WAL lets readers keep working while the other side writes.
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    /* best effort; timeout still handles busy writers */
  }

  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return {
        get(...params: unknown[]) {
          return statement.get(...params) ?? undefined;
        },
        all(...params: unknown[]) {
          return statement.all(...params);
        },
        run(...params: unknown[]) {
          const r = statement.run(...params);
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        },
      } satisfies DbStatement;
    },
    exec(sql: string) {
      db.exec(sql);
    },
    close() {
      db.close();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Schema DDL (embedded; all idempotent via IF NOT EXISTS)             */
/* ------------------------------------------------------------------ */

export const SCHEMA_VERSION = 8;

const BASE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    project_directory TEXT NOT NULL,
    session_id TEXT NOT NULL,
    message_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    work_item_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(project_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_plans_session ON plans(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS plan_steps (
    plan_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    step_id TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (plan_id, position)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id, position)`,
  // v3 — work items (US-01): a work item belongs to the user's INITIATIVE,
  // which groups N repositories. `work_items.initiative_id` is ours, NOT the
  // OpenCode project id stored in `plans.project_id`.
  `CREATE TABLE IF NOT EXISTS initiatives (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    base_branch TEXT,
    max_parallel INTEGER NOT NULL DEFAULT 2,
    verify_command TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS initiative_repos (
    id TEXT PRIMARY KEY,
    initiative_id TEXT NOT NULL,
    directory TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_initiative_repos_initiative ON initiative_repos(initiative_id, position)`,
  `CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    initiative_id TEXT NOT NULL,
    repo_id TEXT,
    parent_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    rank INTEGER NOT NULL,
    origin TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_work_items_initiative ON work_items(initiative_id)`,
  `CREATE INDEX IF NOT EXISTS idx_work_items_initiative_status ON work_items(initiative_id, status, rank)`,
  `CREATE INDEX IF NOT EXISTS idx_work_items_repo ON work_items(repo_id)`,
  // v4 — dependencies: `item_id` is blocked by `blocks_id`. `kind`/`reason`
  // are ready for the implicit dependencies of the project runner (F4).
  `CREATE TABLE IF NOT EXISTS work_item_deps (
    item_id TEXT NOT NULL,
    blocks_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'explicit',
    reason TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (item_id, blocks_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_work_item_deps_item ON work_item_deps(item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_work_item_deps_blocks ON work_item_deps(blocks_id)`,
  // v6 — initiative runs (F4): a run executes an initiative graph in
  // parallel, each item isolated in its own branch/worktree and merged once.
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    initiative_id TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    status TEXT NOT NULL,
    max_parallel INTEGER NOT NULL DEFAULT 2,
    merge_session_id TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_active ON runs(initiative_id) WHERE status IN ('running', 'interrupted')`,
  `CREATE INDEX IF NOT EXISTS idx_runs_initiative ON runs(initiative_id, started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS run_items (
    run_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    status TEXT NOT NULL,
    plan_id TEXT,
    branch TEXT,
    worktree TEXT,
    session_id TEXT,
    started_at TEXT,
    finished_at TEXT,
    merged_sha TEXT,
    error TEXT,
    PRIMARY KEY (run_id, work_item_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_run_items_status ON run_items(run_id, status)`,
  `CREATE TABLE IF NOT EXISTS merge_queue (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    status TEXT NOT NULL,
    enqueued_at TEXT NOT NULL,
    claimed_at TEXT,
    finished_at TEXT,
    error TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_queue_item ON merge_queue(run_id, work_item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_merge_queue_fifo ON merge_queue(run_id, status, enqueued_at)`,
  `CREATE TABLE IF NOT EXISTS plan_touches (
    plan_id TEXT NOT NULL,
    path TEXT NOT NULL,
    PRIMARY KEY (plan_id, path)
  )`,
];

function apply(db: Db, statements: readonly string[]): void {
  for (const sql of statements) db.prepare(sql).run();
}

// v2 — `abandoned` became `archived`. Values are rewritten in place so the
// tool/UI status union has a single spelling.
const MIGRATION_002 = [`UPDATE plans SET status = 'archived' WHERE status = 'abandoned'`];

function hasTable(db: Db, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return row !== undefined;
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name?: string }[];
  return rows.some((row) => row.name === column);
}

export function initSchema(db: Db): void {
  // v7 — rename BEFORE applying BASE_SCHEMA: creating the new empty tables
  // first would skip the rename and strand the old rows in `projects`.
  if (hasTable(db, "projects")) {
    if (hasTable(db, "initiatives")) {
      // A previous aborted migration can leave empty new tables behind; they
      // carry no data, so the old table wins.
      const rows = (db.prepare("SELECT COUNT(*) AS c FROM initiatives").get() as { c?: number }).c ?? 0;
      if (rows === 0) {
        db.prepare("DROP TABLE initiatives").run();
        if (hasTable(db, "initiative_repos")) {
          const repos = (db.prepare("SELECT COUNT(*) AS c FROM initiative_repos").get() as { c?: number }).c ?? 0;
          if (repos === 0) db.prepare("DROP TABLE initiative_repos").run();
        }
      }
    }
    if (!hasTable(db, "initiatives")) {
      db.prepare("ALTER TABLE projects RENAME TO initiatives").run();
    }
  }
  if (hasTable(db, "project_locations") && !hasTable(db, "initiative_repos")) {
    db.prepare("ALTER TABLE project_locations RENAME TO initiative_repos").run();
  }
  if (hasTable(db, "initiative_repos") && hasColumn(db, "initiative_repos", "project_id")) {
    db.prepare("ALTER TABLE initiative_repos RENAME COLUMN project_id TO initiative_id").run();
  }
  if (hasTable(db, "work_items") && hasColumn(db, "work_items", "project_id")) {
    db.prepare("ALTER TABLE work_items RENAME COLUMN project_id TO initiative_id").run();
  }
  if (hasTable(db, "work_items") && hasColumn(db, "work_items", "location_id")) {
    db.prepare("ALTER TABLE work_items RENAME COLUMN location_id TO repo_id").run();
  }
  if (hasTable(db, "runs") && hasColumn(db, "runs", "project_id")) {
    db.prepare("ALTER TABLE runs RENAME COLUMN project_id TO initiative_id").run();
  }

  apply(db, BASE_SCHEMA);
  const current = schemaVersion(db);
  if (current < 2) {
    db.prepare("BEGIN").run();
    try {
      apply(db, MIGRATION_002);
      db.prepare("COMMIT").run();
    } catch (error) {
      try {
        db.prepare("ROLLBACK").run();
      } catch {
        /* best effort */
      }
      throw error;
    }
  }
  // v5 — the plan -> work item link. The index comes after the column so an
  // existing v4 database migrates in place.
  if (!hasColumn(db, "plans", "work_item_id")) {
    db.prepare("ALTER TABLE plans ADD COLUMN work_item_id TEXT").run();
  }
  db.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_work_item ON plans(work_item_id) WHERE work_item_id IS NOT NULL",
  ).run();

  // Old index names follow the renamed table; replace them with the new ones.
  db.prepare("DROP INDEX IF EXISTS idx_project_locations_project").run();
  db.prepare("DROP INDEX IF EXISTS idx_work_items_project").run();
  db.prepare("DROP INDEX IF EXISTS idx_work_items_project_status").run();
  db.prepare("DROP INDEX IF EXISTS idx_work_items_location").run();
  db.prepare("DROP INDEX IF EXISTS idx_runs_project").run();
  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_initiative_repos_initiative ON initiative_repos(initiative_id, position)",
  ).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_work_items_initiative ON work_items(initiative_id)").run();
  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_work_items_initiative_status ON work_items(initiative_id, status, rank)",
  ).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_work_items_repo ON work_items(repo_id)").run();
  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_runs_initiative ON runs(initiative_id, started_at DESC)",
  ).run();

  // v6 — per-initiative run settings (fresh databases already have them).
  if (!hasColumn(db, "initiatives", "base_branch")) {
    db.prepare("ALTER TABLE initiatives ADD COLUMN base_branch TEXT").run();
  }
  if (!hasColumn(db, "initiatives", "max_parallel")) {
    db.prepare("ALTER TABLE initiatives ADD COLUMN max_parallel INTEGER NOT NULL DEFAULT 2").run();
  }
  if (!hasColumn(db, "initiatives", "verify_command")) {
    db.prepare("ALTER TABLE initiatives ADD COLUMN verify_command TEXT").run();
  }
  if (!hasColumn(db, "initiatives", "description")) {
    db.prepare("ALTER TABLE initiatives ADD COLUMN description TEXT").run();
  }
  db.prepare(`PRAGMA user_version = ${SCHEMA_VERSION}`).run();
}

export function schemaVersion(db: Db): number {
  const row = db.prepare("PRAGMA user_version").get() as number | { user_version?: number } | null;
  return typeof row === "number" ? row : (row?.user_version ?? 0);
}

/* ------------------------------------------------------------------ */
/* Connection (memoized)                                               */
/* ------------------------------------------------------------------ */

export type Store = { db: Db; driver: "native" };

let storePromise: Promise<{ store: Store | null; reason: string }> | null = null;

function openDbPath(): string {
  const path = plansDbPath();
  const parent = path.slice(0, path.lastIndexOf("/"));
  if (parent) mkdirSync(parent, { recursive: true });
  return path;
}

function describeRuntime(): string {
  const g = globalThis as { bun?: { version?: string } };
  const parts: string[] = [];
  if (typeof process !== "undefined" && process.version) parts.push("node=" + process.version);
  if (g.bun?.version) parts.push("bun=" + g.bun.version);
  return parts.length ? parts.join(" ") : "unknown";
}

async function openStore(): Promise<{ store: Store | null; reason: string }> {
  try {
    const db = await nativeDb(openDbPath());
    initSchema(db);
    return { store: { db, driver: "native" }, reason: "" };
  } catch (err) {
    return {
      store: null,
      reason:
        `sqlite indisponível (${describeRuntime()}; node:sqlite): ` +
        (err instanceof Error ? err.message : String(err)),
    };
  }
}

export function getStore(): Promise<{ store: Store | null; reason: string }> {
  if (storePromise === null) storePromise = openStore();
  return storePromise;
}

export async function requireStore(): Promise<Store> {
  const { store, reason } = await getStore();
  if (store === null) throw new Error(reason);
  return store;
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type PlanStatus = "active" | "done" | "archived" | "superseded";
export type StepStatus = "todo" | "doing" | "done";

export type PlanRow = {
  id: string;
  project_id: string;
  project_directory: string;
  session_id: string;
  message_id: string | null;
  title: string;
  body: string;
  status: PlanStatus;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  work_item_id: string | null;
};

export type StepRow = {
  plan_id: string;
  position: number;
  step_id: string;
  text: string;
  status: StepStatus;
};

export type Plan = PlanRow & { steps: StepRow[]; /** Files/globs the plan touches (F4). */ touches?: string[] };

export type ParsedStep = { text: string; status: StepStatus };

export type WriteError = { ok: false; error: string };
export type SaveOk = { ok: true; plan: Plan };
export type DeleteOk = { ok: true; plan: Plan };

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

export function nowTimestamp(): string {
  return new Date().toISOString();
}

const TITLE_HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

function isFenceLine(line: string): boolean {
  return /^\s*```/.test(line);
}

/** Strip the light Markdown the model puts around a checklist item. */
export function cleanStep(text: string): string {
  return cleanStepText(text);
}

function truncate(text: string, max: number): string {
  const value = text.trim().replace(/[:：]\s*$/, "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Extract the plan's checklist (exact text) from a body. */
export function parseSteps(body: string): ParsedStep[] {
  return extractSteps(body).map((step) => ({ text: step.text, status: step.status }));
}

/** First heading, else first non-empty line; never empty. */
export function extractTitle(body: string, fallback = "Plan"): string {
  const lines = body.split(/\r?\n/);
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (isFenceLine(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line) continue;
    const heading = TITLE_HEADING_RE.exec(line);
    if (heading) return truncate(cleanStep(heading[2] ?? "") || fallback, 160);
    return truncate(cleanStep(line) || fallback, 160);
  }
  return fallback;
}

/**
 * A plan with no steps is active; a plan whose steps are all done is done.
 * Explicit terminal states (`archived`, `superseded`) are never overwritten
 * by the checklist.
 */
export function deriveStatus(steps: readonly { status: StepStatus }[], current: PlanStatus = "active"): PlanStatus {
  if (current === "archived" || current === "superseded") return current;
  if (steps.length > 0 && steps.every((step) => step.status === "done")) return "done";
  return "active";
}

/** Preserve `done`/`doing` when a plan body is saved again. */
function mergeSteps(existing: readonly StepRow[], parsed: readonly ParsedStep[]): ParsedStep[] {
  // Statuses follow the step TEXT, never its position: a replanned step with a
  // new text starts from its own status (todo), so a done plan reopens instead
  // of inheriting "done" from whatever used to sit at that index.
  const byText = new Map<string, StepRow>();
  for (const step of existing) byText.set(normalizeStepText(step.text), step);
  return parsed.map((step) => {
    const match = byText.get(normalizeStepText(step.text));
    const status: StepStatus =
      step.status === "done" || match?.status === "done"
        ? "done"
        : step.status === "doing" || match?.status === "doing"
          ? "doing"
          : "todo";
    return { text: step.text, status };
  });
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

function stepsForPlans(db: Db, ids: readonly string[]): Map<string, StepRow[]> {
  const result = new Map<string, StepRow[]>();
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT plan_id, position, step_id, text, status
       FROM plan_steps
       WHERE plan_id IN (${placeholders})
       ORDER BY plan_id, position`,
    )
    .all(...ids) as StepRow[];
  for (const row of rows) {
    const list = result.get(row.plan_id);
    if (list) list.push(row);
    else result.set(row.plan_id, [row]);
  }
  return result;
}

export type ListOptions = {
  projectID?: string | undefined;
  sessionID?: string | undefined;
  status?: PlanStatus | "all" | undefined;
  limit?: number | undefined;
  /** Rows to skip; pairs with `limit` for the global page's infinite scroll. */
  offset?: number | undefined;
};

function filterClause(opts: ListOptions): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.projectID) {
    clauses.push("project_id = ?");
    params.push(opts.projectID);
  }
  if (opts.sessionID) {
    clauses.push("session_id = ?");
    params.push(opts.sessionID);
  }
  if (opts.status && opts.status !== "all") {
    clauses.push("status = ?");
    params.push(opts.status);
  }
  return { where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

export function listPlans(db: Db, opts: ListOptions = {}): Plan[] {
  const { where, params } = filterClause(opts);
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const offset = Math.max(0, opts.offset ?? 0);
  const sql = `SELECT * FROM plans${where}
               ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...params, limit, offset) as PlanRow[];
  const steps = stepsForPlans(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({ ...row, steps: steps.get(row.id) ?? [] }));
}

/** Total rows a `listPlans` call with the same filters would page through. */
export function countPlans(db: Db, opts: ListOptions = {}): number {
  const { where, params } = filterClause(opts);
  const row = db.prepare(`SELECT COUNT(*) AS total FROM plans${where}`).get(...params) as
    | { total: number }
    | undefined;
  return row?.total ?? 0;
}

export function getPlan(db: Db, id: string): Plan | undefined {
  const row = db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow | undefined;
  if (!row) return undefined;
  return { ...row, steps: stepsForPlans(db, [id]).get(id) ?? [], touches: planTouches(db, id) };
}

export function getPlanByWorkItem(db: Db, workItemID: string): Plan | undefined {
  const row = db.prepare("SELECT * FROM plans WHERE work_item_id = ?").get(workItemID) as PlanRow | undefined;
  if (!row) return undefined;
  return {
    ...row,
    steps: stepsForPlans(db, [row.id]).get(row.id) ?? [],
    touches: planTouches(db, row.id),
  };
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export type SavePlanInput = {
  id?: string | undefined;
  title?: string | undefined;
  body: string;
  projectID: string;
  projectDirectory: string;
  sessionID: string;
  messageID?: string | undefined;
  steps?: readonly { text: string; status?: StepStatus | undefined }[] | undefined;
  status?: PlanStatus | undefined;
  /** Links the plan to a work item; one plan per item. */
  workItemID?: string | null | undefined;
  /** Declared footprint: undefined keeps it, [] clears it. */
  touches?: readonly string[] | undefined;
};

function transaction<T>(db: Db, fn: () => T): T {
  db.prepare("BEGIN").run();
  try {
    const value = fn();
    db.prepare("COMMIT").run();
    return value;
  } catch (error) {
    try {
      db.prepare("ROLLBACK").run();
    } catch {
      /* best effort */
    }
    throw error;
  }
}

export function savePlan(db: Db, input: SavePlanInput): SaveOk | WriteError {
  const body = input.body.trim();
  if (!body) return { ok: false, error: "o corpo do plano está vazio" };
  if (!input.projectID) return { ok: false, error: "projectID é obrigatório" };
  if (!input.sessionID) return { ok: false, error: "sessionID é obrigatório" };

  const existing = input.id ? getPlan(db, input.id) : undefined;
  if (input.id && !existing) return { ok: false, error: `plano não encontrado: ${input.id}` };

  const workItemID = input.workItemID === undefined ? (existing?.work_item_id ?? null) : input.workItemID;
  if (workItemID !== null) {
    if (!getWorkItem(db, workItemID)) return { ok: false, error: `work item não encontrado: ${workItemID}` };
    const linked = db.prepare("SELECT id FROM plans WHERE work_item_id = ?").get(workItemID) as
      | { id?: string }
      | undefined;
    if (linked?.id !== undefined && linked.id !== existing?.id) {
      return { ok: false, error: "este work item já tem um plano; edite o plano existente" };
    }
  }

  const isTemplate = body.split(/\r?\n/).some((line) => line.trim() === STEPS_PLACEHOLDER);
  const parsed =
    input.steps && input.steps.length > 0
      ? input.steps
          .map((step) => ({
            text: step.text.trim(),
            status: step.status ?? ("todo" as StepStatus),
          }))
          .filter((step) => step.text.length > 0)
      : isTemplate && existing
        ? existing.steps.map((step) => ({ text: step.text, status: step.status }))
        : parseSteps(body);
  // A body update without a step section must not erase the tracked steps.
  const effective =
    parsed.length === 0 && existing && !(input.steps && input.steps.length > 0)
      ? existing.steps.map((step) => ({ text: step.text, status: step.status }))
      : parsed;
  const steps = existing ? mergeSteps(existing.steps, effective) : effective;
  // The stored body keeps a placeholder where the checklist was; `plans.get`
  // and the GUI reassemble it from plan_steps.
  const storedBody = buildTemplate(body, steps.length > 0 || isTemplate);
  const title = truncate(cleanStep(input.title?.trim() || existing?.title || extractTitle(body, "Plan")), 160);
  const status = input.status ?? deriveStatus(steps, existing?.status ?? "active");
  const now = nowTimestamp();
  const completedAt = status === "done" ? (existing?.completed_at ?? now) : null;
  const id = existing?.id ?? crypto.randomUUID();

  try {
    transaction(db, () => {
      if (existing) {
        db.prepare(
          `UPDATE plans
           SET title = ?, body = ?, status = ?, updated_at = ?, completed_at = ?, message_id = ?,
               work_item_id = ?
           WHERE id = ?`,
        ).run(
          title,
          storedBody,
          status,
          now,
          completedAt,
          input.messageID ?? existing.message_id,
          workItemID,
          id,
        );
        db.prepare("DELETE FROM plan_steps WHERE plan_id = ?").run(id);
      } else {
        db.prepare(
          `INSERT INTO plans
             (id, project_id, project_directory, session_id, message_id, title, body, status,
              created_at, updated_at, completed_at, work_item_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.projectID,
          input.projectDirectory,
          input.sessionID,
          input.messageID ?? null,
          title,
          storedBody,
          status,
          now,
          now,
          completedAt,
          workItemID,
        );
      }

      const insert = db.prepare(
        `INSERT INTO plan_steps (plan_id, position, step_id, text, status)
         VALUES (?, ?, ?, ?, ?)`,
      );
      steps.forEach((step, index) => insert.run(id, index, `s${index + 1}`, step.text, step.status));
      if (input.touches !== undefined) {
        db.prepare("DELETE FROM plan_touches WHERE plan_id = ?").run(id);
        for (const path of new Set(input.touches.map((entry) => entry.trim()).filter(Boolean))) {
          db.prepare("INSERT INTO plan_touches (plan_id, path) VALUES (?, ?)").run(id, path);
        }
      }
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const plan = getPlan(db, id);
  if (!plan) return { ok: false, error: "plano gravado, mas não pôde ser lido de volta" };
  return { ok: true, plan };
}

export type UpdatePlanInput = {
  id: string;
  title?: string | undefined;
  body?: string | undefined;
  status?: PlanStatus | undefined;
};

export function updatePlan(db: Db, input: UpdatePlanInput): SaveOk | WriteError {
  const existing = getPlan(db, input.id);
  if (!existing) return { ok: false, error: `plano não encontrado: ${input.id}` };
  return savePlan(db, {
    id: existing.id,
    title: input.title ?? existing.title,
    body: input.body ?? existing.body,
    projectID: existing.project_id,
    projectDirectory: existing.project_directory,
    sessionID: existing.session_id,
    messageID: existing.message_id ?? undefined,
    status: input.status,
    // A status/title-only update must not lose steps when the stored body is
    // already a template (or has no checklist of its own).
    ...(input.body === undefined
      ? { steps: existing.steps.map((step) => ({ text: step.text, status: step.status })) }
      : {}),
  });
}

export type SetStepInput = {
  id: string;
  stepID?: string | undefined;
  position?: number | undefined;
  status: StepStatus;
};

/** Moves a plan to another session of the same project. Steps/status are untouched. */
export function movePlan(db: Db, id: string, sessionID: string): SaveOk | WriteError {
  const plan = getPlan(db, id);
  if (!plan) return { ok: false, error: `plano não encontrado: ${id}` };
  if (!sessionID) return { ok: false, error: "sessionID é obrigatório" };
  if (plan.session_id === sessionID) return { ok: true, plan };

  const now = nowTimestamp();
  try {
    db.prepare("UPDATE plans SET session_id = ?, updated_at = ? WHERE id = ?").run(sessionID, now, id);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const updated = getPlan(db, id);
  if (!updated) return { ok: false, error: "plano movido, mas não pôde ser lido de volta" };
  return { ok: true, plan: updated };
}

export function setStep(db: Db, input: SetStepInput): SaveOk | WriteError {
  const plan = getPlan(db, input.id);
  if (!plan) return { ok: false, error: `plano não encontrado: ${input.id}` };
  const step = input.stepID
    ? plan.steps.find((item) => item.step_id === input.stepID)
    : input.position !== undefined
      ? plan.steps.find((item) => item.position === input.position)
      : undefined;
  if (!step) return { ok: false, error: "passo não encontrado" };

  const now = nowTimestamp();
  const status = input.status;
  const steps = plan.steps.map((item) => {
    if (item.position === step.position) return { ...item, status };
    // A plan has at most one step in progress.
    if (status === "doing" && item.status === "doing") return { ...item, status: "todo" as StepStatus };
    return item;
  });
  const nextStatus = deriveStatus(steps, plan.status);
  const completedAt = nextStatus === "done" ? (plan.completed_at ?? now) : null;

  try {
    transaction(db, () => {
      if (status === "doing") {
        db.prepare(
          "UPDATE plan_steps SET status = 'todo' WHERE plan_id = ? AND status = 'doing' AND position <> ?",
        ).run(plan.id, step.position);
      }
      db.prepare("UPDATE plan_steps SET status = ? WHERE plan_id = ? AND position = ?").run(
        status,
        plan.id,
        step.position,
      );
      db.prepare("UPDATE plans SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?").run(
        nextStatus,
        now,
        completedAt,
        plan.id,
      );
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const updated = getPlan(db, plan.id);
  if (!updated) return { ok: false, error: "passo atualizado, mas o plano não pôde ser lido de volta" };
  return { ok: true, plan: updated };
}

export function deletePlan(db: Db, id: string): DeleteOk | WriteError {
  const plan = getPlan(db, id);
  if (!plan) return { ok: false, error: `plano não encontrado: ${id}` };
  try {
    transaction(db, () => {
      db.prepare("DELETE FROM plan_steps WHERE plan_id = ?").run(id);
      db.prepare("DELETE FROM plan_touches WHERE plan_id = ?").run(id);
      db.prepare("DELETE FROM plans WHERE id = ?").run(id);
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, plan };
}

/* ------------------------------------------------------------------ */
/* Rendering / diagnostics                                             */
/* ------------------------------------------------------------------ */

export function planProgress(plan: Pick<Plan, "steps">): { done: number; doing: number; total: number } {
  return {
    done: plan.steps.filter((step) => step.status === "done").length,
    doing: plan.steps.filter((step) => step.status === "doing").length,
    total: plan.steps.length,
  };
}

export function renderPlanSummary(plan: Plan): string {
  const { done, doing, total } = planProgress(plan);
  const progress = doing > 0 ? `${done}/${total}, ${doing} doing` : `${done}/${total}`;
  return `- [${plan.status}] ${plan.title} (${progress}) id=${plan.id} updated=${plan.updated_at}`;
}

export function renderPlanFull(plan: Plan): string {
  const touches = plan.touches ?? [];
  const touchesLine =
    touches.length > 0
      ? `touches: ${touches.join(", ")}`
      : "touches: none (an empty footprint conflicts with everything and serializes)";
  const { done, doing, total } = planProgress(plan);
  const body = renderPlanBody(
    plan.body,
    plan.steps.map((step) => ({ id: step.step_id, text: step.text, status: step.status })),
  );
  const lines = [
    `# ${plan.title}`,
    `id: ${plan.id}`,
    `status: ${plan.status} (${done}/${total} passos${doing > 0 ? `, ${doing} em andamento` : ""})`,
    `project: ${plan.project_directory}`,
    `session: ${plan.session_id}`,
    `created: ${plan.created_at}`,
    `updated: ${plan.updated_at}`,
    touchesLine,
  ];
  if (plan.completed_at) lines.push(`completed: ${plan.completed_at}`);
  lines.push("", body);
  if (plan.steps.length > 0) {
    lines.push("", "Legenda: [x] done · [~] doing · [ ] todo");
  }
  return lines.join("\n");
}

export type DoctorInfo = {
  dbPath: string;
  version: number;
  plans: number;
  steps: number;
  driver: "sqlite";
};

export function doctorInfo(store: Store): DoctorInfo {
  const count = (sql: string): number => {
    const row = store.db.prepare(sql).get() as { c?: number } | undefined;
    return row?.c ?? 0;
  };
  return {
    dbPath: plansDbPath(),
    version: schemaVersion(store.db),
    plans: count("SELECT COUNT(*) AS c FROM plans"),
    steps: count("SELECT COUNT(*) AS c FROM plan_steps"),
    driver: "sqlite",
  };
}

export function renderDoctor(info: DoctorInfo): string {
  return [
    "plans doctor",
    `  driver:  ${info.driver}`,
    `  db:      ${info.dbPath}`,
    `  version: ${info.version}`,
    `  plans:   ${info.plans}`,
    `  steps:   ${info.steps}`,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Work items — user initiatives and containment (US-01)                  */
/* ------------------------------------------------------------------ */

export type WorkItemStatus = "backlog" | "ready" | "doing" | "blocked" | "done" | "dropped";
export type WorkOrigin = "user" | "agent";

export type InitiativeRow = {
  id: string;
  name: string;
  description: string | null;
  /** Integration base for runs; null means the repo default branch. */
  base_branch: string | null;
  max_parallel: number;
  verify_command: string | null;
  created_at: string;
  updated_at: string;
};

export type InitiativeRepoRow = {
  id: string;
  initiative_id: string;
  directory: string;
  label: string;
  primary: boolean;
  position: number;
  created_at: string;
};

export type Initiative = InitiativeRow & { repos: InitiativeRepoRow[] };

export type WorkItemRow = {
  id: string;
  initiative_id: string;
  repo_id: string | null;
  parent_id: string | null;
  title: string;
  body: string;
  status: WorkItemStatus;
  rank: number;
  origin: WorkOrigin;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export type WorkStoreError = { ok: false; error: string };

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Absolute path, no trailing slash (the root stays "/"). */
/** Absolute path, no trailing slash; the root stays "/", empty stays empty. */
export function normalizeWorkspaceDirectory(directory: string): string {
  const trimmed = directory.trim();
  if (!trimmed) return "";
  const stripped = trimmed.replace(/\/+$/, "");
  return stripped || "/";
}

type RepoRow = {
  id: string;
  initiative_id: string;
  directory: string;
  label: string;
  is_primary: number;
  position: number;
  created_at: string;
};

function repoFrom(row: RepoRow): InitiativeRepoRow {
  return {
    id: row.id,
    initiative_id: row.initiative_id,
    directory: row.directory,
    label: row.label,
    primary: row.is_primary === 1,
    position: row.position,
    created_at: row.created_at,
  };
}

function reposFor(db: Db, initiativeID: string): InitiativeRepoRow[] {
  const rows = db
    .prepare("SELECT * FROM initiative_repos WHERE initiative_id = ? ORDER BY position ASC, created_at ASC")
    .all(initiativeID) as RepoRow[];
  return rows.map(repoFrom);
}

/** The initiative a repo already belongs to, if any. */
function repoOwner(db: Db, directory: string): string | undefined {
  const row = db.prepare("SELECT initiative_id FROM initiative_repos WHERE directory = ?").get(directory) as
    | { initiative_id?: string }
    | undefined;
  return row?.initiative_id;
}

export function getInitiative(db: Db, id: string): Initiative | undefined {
  const row = db.prepare("SELECT * FROM initiatives WHERE id = ?").get(id) as InitiativeRow | undefined;
  if (!row) return undefined;
  return { ...row, repos: reposFor(db, id) };
}

export function listInitiatives(db: Db): Initiative[] {
  const rows = db.prepare("SELECT * FROM initiatives ORDER BY updated_at DESC, name ASC").all() as InitiativeRow[];
  return rows.map((row) => ({ ...row, repos: reposFor(db, row.id) }));
}

export type UpdateInitiativeInput = {
  id: string;
  name?: string | undefined;
  description?: string | null | undefined;
};

/** Renames and/or rewrites the description; omitted fields are kept. */
export function updateInitiative(db: Db, input: UpdateInitiativeInput): InitiativeOk | WorkStoreError {
  const current = getInitiative(db, input.id);
  if (!current) return { ok: false, error: `iniciativa não encontrada: ${input.id}` };
  const name = input.name === undefined ? current.name : input.name.trim();
  if (!name) return { ok: false, error: "o nome da iniciativa é obrigatório" };
  const description =
    input.description === undefined ? current.description : input.description?.trim() || null;

  try {
    db.prepare("UPDATE initiatives SET name = ?, description = ?, updated_at = ? WHERE id = ?").run(
      name,
      description,
      nowTimestamp(),
      input.id,
    );
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  const initiative = getInitiative(db, input.id);
  if (!initiative) return { ok: false, error: "iniciativa não encontrada após a atualização" };
  return { ok: true, initiative };
}

export type InitiativeRepoInput = {
  directory: string;
  label?: string | undefined;
};

export type CreateInitiativeInput = {
  name: string;
  description?: string | null | undefined;
  /** Repositories are optional: a new initiative can start empty. */
  repos?: readonly InitiativeRepoInput[] | undefined;
};

export type InitiativeOk = { ok: true; initiative: Initiative };
export type RepoOk = { ok: true; repo: InitiativeRepoRow };
export type Ok = { ok: true };

/**
 * A initiative is born with its repos: the first is `primary`, and a
 * directory can belong to one initiative only.
 */
export function createInitiative(db: Db, input: CreateInitiativeInput): InitiativeOk | WorkStoreError {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "o nome da iniciativa é obrigatório" };
  const description = input.description?.trim() || null;

  const repos = (input.repos ?? []).map((repo) => {
    const directory = normalizeWorkspaceDirectory(repo.directory);
    if (!directory) return { directory: "", label: "" };
    return { directory, label: repo.label?.trim() || basename(directory) || directory };
  });
  for (const repo of repos) {
    if (!repo.directory) return { ok: false, error: "o diretório do repositório é obrigatório" };
  }
  const seen = new Set<string>();
  for (const repo of repos) {
    if (!isAbsolute(repo.directory)) {
      return { ok: false, error: `o repositório precisa de um caminho absoluto: ${repo.directory}` };
    }
    if (seen.has(repo.directory)) return { ok: false, error: `repositório duplicado: ${repo.directory}` };
    seen.add(repo.directory);
    if (repoOwner(db, repo.directory) !== undefined) {
      return { ok: false, error: `o repositório ${repo.directory} já pertence a outra iniciativa` };
    }
  }

  const id = crypto.randomUUID();
  const now = nowTimestamp();
  try {
    transaction(db, () => {
      db.prepare(
        "INSERT INTO initiatives (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(id, name, description, now, now);
      repos.forEach((repo, index) => {
        db.prepare(
          `INSERT INTO initiative_repos (id, initiative_id, directory, label, is_primary, position, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(crypto.randomUUID(), id, repo.directory, repo.label, index === 0 ? 1 : 0, index, now);
      });
    });
  } catch (error) {
    return { ok: false, error: reason(error) };
  }

  const initiative = getInitiative(db, id);
  if (!initiative) return { ok: false, error: "iniciativa não encontrada após a criação" };
  return { ok: true, initiative };
}

export function addInitiativeRepo(db: Db, initiativeID: string, input: InitiativeRepoInput): RepoOk | WorkStoreError {
  const initiative = getInitiative(db, initiativeID);
  if (!initiative) return { ok: false, error: `iniciativa não encontrado: ${initiativeID}` };
  const directory = normalizeWorkspaceDirectory(input.directory);
  if (!directory) return { ok: false, error: "o diretório do repositório é obrigatório" };
  if (!isAbsolute(directory)) {
    return { ok: false, error: `o repositório precisa de um caminho absoluto: ${directory}` };
  }
  const owner = repoOwner(db, directory);
  if (owner !== undefined) return { ok: false, error: `o repositório ${directory} já pertence a outra iniciativa` };

  const id = crypto.randomUUID();
  const now = nowTimestamp();
  const label = input.label?.trim() || basename(directory) || directory;
  try {
    transaction(db, () => {
      db.prepare(
        `INSERT INTO initiative_repos (id, initiative_id, directory, label, is_primary, position, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      ).run(id, initiativeID, directory, label, initiative.repos.length, now);
      db.prepare("UPDATE initiatives SET updated_at = ? WHERE id = ?").run(now, initiativeID);
    });
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  const row = db.prepare("SELECT * FROM initiative_repos WHERE id = ?").get(id) as RepoRow | undefined;
  if (!row) return { ok: false, error: "repositório não encontrado após a criação" };
  return { ok: true, repo: repoFrom(row) };
}

export type RemoveLocationResult =
  | { ok: true }
  | { ok: false; error: string; needsConfirmation?: boolean; items?: number };

/**
 * Removes a repo. A repo with work items asks for confirmation; with
 * it, those items lose their repo (`repo_id = NULL`, falling back to
 * the primary when a plan starts) and the repo is removed.
 */
export function removeInitiativeRepo(
  db: Db,
  initiativeID: string,
  repoID: string,
  options: { confirm?: boolean } = {},
): RemoveLocationResult {
  const initiative = getInitiative(db, initiativeID);
  if (!initiative) return { ok: false, error: `iniciativa não encontrado: ${initiativeID}` };
  const repo = initiative.repos.find((item) => item.id === repoID);
  if (!repo) return { ok: false, error: "repositório não encontrado neste iniciativa" };

  const counted = db.prepare("SELECT COUNT(*) AS c FROM work_items WHERE repo_id = ?").get(repoID) as
    | { c?: number }
    | undefined;
  const items = Number(counted?.c ?? 0);
  if (items > 0 && options.confirm !== true) {
    return {
      ok: false,
      error: `há ${items} work item(ns) neste repositório; confirme para removê-lo e deixá-los sem repositório`,
      needsConfirmation: true,
      items,
    };
  }

  const now = nowTimestamp();
  try {
    transaction(db, () => {
      if (items > 0) {
        db.prepare("UPDATE work_items SET repo_id = NULL, updated_at = ? WHERE repo_id = ?").run(
          now,
          repoID,
        );
      }
      db.prepare("DELETE FROM initiative_repos WHERE id = ?").run(repoID);
      if (repo.primary) {
        const next = initiative.repos.find((item) => item.id !== repoID);
        if (next) db.prepare("UPDATE initiative_repos SET is_primary = 1 WHERE id = ?").run(next.id);
      }
      db.prepare("UPDATE initiatives SET updated_at = ? WHERE id = ?").run(now, initiativeID);
    });
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  return { ok: true };
}

export function setInitiativePrimary(db: Db, initiativeID: string, repoID: string): Ok | WorkStoreError {
  const initiative = getInitiative(db, initiativeID);
  if (!initiative) return { ok: false, error: `iniciativa não encontrado: ${initiativeID}` };
  if (!initiative.repos.some((item) => item.id === repoID)) {
    return { ok: false, error: "repositório não encontrado neste iniciativa" };
  }
  const now = nowTimestamp();
  try {
    transaction(db, () => {
      db.prepare("UPDATE initiative_repos SET is_primary = 0 WHERE initiative_id = ?").run(initiativeID);
      db.prepare("UPDATE initiative_repos SET is_primary = 1 WHERE id = ?").run(repoID);
      db.prepare("UPDATE initiatives SET updated_at = ? WHERE id = ?").run(now, initiativeID);
    });
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  return { ok: true };
}

export type CreateWorkItemInput = {
  initiativeID: string;
  repoID?: string | undefined;
  title: string;
  body?: string | undefined;
  origin?: WorkOrigin | undefined;
};

export type WorkItemOk = { ok: true; item: WorkItemRow };

function nextRank(db: Db, initiativeID: string, status: WorkItemStatus): number {
  const row = db.prepare("SELECT COALESCE(MAX(rank), 0) AS r FROM work_items WHERE initiative_id = ? AND status = ?").get(
    initiativeID,
    status,
  ) as { r?: number } | undefined;
  return (row?.r ?? 0) + 1;
}

/**
 * US-01 slice: the item belongs to a initiative and, optionally, to one of its
 * repos. Status/rank/parent/origin columns exist for the following USs;
 * here only the containment is enforced.
 */
export function createWorkItem(db: Db, input: CreateWorkItemInput): WorkItemOk | WorkStoreError {
  const title = input.title.trim();
  if (!title) return { ok: false, error: "o título do work item é obrigatório" };
  if (!input.initiativeID) return { ok: false, error: "initiativeID é obrigatório" };
  const initiative = db.prepare("SELECT id FROM initiatives WHERE id = ?").get(input.initiativeID) as
    | { id?: string }
    | undefined;
  if (!initiative?.id) return { ok: false, error: `iniciativa não encontrado: ${input.initiativeID}` };
  if (input.repoID) {
    const repo = db.prepare("SELECT initiative_id FROM initiative_repos WHERE id = ?").get(input.repoID) as
      | { initiative_id?: string }
      | undefined;
    if (!repo?.initiative_id) return { ok: false, error: "repositório não encontrado" };
    if (repo.initiative_id !== input.initiativeID) {
      return { ok: false, error: "o repositório não pertence a esta iniciativa" };
    }
  }

  const id = crypto.randomUUID();
  const now = nowTimestamp();
  const status: WorkItemStatus = "backlog";
  try {
    db.prepare(
      `INSERT INTO work_items
         (id, initiative_id, repo_id, parent_id, title, body, status, rank, origin, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      id,
      input.initiativeID,
      input.repoID ?? null,
      title,
      input.body?.trim() ?? "",
      status,
      nextRank(db, input.initiativeID, status),
      input.origin ?? "user",
      now,
      now,
    );
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  const item = getWorkItem(db, id);
  if (!item) return { ok: false, error: "item não encontrado após a criação" };
  return { ok: true, item };
}

export type DepEdgeRow = { itemID: string; blocksID: string; kind: string; reason: string | null };

/** Every dependency edge inside an initiative, with its kind and reason. */
export function depEdges(db: Db, initiativeID: string): DepEdgeRow[] {
  return (
    db
      .prepare(
        `SELECT d.item_id AS itemID, d.blocks_id AS blocksID, d.kind AS kind, d.reason AS reason
           FROM work_item_deps d
           JOIN work_items w ON w.id = d.item_id
          WHERE w.initiative_id = ?`,
      )
      .all(initiativeID) as DepEdgeRow[]
  ).map((row) => ({ itemID: row.itemID, blocksID: row.blocksID, kind: row.kind, reason: row.reason }));
}

export function getWorkItem(db: Db, id: string): WorkItemRow | undefined {
  return db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as WorkItemRow | undefined;
}

export type MoveWorkItemInput = {
  id: string;
  direction: "up" | "down";
};

/**
 * Moves the item one place inside its status and renumbers the group 1..N.
 * At the edges it is a no-op; the caller decides whether to disable the action.
 */
export type WorkItemDepInput = {
  /** The item that waits. */
  itemID: string;
  /** The item it depends on. */
  blocksID: string;
};

export type WorkItemDeps = {
  /** Items this one depends on. */
  blockedBy: WorkItemRow[];
  /** Items that depend on this one. */
  blocks: WorkItemRow[];
};

/** Whether `from` depends on `target`, directly or transitively. */
function dependsOn(db: Db, from: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const rows = db.prepare("SELECT blocks_id FROM work_item_deps WHERE item_id = ?").all(current) as {
      blocks_id: string;
    }[];
    for (const row of rows) stack.push(row.blocks_id);
  }
  return false;
}

/** A depends on B. Same initiative only; cycles are rejected; duplicates are no-ops. */
export function addWorkItemDep(db: Db, input: WorkItemDepInput): Ok | WorkStoreError {
  if (input.itemID === input.blocksID) {
    return { ok: false, error: "um work item não pode depender de si mesmo" };
  }
  const item = getWorkItem(db, input.itemID);
  if (!item) return { ok: false, error: `work item não encontrado: ${input.itemID}` };
  const blocker = getWorkItem(db, input.blocksID);
  if (!blocker) return { ok: false, error: `work item não encontrado: ${input.blocksID}` };
  if (item.initiative_id !== blocker.initiative_id) {
    return { ok: false, error: "os itens precisam pertencer à mesma iniciativa" };
  }

  const exists = db
    .prepare("SELECT 1 AS one FROM work_item_deps WHERE item_id = ? AND blocks_id = ?")
    .get(input.itemID, input.blocksID) as { one?: number } | undefined;
  if (exists) return { ok: true };

  if (dependsOn(db, input.blocksID, input.itemID)) {
    return { ok: false, error: `dependência circular: ${blocker.title} já depende de ${item.title}` };
  }

  try {
    db.prepare(
      "INSERT INTO work_item_deps (item_id, blocks_id, kind, reason, created_at) VALUES (?, ?, 'explicit', NULL, ?)",
    ).run(input.itemID, input.blocksID, nowTimestamp());
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  return { ok: true };
}

export function removeWorkItemDep(db: Db, input: WorkItemDepInput): Ok | WorkStoreError {
  try {
    db.prepare("DELETE FROM work_item_deps WHERE item_id = ? AND blocks_id = ?").run(
      input.itemID,
      input.blocksID,
    );
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  return { ok: true };
}

export type SetWorkItemParentInput = {
  id: string;
  /** null clears the parent. */
  parentID?: string | null | undefined;
};

export function workItemChildren(db: Db, parentID: string): WorkItemRow[] {
  return db
    .prepare("SELECT * FROM work_items WHERE parent_id = ? ORDER BY rank ASC, created_at ASC")
    .all(parentID) as WorkItemRow[];
}

/**
 * Groups an item under a root parent. One level only: the parent cannot have a
 * parent and the item cannot have children. Dropping/closing the parent does
 * not touch the children.
 */
export function setWorkItemParent(db: Db, input: SetWorkItemParentInput): WorkItemOk | WorkStoreError {
  const current = getWorkItem(db, input.id);
  if (!current) return { ok: false, error: `work item não encontrado: ${input.id}` };
  const parentID = input.parentID ?? null;

  if (parentID !== null) {
    if (parentID === input.id) return { ok: false, error: "um work item não pode ser pai de si mesmo" };
    const parent = getWorkItem(db, parentID);
    if (!parent) return { ok: false, error: `work item não encontrado: ${parentID}` };
    if (parent.initiative_id !== current.initiative_id) {
      return { ok: false, error: "os itens precisam pertencer à mesma iniciativa" };
    }
    if (parent.parent_id) {
      return { ok: false, error: "profundidade máxima de 1: o pai escolhido já é filho de outro item" };
    }
    const child = db
      .prepare("SELECT 1 AS one FROM work_items WHERE parent_id = ? LIMIT 1")
      .get(input.id) as { one?: number } | undefined;
    if (child) return { ok: false, error: "um item com filhos não pode ter pai" };
  }

  const now = nowTimestamp();
  try {
    db.prepare("UPDATE work_items SET parent_id = ?, updated_at = ? WHERE id = ?").run(parentID, now, input.id);
  } catch (error) {
    return { ok: false, error: reason(error) };
  }

  const item = getWorkItem(db, input.id);
  if (!item) return { ok: false, error: "item não encontrado após a mudança de pai" };
  return { ok: true, item };
}

/** Whether a run (or its merge queue) still references the item. */
function workItemInRun(db: Db, id: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS one FROM run_items WHERE work_item_id = ? UNION ALL SELECT 1 AS one FROM merge_queue WHERE work_item_id = ? LIMIT 1",
    )
    .get(id, id);
  return row !== undefined;
}

/**
 * Deletes a need. Dependencies go with it, its children become roots, and the
 * linked plan is kept (unlinked). Items referenced by a run are refused so the
 * run history stays consistent.
 */
export function deleteWorkItem(db: Db, id: string): Ok | WorkStoreError {
  const item = getWorkItem(db, id);
  if (!item) return { ok: false, error: `work item não encontrado: ${id}` };
  if (workItemInRun(db, id)) {
    return { ok: false, error: "o item faz parte de um run; cancele ou limpe a run antes de excluí-lo" };
  }
  const now = nowTimestamp();
  try {
    transaction(db, () => {
      db.prepare("DELETE FROM work_item_deps WHERE item_id = ? OR blocks_id = ?").run(id, id);
      db.prepare("UPDATE work_items SET parent_id = NULL, updated_at = ? WHERE parent_id = ?").run(now, id);
      db.prepare("UPDATE plans SET work_item_id = NULL WHERE work_item_id = ?").run(id);
      db.prepare("DELETE FROM work_items WHERE id = ?").run(id);
    });
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  return { ok: true };
}

/**
 * Deletes an initiative and everything it owns: items, dependencies,
 * repositories and the run history. Plans are kept, unlinked. An active run
 * blocks the deletion (cancel it first).
 */
export function deleteInitiative(db: Db, id: string): Ok | WorkStoreError {
  const initiative = getInitiative(db, id);
  if (!initiative) return { ok: false, error: `iniciativa não encontrada: ${id}` };
  const active = db
    .prepare("SELECT 1 AS one FROM runs WHERE initiative_id = ? AND status IN ('running', 'interrupted') LIMIT 1")
    .get(id);
  if (active) return { ok: false, error: "a iniciativa tem um run ativo; cancele a run antes de excluí-la" };

  try {
    transaction(db, () => {
      db.prepare(
        "UPDATE plans SET work_item_id = NULL WHERE work_item_id IN (SELECT id FROM work_items WHERE initiative_id = ?)",
      ).run(id);
      db.prepare(
        "DELETE FROM work_item_deps WHERE item_id IN (SELECT id FROM work_items WHERE initiative_id = ?) OR blocks_id IN (SELECT id FROM work_items WHERE initiative_id = ?)",
      ).run(id, id);
      db.prepare("DELETE FROM merge_queue WHERE run_id IN (SELECT id FROM runs WHERE initiative_id = ?)").run(id);
      db.prepare("DELETE FROM run_items WHERE run_id IN (SELECT id FROM runs WHERE initiative_id = ?)").run(id);
      db.prepare("DELETE FROM runs WHERE initiative_id = ?").run(id);
      db.prepare("DELETE FROM work_items WHERE initiative_id = ?").run(id);
      db.prepare("DELETE FROM initiative_repos WHERE initiative_id = ?").run(id);
      db.prepare("DELETE FROM initiatives WHERE id = ?").run(id);
    });
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  return { ok: true };
}

export function workItemDeps(db: Db, itemID: string): WorkItemDeps {
  const blockedBy = db
    .prepare(
      "SELECT w.* FROM work_item_deps d JOIN work_items w ON w.id = d.blocks_id WHERE d.item_id = ? ORDER BY w.title ASC",
    )
    .all(itemID) as WorkItemRow[];
  const blocks = db
    .prepare(
      "SELECT w.* FROM work_item_deps d JOIN work_items w ON w.id = d.item_id WHERE d.blocks_id = ? ORDER BY w.title ASC",
    )
    .all(itemID) as WorkItemRow[];
  return { blockedBy, blocks };
}

export function moveWorkItem(db: Db, input: MoveWorkItemInput): WorkItemOk | WorkStoreError {
  const current = getWorkItem(db, input.id);
  if (!current) return { ok: false, error: `work item não encontrado: ${input.id}` };

  const siblings = listWorkItems(db, current.initiative_id).filter((item) => item.status === current.status);
  const index = siblings.findIndex((item) => item.id === current.id);
  if (index < 0) return { ok: false, error: "work item não encontrado na lista" };

  const target = input.direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= siblings.length) return { ok: true, item: current };

  const reordered = [...siblings];
  const moved = reordered.splice(index, 1)[0];
  if (!moved) return { ok: false, error: "work item não encontrado na lista" };
  reordered.splice(target, 0, moved);

  const now = nowTimestamp();
  try {
    transaction(db, () => {
      reordered.forEach((item, position) => {
        db.prepare("UPDATE work_items SET rank = ?, updated_at = ? WHERE id = ?").run(position + 1, now, item.id);
      });
    });
  } catch (error) {
    return { ok: false, error: reason(error) };
  }

  const item = getWorkItem(db, input.id);
  if (!item) return { ok: false, error: "item não encontrado após a reordenação" };
  return { ok: true, item };
}

export function setWorkItemRepo(
  db: Db,
  input: { id: string; repoID: string },
): WorkItemOk | WorkStoreError {
  const item = getWorkItem(db, input.id);
  if (!item) return { ok: false, error: `work item não encontrado: ${input.id}` };
  const repo = db.prepare("SELECT id, initiative_id FROM initiative_repos WHERE id = ?").get(input.repoID) as
    | { id?: string; initiative_id?: string }
    | undefined;
  if (!repo?.id) return { ok: false, error: "repositório não encontrado" };
  if (repo.initiative_id !== item.initiative_id) {
    return { ok: false, error: "o repositório não pertence a esta iniciativa" };
  }
  try {
    db.prepare("UPDATE work_items SET repo_id = ?, updated_at = ? WHERE id = ?").run(
      input.repoID,
      nowTimestamp(),
      input.id,
    );
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  const updated = getWorkItem(db, input.id);
  if (!updated) return { ok: false, error: "item não encontrado após trocar o repositório" };
  return { ok: true, item: updated };
}

export type EnsureRepoResult =
  | { ok: true; repo: InitiativeRepoRow; created: boolean }
  | WorkStoreError;

/** Reuses the repository when the initiative already has it, creates otherwise. */
export function ensureInitiativeRepo(
  db: Db,
  initiativeID: string,
  directory: string,
): EnsureRepoResult {
  const initiative = getInitiative(db, initiativeID);
  if (!initiative) return { ok: false, error: `iniciativa não encontrada: ${initiativeID}` };
  const normalized = normalizeWorkspaceDirectory(directory);
  if (!normalized) return { ok: false, error: "o diretório do repositório é obrigatório" };
  if (!isAbsolute(normalized)) {
    return { ok: false, error: `o repositório precisa de um caminho absoluto: ${normalized}` };
  }

  const existing = initiative.repos.find((repo) => normalizeWorkspaceDirectory(repo.directory) === normalized);
  if (existing) return { ok: true, repo: existing, created: false };

  const owner = repoOwner(db, normalized);
  if (owner !== undefined && owner !== initiativeID) {
    return { ok: false, error: `o repositório ${normalized} já pertence a outra iniciativa` };
  }

  const added = addInitiativeRepo(db, initiativeID, { directory: normalized });
  if (!added.ok) return added;
  return { ok: true, repo: added.repo, created: true };
}

export type PlaceWorkItemInput = {
  id: string;
  status: WorkItemStatus;
  /** Zero-based index inside the destination status. */
  position: number;
};

/**
 * Drops an item into another column at an exact index: the GUI board and the
 * accessible "move to" menu both land here. Transitions are validated like
 * `setWorkItemStatus`, and the destination group is renumbered 1..N.
 */
export function placeWorkItem(db: Db, input: PlaceWorkItemInput): WorkItemOk | WorkStoreError {
  const current = getWorkItem(db, input.id);
  if (!current) return { ok: false, error: `work item não encontrado: ${input.id}` };

  if (input.status !== current.status) {
    const allowed = WORK_ITEM_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(input.status)) {
      return { ok: false, error: `transição inválida: ${current.status} -> ${input.status}` };
    }
  }

  const siblings = listWorkItems(db, current.initiative_id).filter(
    (item) => item.status === input.status && item.id !== current.id,
  );
  const position = Math.max(0, Math.min(Math.trunc(input.position), siblings.length));
  const reordered = [...siblings];
  reordered.splice(position, 0, current);

  const now = nowTimestamp();
  const closedAt =
    input.status === "done" || input.status === "dropped" ? current.closed_at ?? now : null;

  try {
    transaction(db, () => {
      reordered.forEach((item, index) => {
        if (item.id === current.id) {
          db.prepare(
            "UPDATE work_items SET status = ?, rank = ?, updated_at = ?, closed_at = ? WHERE id = ?",
          ).run(input.status, index + 1, now, closedAt, item.id);
          return;
        }
        db.prepare("UPDATE work_items SET rank = ?, updated_at = ? WHERE id = ?").run(
          index + 1,
          now,
          item.id,
        );
      });
    });
  } catch (error) {
    return { ok: false, error: reason(error) };
  }

  const item = getWorkItem(db, input.id);
  if (!item) return { ok: false, error: "item não encontrado após a movimentação" };
  return { ok: true, item };
}

export type SetWorkItemStatusInput = {
  id: string;
  status: WorkItemStatus;
};

/**
 * Moves the item through the allowed status graph. `done`/`dropped` close it;
 * any other status clears `closed_at`. Same status is a no-op.
 */
export function setWorkItemStatus(db: Db, input: SetWorkItemStatusInput): WorkItemOk | WorkStoreError {
  const current = getWorkItem(db, input.id);
  if (!current) return { ok: false, error: `work item não encontrado: ${input.id}` };
  if (current.status === input.status) return { ok: true, item: current };

  const allowed = WORK_ITEM_TRANSITIONS[current.status] ?? [];
  if (!allowed.includes(input.status)) {
    return { ok: false, error: `transição inválida: ${current.status} -> ${input.status}` };
  }

  const now = nowTimestamp();
  const closedAt = input.status === "done" || input.status === "dropped" ? now : null;
  // Land at the end of the destination section so the position is predictable.
  const rank = nextRank(db, current.initiative_id, input.status);
  try {
    db.prepare("UPDATE work_items SET status = ?, rank = ?, updated_at = ?, closed_at = ? WHERE id = ?").run(
      input.status,
      rank,
      now,
      closedAt,
      input.id,
    );
  } catch (error) {
    return { ok: false, error: reason(error) };
  }

  const item = getWorkItem(db, input.id);
  if (!item) return { ok: false, error: "item não encontrado após a mudança de status" };
  return { ok: true, item };
}

export type UpdateWorkItemInput = {
  id: string;
  title?: string | undefined;
  body?: string | undefined;
};

/** Edits the need (title/body). Status, rank, parent and deps have their own USs. */
export function updateWorkItem(db: Db, input: UpdateWorkItemInput): WorkItemOk | WorkStoreError {
  const current = getWorkItem(db, input.id);
  if (!current) return { ok: false, error: `work item não encontrado: ${input.id}` };
  const title = input.title === undefined ? current.title : input.title.trim();
  if (!title) return { ok: false, error: "o título do work item é obrigatório" };
  const body = input.body === undefined ? current.body : input.body;

  const now = nowTimestamp();
  try {
    db.prepare("UPDATE work_items SET title = ?, body = ?, updated_at = ? WHERE id = ?").run(
      title,
      body,
      now,
      input.id,
    );
  } catch (error) {
    return { ok: false, error: reason(error) };
  }

  const item = getWorkItem(db, input.id);
  if (!item) return { ok: false, error: "item não encontrado após a atualização" };
  return { ok: true, item };
}

export function listWorkItems(db: Db, initiativeID: string): WorkItemRow[] {
  return db
    .prepare("SELECT * FROM work_items WHERE initiative_id = ? ORDER BY status ASC, rank ASC, created_at ASC")
    .all(initiativeID) as WorkItemRow[];
}

/** Every item, for the global surface; the caller groups by initiative. */
export function listWorkItemsAll(db: Db): WorkItemRow[] {
  return db.prepare("SELECT * FROM work_items ORDER BY created_at ASC, rank ASC").all() as WorkItemRow[];
}

export type InitiativeResolution = {
  initiative: Initiative;
  repo: InitiativeRepoRow;
  match: "exact" | "ancestor";
};

/** `directory` is inside `ancestor` at a path boundary, never a name prefix. */
export function isInsideWorkspace(directory: string, ancestor: string): boolean {
  if (ancestor === "/") return directory !== "/";
  return directory.startsWith(`${ancestor}/`);
}

/**
 * The user initiative a session directory belongs to: an exact repo match,
 * else the deepest ancestor (nested initiatives resolve by specificity), else
 * undefined ("no initiative").
 */
export function resolveInitiative(db: Db, directory: string): InitiativeResolution | undefined {
  const target = normalizeWorkspaceDirectory(directory);
  if (!target) return undefined;

  const rows = db.prepare("SELECT * FROM initiative_repos").all() as RepoRow[];
  let exact: RepoRow | undefined;
  let ancestor: { row: RepoRow; depth: number } | undefined;
  for (const row of rows) {
    const repo = normalizeWorkspaceDirectory(row.directory);
    if (repo === target) {
      exact = row;
      break;
    }
    if (!isInsideWorkspace(target, repo)) continue;
    if (ancestor === undefined || repo.length > ancestor.depth) {
      ancestor = { row, depth: repo.length };
    }
  }

  const chosen = exact ?? ancestor?.row;
  if (!chosen) return undefined;
  const initiative = getInitiative(db, chosen.initiative_id);
  if (!initiative) return undefined;
  return { initiative, repo: repoFrom(chosen), match: exact ? "exact" : "ancestor" };
}

/** A readable initiative name for an auto-created container. */
export function initiativeNameForDirectory(directory: string): string {
  return basename(normalizeWorkspaceDirectory(directory)) || "Workspace";
}

export type EnsureInitiativeResult =
  | { ok: true; initiative: Initiative; repo: InitiativeRepoRow; created: boolean }
  | WorkStoreError;

/**
 * The initiative for a session repo, created on first use. A subdirectory of
 * an existing repo reuses that initiative; the creation is idempotent and
 * the UNIQUE(directory) index is the final guard against two writers.
 */
export function ensureInitiativeForDirectory(db: Db, input: string): EnsureInitiativeResult {
  const directory = normalizeWorkspaceDirectory(input);
  if (!directory) return { ok: false, error: "o diretório do repositório é obrigatório" };
  if (!isAbsolute(directory)) {
    return { ok: false, error: `o repositório precisa de um caminho absoluto: ${directory}` };
  }

  const resolved = resolveInitiative(db, directory);
  if (resolved) {
    return { ok: true, initiative: resolved.initiative, repo: resolved.repo, created: false };
  }

  const created = createInitiative(db, {
    name: initiativeNameForDirectory(directory),
    repos: [{ directory }],
  });
  if (created.ok) {
    const repo = created.initiative.repos[0];
    if (!repo) return { ok: false, error: "repositório não encontrado após a criação" };
    return { ok: true, initiative: created.initiative, repo, created: true };
  }

  // Another writer may have won the race between the resolve and the insert.
  const raced = resolveInitiative(db, directory);
  if (raced) {
    return { ok: true, initiative: raced.initiative, repo: raced.repo, created: false };
  }
  return created;
}


/* ------------------------------------------------------------------ */
/* Initiative runs (F4)                                                   */
/* ------------------------------------------------------------------ */

export type RunStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";
export type RunItemStatus = "queued" | "running" | "merging" | "merged" | "failed" | "skipped";
export type MergeStatus = "queued" | "merging" | "merged" | "failed";

export type RunRow = {
  id: string;
  initiative_id: string;
  base_ref: string;
  status: RunStatus;
  max_parallel: number;
  merge_session_id: string | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
};

export type RunItemRow = {
  run_id: string;
  work_item_id: string;
  status: RunItemStatus;
  plan_id: string | null;
  branch: string | null;
  worktree: string | null;
  session_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  merged_sha: string | null;
  error: string | null;
};

export type MergeEntryRow = {
  id: string;
  run_id: string;
  work_item_id: string;
  status: MergeStatus;
  enqueued_at: string;
  claimed_at: string | null;
  finished_at: string | null;
  error: string | null;
};

export type RunOk = { ok: true; run: RunRow };
export type RunItemOk = { ok: true; item: RunItemRow };

const RUN_TERMINAL = new Set<RunStatus>(["done", "failed", "cancelled"]);
/** Statuses where the item is finished, merged or not. */
const RUN_ITEM_DONE = new Set<RunItemStatus>(["merged", "failed", "skipped"]);

function clampParallel(value: number | undefined, fallback: number): number {
  const next = value ?? fallback;
  if (!Number.isFinite(next)) return fallback;
  return Math.max(1, Math.min(8, Math.trunc(next)));
}

export function getRun(db: Db, id: string): RunRow | undefined {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
}

export function listRuns(db: Db, initiativeID: string, limit = 20): RunRow[] {
  return db
    .prepare("SELECT * FROM runs WHERE initiative_id = ? ORDER BY started_at DESC LIMIT ?")
    .all(initiativeID, limit) as RunRow[];
}

/** The run that blocks a new one: running or interrupted, one per initiative. */
export function activeRun(db: Db, initiativeID: string): RunRow | undefined {
  return db
    .prepare("SELECT * FROM runs WHERE initiative_id = ? AND status IN ('running', 'interrupted')")
    .get(initiativeID) as RunRow | undefined;
}

export type CreateRunInput = {
  initiativeID: string;
  baseRef: string;
  maxParallel?: number | undefined;
};

export function createRun(db: Db, input: CreateRunInput): RunOk | WorkStoreError {
  const baseRef = input.baseRef.trim();
  if (!baseRef) return { ok: false, error: "base_ref é obrigatório para executar a iniciativa" };
  const initiative = db.prepare("SELECT max_parallel FROM initiatives WHERE id = ?").get(input.initiativeID) as
    | { max_parallel?: number }
    | undefined;
  if (!initiative) return { ok: false, error: `iniciativa não encontrado: ${input.initiativeID}` };
  if (activeRun(db, input.initiativeID)) {
    return { ok: false, error: "já existe um run ativo neste iniciativa; cancele ou aguarde o término" };
  }

  const id = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO runs (id, initiative_id, base_ref, status, max_parallel, merge_session_id, started_at, finished_at, error)
       VALUES (?, ?, ?, 'running', ?, NULL, ?, NULL, NULL)`,
    ).run(id, input.initiativeID, baseRef, clampParallel(input.maxParallel, initiative.max_parallel ?? 2), nowTimestamp());
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  const run = getRun(db, id);
  if (!run) return { ok: false, error: "run não encontrado após a criação" };
  return { ok: true, run };
}

export type SetRunStatusInput = {
  id: string;
  status: RunStatus;
  error?: string | null | undefined;
};

/**
 * Moves the run through running -> (done | failed | cancelled | interrupted)
 * and lets an interrupted run resume. A terminal run never changes again.
 */
export function setRunStatus(db: Db, input: SetRunStatusInput): RunOk | WorkStoreError {
  const current = getRun(db, input.id);
  if (!current) return { ok: false, error: `run não encontrado: ${input.id}` };
  if (RUN_TERMINAL.has(current.status)) {
    return { ok: false, error: `run já terminou: ${current.status}` };
  }
  const allowed = current.status === "running" ? ["done", "failed", "cancelled", "interrupted"] : ["running", "cancelled", "failed"];
  if (!allowed.includes(input.status)) {
    return { ok: false, error: `transição de run inválida: ${current.status} -> ${input.status}` };
  }

  const now = nowTimestamp();
  const finishedAt = RUN_TERMINAL.has(input.status) ? now : null;
  const error = input.error === undefined ? current.error : input.error;
  try {
    db.prepare("UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE id = ?").run(
      input.status,
      finishedAt,
      error,
      input.id,
    );
  } catch (cause) {
    return { ok: false, error: reason(cause) };
  }
  const run = getRun(db, input.id);
  if (!run) return { ok: false, error: "run não encontrado após a mudança de status" };
  return { ok: true, run };
}

export function setRunMergeSession(db: Db, id: string, sessionID: string | null): RunOk | WorkStoreError {
  const current = getRun(db, id);
  if (!current) return { ok: false, error: `run não encontrado: ${id}` };
  try {
    db.prepare("UPDATE runs SET merge_session_id = ? WHERE id = ?").run(sessionID, id);
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  const run = getRun(db, id);
  if (!run) return { ok: false, error: "run não encontrado após vincular a sessão de merge" };
  return { ok: true, run };
}

export type CreateRunItemInput = {
  runID: string;
  workItemID: string;
  planID?: string | undefined;
  branch?: string | undefined;
  worktree?: string | undefined;
};

export function getRunItem(db: Db, runID: string, workItemID: string): RunItemRow | undefined {
  return db
    .prepare("SELECT * FROM run_items WHERE run_id = ? AND work_item_id = ?")
    .get(runID, workItemID) as RunItemRow | undefined;
}

export function listRunItems(db: Db, runID: string): RunItemRow[] {
  return db
    .prepare("SELECT * FROM run_items WHERE run_id = ? ORDER BY work_item_id")
    .all(runID) as RunItemRow[];
}

export function createRunItem(db: Db, input: CreateRunItemInput): RunItemOk | WorkStoreError {
  if (!getRun(db, input.runID)) return { ok: false, error: `run não encontrado: ${input.runID}` };
  if (getRunItem(db, input.runID, input.workItemID)) {
    return { ok: false, error: `o item já está neste run: ${input.workItemID}` };
  }
  try {
    db.prepare(
      `INSERT INTO run_items (run_id, work_item_id, status, plan_id, branch, worktree, session_id, started_at, finished_at, merged_sha, error)
       VALUES (?, ?, 'queued', ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`,
    ).run(
      input.runID,
      input.workItemID,
      input.planID ?? null,
      input.branch ?? null,
      input.worktree ?? null,
    );
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  const item = getRunItem(db, input.runID, input.workItemID);
  if (!item) return { ok: false, error: "item do run não encontrado após a criação" };
  return { ok: true, item };
}

export type SetRunItemStatusInput = {
  runID: string;
  workItemID: string;
  status: RunItemStatus;
  planID?: string | undefined;
  branch?: string | undefined;
  worktree?: string | undefined;
  sessionID?: string | undefined;
  mergedSha?: string | undefined;
  error?: string | null | undefined;
};

/**
 * Patches an item in place. Queuing starts the clock when it leaves `queued`;
 * a finished status stamps `finished_at` once.
 */
export function setRunItemStatus(db: Db, input: SetRunItemStatusInput): RunItemOk | WorkStoreError {
  const current = getRunItem(db, input.runID, input.workItemID);
  if (!current) return { ok: false, error: `item do run não encontrado: ${input.workItemID}` };
  const now = nowTimestamp();
  const startedAt = current.started_at ?? (input.status !== "queued" ? now : null);
  const finishedAt = RUN_ITEM_DONE.has(input.status) ? current.finished_at ?? now : null;
  try {
    db.prepare(
      `UPDATE run_items
          SET status = ?, plan_id = ?, branch = ?, worktree = ?, session_id = ?,
              started_at = ?, finished_at = ?, merged_sha = ?, error = ?
        WHERE run_id = ? AND work_item_id = ?`,
    ).run(
      input.status,
      input.planID ?? current.plan_id,
      input.branch ?? current.branch,
      input.worktree ?? current.worktree,
      input.sessionID ?? current.session_id,
      startedAt,
      finishedAt,
      input.mergedSha ?? current.merged_sha,
      input.error === undefined ? current.error : input.error,
      input.runID,
      input.workItemID,
    );
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  const item = getRunItem(db, input.runID, input.workItemID);
  if (!item) return { ok: false, error: "item do run não encontrado após a atualização" };
  return { ok: true, item };
}

export function getMergeEntry(db: Db, id: string): MergeEntryRow | undefined {
  return db.prepare("SELECT * FROM merge_queue WHERE id = ?").get(id) as MergeEntryRow | undefined;
}

export function listMergeQueue(db: Db, runID: string): MergeEntryRow[] {
  // rowid is insertion order; two enqueues can share the timestamp, so it is
  // what makes the queue FIFO for real.
  return db
    .prepare("SELECT * FROM merge_queue WHERE run_id = ? ORDER BY enqueued_at ASC, rowid ASC")
    .all(runID) as MergeEntryRow[];
}

/** Enqueues an item; enqueuing twice is a no-op. */
export function enqueueMerge(db: Db, input: { runID: string; workItemID: string }): Ok | WorkStoreError {
  if (!getRun(db, input.runID)) return { ok: false, error: `run não encontrado: ${input.runID}` };
  try {
    db.prepare(
      `INSERT OR IGNORE INTO merge_queue (id, run_id, work_item_id, status, enqueued_at, claimed_at, finished_at, error)
       VALUES (?, ?, ?, 'queued', ?, NULL, NULL, NULL)`,
    ).run(crypto.randomUUID(), input.runID, input.workItemID, nowTimestamp());
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  return { ok: true };
}

export type ClaimMergeResult = { ok: true; entry: MergeEntryRow | null } | WorkStoreError;

/**
 * Claims the next queued item, FIFO. Only one `merging` per run: while one is
 * in flight the claim returns null rather than blocking.
 */
export function claimNextMerge(db: Db, runID: string): ClaimMergeResult {
  const busy = db
    .prepare("SELECT id FROM merge_queue WHERE run_id = ? AND status = 'merging' LIMIT 1")
    .get(runID);
  if (busy) return { ok: true, entry: null };

  const next = db
    .prepare(
      "SELECT * FROM merge_queue WHERE run_id = ? AND status = 'queued' ORDER BY enqueued_at ASC, rowid ASC LIMIT 1",
    )
    .get(runID) as MergeEntryRow | undefined;
  if (!next) return { ok: true, entry: null };

  const claimedAt = nowTimestamp();
  try {
    transaction(db, () => {
      const changed = db
        .prepare("UPDATE merge_queue SET status = 'merging', claimed_at = ? WHERE id = ? AND status = 'queued'")
        .run(claimedAt, next.id);
      if (!changed || changed.changes === 0) throw new Error("a fila mudou durante o claim; tente de novo");
    });
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  const entry = db.prepare("SELECT * FROM merge_queue WHERE id = ?").get(next.id) as MergeEntryRow | undefined;
  if (!entry) return { ok: false, error: "entrada da fila não encontrada após o claim" };
  return { ok: true, entry };
}

export type FinishMergeInput = {
  id: string;
  status: "merged" | "failed";
  mergedSha?: string | undefined;
  error?: string | null | undefined;
};

export function finishMerge(db: Db, input: FinishMergeInput): Ok | WorkStoreError {
  const current = db.prepare("SELECT * FROM merge_queue WHERE id = ?").get(input.id) as MergeEntryRow | undefined;
  if (!current) return { ok: false, error: `entrada da fila não encontrada: ${input.id}` };
  if (current.status !== "merging") {
    return { ok: false, error: `a entrada não está em merging: ${current.status}` };
  }
  try {
    db.prepare(
      "UPDATE merge_queue SET status = ?, finished_at = ?, error = ? WHERE id = ? AND status = 'merging'",
    ).run(input.status, nowTimestamp(), input.error ?? null, input.id);
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  return { ok: true };
}

/** A failed merge stops the queue: nothing else is claimed for this run. */
export function stopMergeQueue(db: Db, runID: string, error: string): number {
  const rows = db
    .prepare("SELECT id FROM merge_queue WHERE run_id = ? AND status = 'queued'")
    .all(runID) as { id: string }[];
  if (rows.length === 0) return 0;
  const now = nowTimestamp();
  try {
    transaction(db, () => {
      db.prepare(
        "UPDATE merge_queue SET status = 'failed', finished_at = ?, error = ? WHERE run_id = ? AND status = 'queued'",
      ).run(now, error, runID);
    });
  } catch {
    return 0;
  }
  return rows.length;
}

/* ------------------------------------------------------------------ */
/* Footprint and run settings                                          */
/* ------------------------------------------------------------------ */

export function planTouches(db: Db, planID: string): string[] {
  return (
    db.prepare("SELECT path FROM plan_touches WHERE plan_id = ? ORDER BY path ASC").all(planID) as {
      path: string;
    }[]
  ).map((row) => row.path);
}

/** Replaces the plan's footprint in one transaction. */
export function setPlanTouches(db: Db, planID: string, paths: readonly string[]): Ok | WorkStoreError {
  const clean = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
  try {
    transaction(db, () => {
      db.prepare("DELETE FROM plan_touches WHERE plan_id = ?").run(planID);
      for (const path of clean) {
        db.prepare("INSERT INTO plan_touches (plan_id, path) VALUES (?, ?)").run(planID, path);
      }
    });
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  return { ok: true };
}

export type InitiativeRunSettings = {
  baseBranch?: string | null | undefined;
  maxParallel?: number | undefined;
  verifyCommand?: string | null | undefined;
};

export function setInitiativeRunSettings(
  db: Db,
  initiativeID: string,
  input: InitiativeRunSettings,
): InitiativeOk | WorkStoreError {
  const initiative = getInitiative(db, initiativeID);
  if (!initiative) return { ok: false, error: `iniciativa não encontrado: ${initiativeID}` };
  const baseBranch = input.baseBranch === undefined ? initiative.base_branch : input.baseBranch?.trim() || null;
  const maxParallel =
    input.maxParallel === undefined ? initiative.max_parallel : clampParallel(input.maxParallel, initiative.max_parallel);
  const verifyCommand =
    input.verifyCommand === undefined ? initiative.verify_command : input.verifyCommand?.trim() || null;
  try {
    db.prepare(
      "UPDATE initiatives SET base_branch = ?, max_parallel = ?, verify_command = ?, updated_at = ? WHERE id = ?",
    ).run(baseBranch, maxParallel, verifyCommand, nowTimestamp(), initiativeID);
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
  const updated = getInitiative(db, initiativeID);
  if (!updated) return { ok: false, error: "iniciativa não encontrado após atualizar as configurações" };
  return { ok: true, initiative: updated };
}


export type RecomputeImplicitResult =
  | { ok: true; added: number; edges: { itemID: string; blocksID: string }[] }
  | WorkStoreError;

/**
 * Rebuilds the implicit dependencies of a initiative from the current plans'
 * footprints. Only items that can run (ready/doing/blocked) with a plan take
 * part; an unknown footprint conflicts with everything. Explicit edges are
 * never touched and already order the pairs they connect.
 */
export function recomputeImplicitDeps(db: Db, initiativeID: string): RecomputeImplicitResult {
  if (!getInitiative(db, initiativeID)) return { ok: false, error: `iniciativa não encontrado: ${initiativeID}` };

  const entries: FootprintItem[] = [];
  for (const item of listWorkItems(db, initiativeID)) {
    if (item.status !== "ready" && item.status !== "doing" && item.status !== "blocked") continue;
    const plan = getPlanByWorkItem(db, item.id);
    if (!plan) continue;
    entries.push({
      id: item.id,
      rank: item.rank,
      createdAt: item.created_at,
      touches: plan.touches ?? planTouches(db, plan.id),
    });
  }

  const explicit = (
    db
      .prepare(
        `SELECT d.item_id, d.blocks_id
           FROM work_item_deps d
           JOIN work_items w ON w.id = d.item_id
          WHERE w.initiative_id = ? AND d.kind <> 'implicit'`,
      )
      .all(initiativeID) as { item_id: string; blocks_id: string }[]
  ).map((row) => ({ itemID: row.item_id, blocksID: row.blocks_id }));

  const edges = computeImplicitDeps(entries, explicit);
  try {
    transaction(db, () => {
      db.prepare(
        "DELETE FROM work_item_deps WHERE kind = 'implicit' AND item_id IN (SELECT id FROM work_items WHERE initiative_id = ?)",
      ).run(initiativeID);
      const insert = db.prepare(
        `INSERT OR IGNORE INTO work_item_deps (item_id, blocks_id, kind, reason, created_at)
         VALUES (?, ?, 'implicit', ?, ?)`,
      );
      const now = nowTimestamp();
      for (const edge of edges) insert.run(edge.itemID, edge.blocksID, edge.reason, now);
    });
  } catch (error) {
    return { ok: false, error: reason(error) };
  }

  return { ok: true, added: edges.length, edges: edges.map((edge) => ({ itemID: edge.itemID, blocksID: edge.blocksID })) };
}
