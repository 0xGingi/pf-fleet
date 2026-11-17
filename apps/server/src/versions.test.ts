import { expect, test } from "bun:test";
import { compareVersions, olderThan } from "./versions";

test("orders versions numerically", () => {
  expect(olderThan("0.9.3", "0.10.0")).toBe(true);
  expect(olderThan("0.10.0", "0.9.3")).toBe(false);
  expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  expect(olderThan("1.2", "1.2.1")).toBe(true);
});

test("pre-releases come before the release", () => {
  expect(olderThan("1.0.0-rc.1", "1.0.0")).toBe(true);
  expect(olderThan("1.0.0", "1.0.0-rc.1")).toBe(false);
  expect(olderThan("1.0.0-rc.1", "1.0.0-rc.2")).toBe(true);
});

test("edge builds order by build number, and below the release", () => {
  expect(olderThan("0.2.0-edge.9", "0.2.0-edge.10")).toBe(true);
  expect(olderThan("0.2.0-edge.10", "0.2.0")).toBe(true);
  expect(olderThan("0.2.0", "0.3.0-edge.1")).toBe(true);
  expect(compareVersions("1.0.0-edge.3", "1.0.0-edge.3")).toBe(0);
});
