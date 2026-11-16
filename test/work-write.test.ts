import { describe, expect, test } from "bun:test";
import {
  MAX_ITEMS_PER_REQUEST,
  BUDGET_WINDOW_MS,
  claimItems,
  findDuplicateItem,
  isTerminalStatus,
  normalizeItemTitle,
  type BudgetEntry,
} from "../src/work-write";
import type { WorkItemRow } from "../src/store";

const item = (id: string, overrides: Partial<WorkItemRow> = {}): WorkItemRow => ({
  id,
  initiative_id: "p1",
  repo_id: null,
  parent_id: null,
  title: `Item ${id}`,
  body: "",
  status: "backlog",
  rank: 1,
  origin: "agent",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  closed_at: null,
  ...overrides,
});

describe("normalizeItemTitle", () => {
  test("ignores case, accents and whitespace runs", () => {
    expect(normalizeItemTitle("  Corrigir  a ACENTUAÇÃO ")).toBe("corrigir a acentuacao");
  });
});

describe("findDuplicateItem", () => {
  test("matches the same parent with a non-terminal status", () => {
    const items = [item("a", { title: "Fix the bug", parent_id: "p" })];
    expect(findDuplicateItem(items, { title: "fix  THE bug", parentID: "p" })?.id).toBe("a");
  });

  test("does not match across parents", () => {
    const items = [item("a", { title: "Fix the bug", parent_id: "p" })];
    expect(findDuplicateItem(items, { title: "Fix the bug", parentID: null })).toBeUndefined();
  });

  test("a done item does not absorb a new need", () => {
    const items = [item("a", { title: "Fix the bug", status: "done" })];
    expect(findDuplicateItem(items, { title: "Fix the bug", parentID: null })).toBeUndefined();
  });
});

describe("isTerminalStatus", () => {
  test("done and dropped are terminal", () => {
    expect(isTerminalStatus("done")).toBe(true);
    expect(isTerminalStatus("dropped")).toBe(true);
    expect(isTerminalStatus("doing")).toBe(false);
    expect(isTerminalStatus("backlog")).toBe(false);
  });
});

describe("claimItems", () => {
  test("accumulates calls from the same request up to the cap", () => {
    const entries = new Map<string, BudgetEntry>();
    const now = 1_000;
    expect(claimItems(entries, "m1", 2, now)).toBe(1);
    expect(claimItems(entries, "m1", 1, now)).toBe(0);
    expect(claimItems(entries, "m1", 1, now)).toBeUndefined();
    expect(entries.get("m1")?.count).toBe(MAX_ITEMS_PER_REQUEST);
  });

  test("requests are independent", () => {
    const entries = new Map<string, BudgetEntry>();
    expect(claimItems(entries, "m1", 3, 1_000)).toBe(0);
    expect(claimItems(entries, "m2", 3, 1_000)).toBe(0);
  });

  test("an expired request frees its budget", () => {
    const entries = new Map<string, BudgetEntry>();
    claimItems(entries, "m1", 3, 1_000);
    expect(claimItems(entries, "m1", 3, 1_000 + BUDGET_WINDOW_MS + 1)).toBe(0);
  });
});
