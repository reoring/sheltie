import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertPrivateStateDirectory,
  assertPrivateStateParentForDatabase,
  createPrivateStateDirectory,
} from "../src/state-security.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("private state directory security", () => {
  test("creates a missing final state directory with mode 0700", () => {
    const root = temporaryRoot("sheltie-state-security-create-");
    const stateDirectory = join(root, "default", "run-state");

    expect(createPrivateStateDirectory(stateDirectory)).toBe(resolve(stateDirectory));
    expect(lstatSync(stateDirectory).isDirectory()).toBe(true);
    expect(lstatSync(stateDirectory).mode & 0o777).toBe(0o700);
    expect(existsSync(join(stateDirectory, "state.sqlite"))).toBe(false);
  });

  test("rejects an existing group-readable state root without changing it", () => {
    const root = temporaryRoot("sheltie-state-security-mode-");
    const stateDirectory = join(root, "state");
    mkdirSync(stateDirectory, { mode: 0o700 });
    chmodSync(stateDirectory, 0o755);

    expect(() => createPrivateStateDirectory(stateDirectory)).toThrow("grants group or other access");
    expect(lstatSync(stateDirectory).mode & 0o777).toBe(0o755);
    expect(existsSync(join(stateDirectory, "state.sqlite"))).toBe(false);
  });

  test("rejects a symlinked state root without following it", () => {
    const root = temporaryRoot("sheltie-state-security-symlink-");
    const target = join(root, "target");
    const stateDirectory = join(root, "state");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, stateDirectory);

    expect(() => createPrivateStateDirectory(stateDirectory)).toThrow("must not be a symbolic link");
    expect(existsSync(join(target, "state.sqlite"))).toBe(false);
  });

  test("rejects a state directory that is not owned by the effective uid", () => {
    if (typeof process.geteuid !== "function") return;
    const root = temporaryRoot("sheltie-state-security-owner-");
    const stateDirectory = join(root, "state");
    mkdirSync(stateDirectory, { mode: 0o700 });
    const uid = process.geteuid();
    const geteuid = spyOn(process, "geteuid").mockReturnValue(uid + 1);
    try {
      expect(() => assertPrivateStateDirectory(stateDirectory)).toThrow("not owned by the effective uid");
      expect(existsSync(join(stateDirectory, "state.sqlite"))).toBe(false);
    } finally {
      geteuid.mockRestore();
    }
  });

  test("fails closed when the effective uid is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "geteuid");
    if (descriptor === undefined || !descriptor.configurable) return;

    const root = temporaryRoot("sheltie-state-security-effective-uid-");
    const stateDirectory = join(root, "state");
    mkdirSync(stateDirectory, { mode: 0o700 });
    Object.defineProperty(process, "geteuid", { ...descriptor, value: undefined });
    try {
      expect(() => assertPrivateStateDirectory(stateDirectory)).toThrow("effective uid is unavailable");
    } finally {
      Object.defineProperty(process, "geteuid", descriptor);
    }
  });

  test("validates the database parent before a database path can be used", () => {
    const root = temporaryRoot("sheltie-state-security-parent-");
    const stateDirectory = join(root, "state");
    mkdirSync(stateDirectory, { mode: 0o700 });

    expect(assertPrivateStateParentForDatabase(join(stateDirectory, "state.sqlite"))).toBe(
      resolve(stateDirectory, "state.sqlite"),
    );
  });
});
