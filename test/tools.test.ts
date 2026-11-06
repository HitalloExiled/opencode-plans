import { describe, expect, test } from "bun:test";
import { getTool } from "../plans";

const input = getTool({} as never).input;

describe("plans.get input", () => {
  test("accepts the documented object form", () => {
    expect(input.parse({ id: "abc", scope: "project" })).toEqual({
      id: "abc",
      scope: "project",
    });
  });

  test("accepts a bare plan id and defaults scope to session", () => {
    expect(input.parse("b51ed74e-0812-47ef-a664-d1d8799f390a")).toEqual({
      id: "b51ed74e-0812-47ef-a664-d1d8799f390a",
      scope: "session",
    });
  });

  test("defaults scope to session in the object form", () => {
    expect(input.parse({ id: "abc" })).toEqual({ id: "abc", scope: "session" });
  });

  test("rejects an empty id", () => {
    expect(() => input.parse("")).toThrow();
  });
});
