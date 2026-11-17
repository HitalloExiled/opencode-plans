import { describe, expect, test } from "bun:test";
import { planContext, type PlanContextInput } from "../src/gui/plan-context";
import type { Translate } from "../src/gui/execute";

const KEYS: Record<string, string> = {
  "work.plan.context.title": "## Context",
  "work.plan.context.repo": "Repository: {0}",
  "work.plan.context.initiative": "Initiative: {0}",
  "work.plan.context.overview": "Overview:",
  "work.plan.context.map": "Work map ({0} cards):",
  "work.plan.context.read": "Read the repository before planning.",
  "work.plan.context.touches": "Declare `touches` in `plans.save`.",
  "work.map.blockedBy": "blocked by",
  "work.map.more": "+{0} more cards",
};

const t: Translate = (key, ...args) => {
  let out = KEYS[key] ?? key;
  args.forEach((arg, index) => (out = out.replaceAll(`{${index}}`, String(arg))));
  return out;
};

const initiative = { name: "Todo List", overview: "# What\n\nA todo app." };
const map = [
  { id: "a", title: "Base", status: "done" as const, blockedBy: [] },
  {
    id: "b",
    title: "Search",
    status: "ready" as const,
    blockedBy: [{ title: "Base", status: "done" as const }],
  },
];

describe("planContext", () => {
  test("brings the repository, the initiative, the overview and the map", () => {
    const out = planContext({ repo: "/work/app", initiative, map }, t);
    expect(out).toContain("## Context");
    expect(out).toContain("Repository: /work/app");
    expect(out).toContain("Initiative: Todo List");
    expect(out).toContain("Overview:\n\n# What");
    expect(out).toContain("Work map (2 cards):");
    expect(out).toContain("- [ready] Search — blocked by Base (done)");
    expect(out).toContain("Read the repository before planning.");
    expect(out).toContain("Declare `touches` in `plans.save`.");
  });

  test("skips the empty sections instead of printing placeholders", () => {
    const out = planContext({ initiative: { name: "Empty" }, map: [] }, t);
    expect(out).toContain("Initiative: Empty");
    expect(out).not.toContain("Repository:");
    expect(out).not.toContain("Overview:");
    expect(out).not.toContain("Work map");
  });

  test("caps a long overview and a long map", () => {
    const long = "x".repeat(6500);
    const many = Array.from({ length: 45 }, (_, index): PlanContextInput["map"][number] => ({
      id: `i${index}`,
      title: `Item ${index}`,
      status: "backlog",
      blockedBy: [],
    }));
    const out = planContext({ repo: "/work/app", initiative: { name: "Big", overview: long }, map: many }, t);
    expect(out.includes("x".repeat(6001))).toBe(false);
    expect(out).toContain("…");
    expect(out).toContain("Work map (45 cards):");
    expect(out).toContain("+5 more cards");
  });
});
