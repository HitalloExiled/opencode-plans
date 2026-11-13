import { describe, expect, test } from "bun:test";
import type { Plan } from "../src/gui/contract";
import { orderPlans, projectKeyOf, projectLabel } from "../src/gui/order";

const plan = (id: string, projectDirectory: string, updatedAt: string): Plan => ({
  id,
  projectID: `prj-${id}`,
  projectDirectory,
  sessionID: "s1",
  title: id,
  body: id,
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
  steps: [],
});

const INFRA = "/home/user/dev/agentic-trail";
const TOOLS = "/srv/apps/opencode-tools";

describe("orderPlans", () => {
  test("orders by project label, then newest first inside the project", () => {
    const ordered = orderPlans(
      [
        plan("t-old", TOOLS, "2026-01-01T00:00:00.000Z"),
        plan("i-new", INFRA, "2026-03-01T00:00:00.000Z"),
        plan("t-new", TOOLS, "2026-02-01T00:00:00.000Z"),
        plan("i-old", INFRA, "2026-01-15T00:00:00.000Z"),
      ],
      (project) => (project === INFRA ? "aaa" : "zzz"),
    );
    expect(ordered.map((item) => item.id)).toEqual(["i-new", "i-old", "t-new", "t-old"]);
  });

  test("does not mutate the input", () => {
    const input = [plan("b", TOOLS, "2026-01-01T00:00:00.000Z"), plan("a", INFRA, "2026-01-02T00:00:00.000Z")];
    const before = input.map((item) => item.id);
    orderPlans(input);
    expect(input.map((item) => item.id)).toEqual(before);
  });
});

describe("projectKeyOf", () => {
  test("uses the directory, falling back to the project id", () => {
    expect(projectKeyOf(plan("a", TOOLS, "2026-01-01T00:00:00.000Z"))).toBe(TOOLS);
    expect(projectKeyOf({ ...plan("a", "", "2026-01-01T00:00:00.000Z"), projectID: "prj-1" })).toBe("prj-1");
  });
});

describe("projectLabel", () => {
  test("uses the basename when it is unique", () => {
    expect(projectLabel(INFRA, [INFRA, TOOLS])).toBe("agentic-trail");
  });

  test("disambiguates with the parent folder when two paths share a basename", () => {
    const a = "/home/user/one/app";
    const b = "/srv/two/app";
    expect(projectLabel(a, [a, b])).toBe("one/app");
    expect(projectLabel(b, [a, b])).toBe("two/app");
  });
});
