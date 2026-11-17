import { describe, expect, test } from "bun:test";
import { laneProblem, type NodeLanes } from "./lanes";

const lane = (name: string, enabled = true) => ({ name, enabled, drain: false });
const node = (id: string, accountId: string | null, ...lanes: ReturnType<typeof lane>[]): NodeLanes => ({ id, name: id, accountId, lanes });

describe("laneProblem", () => {
  const a = node("a", "acct", lane("a-1"), lane("a-2"));

  test("fine within the per-account cap", () => {
    expect(laneProblem(node("b", "acct", lane("b-1")), [a])).toBeNull();
  });

  test("more than 3 enabled lanes on one account", () => {
    expect(laneProblem(node("b", "acct", lane("b-1"), lane("b-2")), [a])).toContain("allows 3");
  });

  test("disabled lanes do not count toward the cap", () => {
    expect(laneProblem(node("b", "acct", lane("b-1"), lane("b-2", false)), [a])).toBeNull();
  });

  test("other accounts do not count", () => {
    expect(laneProblem(node("b", "other", lane("b-1"), lane("b-2"), lane("b-3")), [a])).toBeNull();
  });

  test("lane names are unique per account", () => {
    expect(laneProblem(node("b", "acct", lane("a-1")), [a])).toContain("already used");
    expect(laneProblem(node("b", "other", lane("a-1")), [a])).toBeNull();
  });

  test("names follow pf's rule and are unique on the node", () => {
    expect(laneProblem(node("b", "acct", lane("bad name")), [])).toContain("letters");
    expect(laneProblem(node("b", "acct", lane("x"), lane("x", false)), [])).toContain("twice");
  });

  test("editing a node does not clash with itself", () => {
    expect(laneProblem(a, [a])).toBeNull();
  });

  test("enabled lanes need an account", () => {
    expect(laneProblem(node("b", null, lane("b-1")), [])).toContain("account");
    expect(laneProblem(node("b", null, lane("b-1", false)), [])).toBeNull();
  });
});
