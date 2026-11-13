import { describe, expect, test } from "bun:test";
import type { Plan } from "../src/gui/contract";
import { groupPlans, projectLabel } from "../src/gui/group";

const plan = (id: string, projectDirectory: string): Plan => ({
  id,
  projectID: `prj-${projectDirectory}`,
  projectDirectory,
  sessionID: "s1",
  title: id,
  body: id,
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  steps: [],
});

const INFRA = "/home/user/dev/agentic-dev-infra";
const TOOLS = "/srv/apps/opencode-tools";

describe("groupPlans", () => {
  test("one section per project, in label order", () => {
    const groups = groupPlans(
      [plan("a", TOOLS), plan("b", INFRA), plan("c", TOOLS)],
      (project) => (project === INFRA ? "aaa" : "zzz"),
    );
    expect(groups.map((group) => group.key)).toEqual([INFRA, TOOLS]);
    expect(groups[1]!.plans.map((item) => item.id)).toEqual(["a", "c"]);
  });

  test("preserves the incoming order inside a group", () => {
    const groups = groupPlans([plan("new", TOOLS), plan("old", TOOLS)]);
    expect(groups[0]!.plans.map((item) => item.id)).toEqual(["new", "old"]);
  });

  test("falls back to the project id when the directory is empty", () => {
    const groups = groupPlans([plan("a", "")]);
    expect(groups[0]!.key).toBe("prj-");
  });

  test("empty input yields no sections", () => {
    expect(groupPlans([])).toEqual([]);
  });
});

describe("projectLabel", () => {
  test("uses the basename when it is unique", () => {
    expect(projectLabel(INFRA, [INFRA, TOOLS])).toBe("agentic-dev-infra");
  });

  test("disambiguates with the parent folder when two paths share a basename", () => {
    const a = "/home/user/one/app";
    const b = "/srv/two/app";
    expect(projectLabel(a, [a, b])).toBe("one/app");
    expect(projectLabel(b, [a, b])).toBe("two/app");
  });
});
