import { describe, expect, test } from "bun:test";
import {
  computeImplicitDeps,
  findDependencyCycle,
  overlapPaths,
  type FootprintItem,
} from "../src/work-footprint";

const item = (id: string, touches: string[], overrides: Partial<FootprintItem> = {}): FootprintItem => ({
  id,
  rank: Number(id.replace(/\D/g, "")) || 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  touches,
  ...overrides,
});

describe("overlapPaths", () => {
  test("an exact path matches another exact path", () => {
    expect(overlapPaths(["src/a.ts"], ["src/a.ts"])).toEqual(["src/a.ts ∩ src/a.ts"]);
    expect(overlapPaths(["src/a.ts"], ["src/b.ts"])).toEqual([]);
  });

  test("a glob matches an exact path under it", () => {
    expect(overlapPaths(["src/*.ts"], ["src/a.ts"])).toHaveLength(1);
    expect(overlapPaths(["src/*.ts"], ["src/deep/a.ts"])).toEqual([]);
    expect(overlapPaths(["src/**"], ["src/deep/a.ts"])).toHaveLength(1);
    expect(overlapPaths(["docs/*.md"], ["src/a.ts"])).toEqual([]);
  });

  test("two globs overlap when their literal prefixes are compatible", () => {
    expect(overlapPaths(["src/**"], ["src/*.ts"])).toHaveLength(1);
    expect(overlapPaths(["app/**"], ["docs/**"])).toEqual([]);
  });

  test("an empty footprint is a wildcard", () => {
    expect(overlapPaths([], ["src/a.ts"])).toEqual(["*"]);
    expect(overlapPaths(["src/a.ts"], [])).toEqual(["*"]);
  });
});

describe("computeImplicitDeps", () => {
  test("the later item depends on the earlier one", () => {
    const edges = computeImplicitDeps(
      [item("i1", ["src/**"]), item("i2", ["src/a.ts"])],
      [],
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.itemID).toBe("i2");
    expect(edges[0]?.blocksID).toBe("i1");
    expect(JSON.parse(edges[0]!.reason)).toEqual(["src/** ∩ src/a.ts"]);
  });

  test("ties fall back to created_at and then id", () => {
    const edges = computeImplicitDeps(
      [
        item("b", ["src/**"], { rank: 1, createdAt: "2026-01-02T00:00:00.000Z" }),
        item("a", ["src/x.ts"], { rank: 1, createdAt: "2026-01-01T00:00:00.000Z" }),
      ],
      [],
    );
    expect(edges[0]?.itemID).toBe("b");
    expect(edges[0]?.blocksID).toBe("a");
  });

  test("a pair the explicit graph already ordered gains no implicit edge", () => {
    expect(
      computeImplicitDeps([item("i1", ["src/**"]), item("i2", ["src/a.ts"])], [{ itemID: "i1", blocksID: "i2" }]),
    ).toEqual([]);
    expect(
      computeImplicitDeps([item("i1", ["src/**"]), item("i2", ["src/a.ts"])], [{ itemID: "i2", blocksID: "i1" }]),
    ).toEqual([]);
  });

  test("disjoint footprints run in parallel", () => {
    expect(computeImplicitDeps([item("i1", ["src/**"]), item("i2", ["docs/**"])], [])).toEqual([]);
  });

  test("unknown footprints serialize against everyone", () => {
    const edges = computeImplicitDeps(
      [item("i1", []), item("i2", ["src/a.ts"]), item("i3", [])],
      [],
    );
    // i1 is first; i2 and i3 depend on the previous ones in rank order.
    expect(edges.map((edge) => `${edge.itemID}<-${edge.blocksID}`)).toEqual(["i2<-i1", "i3<-i1", "i3<-i2"]);
  });

  test("edges never point backwards, so repeating the computation is stable", () => {
    const items = [item("i1", ["src/**"]), item("i2", ["src/**.ts"]), item("i3", ["src/a.ts"])];
    const first = computeImplicitDeps(items, []);
    const second = computeImplicitDeps(items, first);
    expect(second).toEqual([]);
  });
});

describe("findDependencyCycle", () => {
  test("reports a cycle with the ids in order", () => {
    expect(
      findDependencyCycle([
        { itemID: "a", blocksID: "b" },
        { itemID: "b", blocksID: "c" },
        { itemID: "c", blocksID: "a" },
      ]),
    ).toEqual(["a", "b", "c", "a"]);
  });

  test("a chain is not a cycle", () => {
    expect(
      findDependencyCycle([
        { itemID: "a", blocksID: "b" },
        { itemID: "b", blocksID: "c" },
      ]),
    ).toBeUndefined();
  });
});
