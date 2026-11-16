import { describe, expect, test } from "bun:test";
import { registerTools } from "../index";

type AddedTool = { name: string; options?: { pinned?: boolean; namespace?: string } };

describe("plans tool registration", () => {
  test("pins the essential tools in the Code Mode catalog", async () => {
    const added: AddedTool[] = [];
    const ctx = {
      tool: {
        transform: async (
          fn: (editor: {
            namespace: (input: unknown) => void;
            add: (tool: AddedTool) => void;
          }) => void,
        ) => {
          fn({
            namespace: () => undefined,
            add: (tool) => added.push(tool),
          });
          return { dispose: async () => undefined };
        },
      },
    } as never;

    await registerTools(ctx);

    const pinned = (namespace: string) =>
      added
        .filter((tool) => tool.options?.pinned && tool.options?.namespace === namespace)
        .map((tool) => tool.name);
    expect(pinned("plans")).toEqual(["save", "list", "get", "update", "link"]);
    expect(pinned("initiative")).toEqual(["list", "create"]);
    expect(pinned("work")).toEqual(["list", "get", "save", "update"]);
    expect(pinned("merge")).toEqual(["list", "next", "done", "fail"]);
  });
});
