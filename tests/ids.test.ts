import { describe, expect, test } from "bun:test";
import { agentNameForNode, branchForNode, requestHash, worktreePathForBranch } from "../src/ids.ts";

describe("deterministic identities", () => {
  test("derives stable branch, path, and Herdr-safe agent names", () => {
    const branch = branchForNode("sheltie/root", "Parser Child");

    expect(branch).toBe("sheltie/root.parser-child");
    expect(worktreePathForBranch("/tmp/worktrees", branch)).toBe("/tmp/worktrees/sheltie-root-parser-child");
    expect(agentNameForNode("node-1234567890")).toMatch(/^s-[a-z0-9-]{1,30}$/);
    expect(agentNameForNode("node-1234567890").length).toBeLessThanOrEqual(32);
  });

  test("hashes object keys canonically and rejects semantic drift", () => {
    expect(requestHash({ name: "child", limits: { depth: 2, children: 3 } })).toBe(
      requestHash({ limits: { children: 3, depth: 2 }, name: "child" }),
    );
    expect(requestHash({ name: "child" })).not.toBe(requestHash({ name: "other" }));
  });
});
