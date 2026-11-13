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
import { join } from "node:path";

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

export const SCHEMA_VERSION = 2;

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
    completed_at TEXT
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
];

function apply(db: Db, statements: readonly string[]): void {
  for (const sql of statements) db.prepare(sql).run();
}

// v2 — `abandoned` became `archived`. Values are rewritten in place so the
// tool/UI status union has a single spelling.
const MIGRATION_002 = [`UPDATE plans SET status = 'archived' WHERE status = 'abandoned'`];

export function initSchema(db: Db): void {
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
};

export type StepRow = {
  plan_id: string;
  position: number;
  step_id: string;
  text: string;
  status: StepStatus;
};

export type Plan = PlanRow & { steps: StepRow[] };

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
  const byText = new Map<string, StepRow>();
  for (const step of existing) byText.set(normalizeStepText(step.text), step);
  return parsed.map((step, index) => {
    const match = byText.get(normalizeStepText(step.text)) ?? existing[index];
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
  return { ...row, steps: stepsForPlans(db, [id]).get(id) ?? [] };
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
           SET title = ?, body = ?, status = ?, updated_at = ?, completed_at = ?, message_id = ?
           WHERE id = ?`,
        ).run(title, storedBody, status, now, completedAt, input.messageID ?? existing.message_id, id);
        db.prepare("DELETE FROM plan_steps WHERE plan_id = ?").run(id);
      } else {
        db.prepare(
          `INSERT INTO plans
             (id, project_id, project_directory, session_id, message_id, title, body, status,
              created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        );
      }

      const insert = db.prepare(
        `INSERT INTO plan_steps (plan_id, position, step_id, text, status)
         VALUES (?, ?, ?, ?, ?)`,
      );
      steps.forEach((step, index) => insert.run(id, index, `s${index + 1}`, step.text, step.status));
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
