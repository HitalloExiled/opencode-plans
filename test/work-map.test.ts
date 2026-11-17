import { describe, expect, test } from "bun:test";
import { renderInitiativeMap, type MapLabels } from "../src/work-map";

const labels: MapLabels = { blockedBy: "blocked by", more: "+{0} more" };

describe("renderInitiativeMap", () => {
  test("renders status, title and blockers", () => {
    const out = renderInitiativeMap(
      [
        { title: "Base", status: "done", blockedBy: [] },
        { title: "Search", status: "ready", blockedBy: [{ title: "Base", status: "done" }] },
      ],
      labels,
    );
    expect(out).toBe("- [done] Base\n- [ready] Search — blocked by Base (done)");
  });

  test("an empty initiative renders nothing", () => {
    expect(renderInitiativeMap([], labels)).toBe("");
  });

  test("caps the map and counts what is left", () => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      title: `Item ${index}`,
      status: "backlog",
      blockedBy: [],
    }));
    const out = renderInitiativeMap(items, labels, 3).split("\n");
    expect(out).toHaveLength(4);
    expect(out[3]).toBe("- +2 more");
  });

  test("the labels come from the caller, so the server and the GUI localize", () => {
    const out = renderInitiativeMap(
      [{ title: "Busca", status: "ready", blockedBy: [{ title: "Base", status: "doing" }] }],
      { blockedBy: "bloqueado por", more: "+{0} itens" },
    );
    expect(out).toBe("- [ready] Busca — bloqueado por Base (doing)");
  });
});
