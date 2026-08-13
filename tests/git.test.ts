import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAll, initDisposableRepo, isCleanWorktree, resolveCommit } from "../src/git.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Git adapter", () => {
  test("creates a reproducible main branch and returns verifiable commits", async () => {
    const root = mkdtempSync(join(tmpdir(), "sheltie-git-test-"));
    roots.push(root);
    const repo = join(root, "repo");

    const initial = await initDisposableRepo(repo);
    expect(await resolveCommit(repo, "main")).toBe(initial);
    expect(await isCleanWorktree(repo)).toBe(true);

    writeFileSync(join(repo, "result.txt"), "done\n");
    expect(await isCleanWorktree(repo)).toBe(false);
    const result = await commitAll(repo, "record result");

    expect(result).not.toBe(initial);
    expect(await resolveCommit(repo, "HEAD")).toBe(result);
    expect(await isCleanWorktree(repo)).toBe(true);
  });
});
