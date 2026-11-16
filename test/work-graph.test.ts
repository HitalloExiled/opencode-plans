import { describe, expect, test } from "bun:test";
import {
  GRAPH_NODE_HEIGHT,
  GRAPH_PAD,
  layoutWorkGraph,
  type GraphNodeInput,
} from "../src/work-graph";

const node = (id: string, rank = 1, createdAt = "2026-01-01T00:00:00.000Z"): GraphNodeInput => ({
  id,
  rank,
  createdAt,
});

const placement = (layout: ReturnType<typeof layoutWorkGraph>, id: string) =>
  layout.placements.find((entry) => entry.id === id);

describe("layoutWorkGraph", () => {
  test("puts a dependency before its dependent", () => {
    const layout = layoutWorkGraph([node("a"), node("b")], [{ itemID: "b", blocksID: "a" }]);
    expect(placement(layout, "a")?.layer).toBe(0);
    expect(placement(layout, "b")?.layer).toBe(1);
    expect(placement(layout, "b")!.x).toBeGreaterThan(placement(layout, "a")!.x);
    expect(layout.layers).toBe(2);
  });

  test("independent items share a layer, in rank order", () => {
    const layout = layoutWorkGraph([node("b", 2), node("a", 1)], []);
    expect(placement(layout, "a")?.row).toBe(0);
    expect(placement(layout, "b")?.row).toBe(1);
    expect(layout.height).toBe(GRAPH_PAD * 2 + 2 * (GRAPH_NODE_HEIGHT + 16) - 16);
  });

  test("a chain stacks the layers", () => {
    const layout = layoutWorkGraph(
      [node("a"), node("b"), node("c")],
      [
        { itemID: "c", blocksID: "b" },
        { itemID: "b", blocksID: "a" },
      ],
    );
    expect([ "a", "b", "c" ].map((id) => placement(layout, id)?.layer)).toEqual([0, 1, 2]);
    expect(layout.layers).toBe(3);
  });

  test("is deterministic regardless of the input order", () => {
    const first = layoutWorkGraph([node("a", 2), node("b", 1)], []);
    const second = layoutWorkGraph([node("b", 1), node("a", 2)], []);
    expect(first.placements).toEqual(second.placements);
  });

  test("a cycle is reported and does not hang", () => {
    const layout = layoutWorkGraph(
      [node("a"), node("b")],
      [
        { itemID: "a", blocksID: "b" },
        { itemID: "b", blocksID: "a" },
      ],
    );
    expect(layout.hasCycle).toBe(true);
    expect(layout.placements).toHaveLength(2);
  });

  test("edges to unknown items are ignored", () => {
    const layout = layoutWorkGraph([node("a")], [{ itemID: "a", blocksID: "ghost" }]);
    expect(placement(layout, "a")?.layer).toBe(0);
  });
});
