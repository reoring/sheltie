import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrApiError, HerdrClient } from "../src/herdr-client.ts";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function serve(
  responder: (request: Record<string, unknown>) => Record<string, unknown>,
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "sheltie-herdr-client-"));
  roots.push(root);
  const socketPath = join(root, "herdr.sock");
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(input.slice(0, newline)) as Record<string, unknown>;
      socket.end(`${JSON.stringify(responder(request))}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
}

describe("HerdrClient", () => {
  test("sends one NDJSON request and returns its typed result", async () => {
    const socketPath = await serve((request) => ({
      id: request.id,
      result: { type: "pong", version: "0.8.0", protocol: 20, capabilities: null },
    }));
    const client = new HerdrClient(socketPath, { timeoutMs: 1_000 });

    const result = await client.ping();

    expect(result).toMatchObject({ type: "pong", version: "0.8.0", protocol: 20 });
  });

  test("surfaces Herdr error codes without retrying", async () => {
    const socketPath = await serve((request) => ({
      id: request.id,
      error: { code: "linked_worktree_source", message: "use repo parent" },
    }));
    const client = new HerdrClient(socketPath, { timeoutMs: 1_000 });

    try {
      await client.worktreeCreate({ workspace_id: "w2", branch: "child" });
      throw new Error("expected Herdr to reject the request");
    } catch (error) {
      expect(error).toBeInstanceOf(HerdrApiError);
      expect((error as HerdrApiError).code).toBe("linked_worktree_source");
    }
  });
});
