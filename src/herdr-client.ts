import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

export interface HerdrClientOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class HerdrApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId: string,
  ) {
    super(message);
    this.name = "HerdrApiError";
  }
}

interface HerdrErrorResponse {
  id: string;
  error: { code: string; message: string };
}

interface HerdrSuccessResponse<T> {
  id: string;
  result: T;
}

export interface PongResult {
  type: "pong";
  version: string;
  protocol: number;
  capabilities: Record<string, unknown> | null;
}

export interface WorkspaceInfo {
  workspace_id: string;
  label: string;
  focused: boolean;
  active_tab_id: string;
  worktree?: {
    repo_root: string;
    checkout_path: string;
    is_linked_worktree: boolean;
  };
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
}

export interface PaneInfo {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  cwd?: string;
  agent?: string;
  agent_status: "idle" | "working" | "blocked" | "done" | "unknown";
}

export interface AgentInfo {
  terminal_id: string;
  agent_instance_id?: string;
  name?: string;
  agent?: string;
  agent_status: "idle" | "working" | "blocked" | "done" | "unknown";
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  launch_pending: boolean;
  interactive_ready: boolean;
  agent_session?: { source: string; agent: string; kind: "id" | "path"; value: string };
}

export interface WorktreeInfo {
  path: string;
  branch?: string;
  is_bare: boolean;
  is_detached: boolean;
  is_prunable: boolean;
  is_linked_worktree: boolean;
  open_workspace_id?: string;
  label: string;
}

export interface SessionSnapshot {
  version: string;
  protocol: number;
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  agents: AgentInfo[];
}

export class HerdrClient {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    readonly socketPath: string,
    options: HerdrClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 16 * 1024 * 1024;
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = `sheltie:${randomUUID()}`;
    const payload = `${JSON.stringify({ id, method, params })}\n`;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let socket: Socket;
      let buffer = "";
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        action();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`${method} timed out after ${this.timeoutMs}ms`))),
        this.timeoutMs,
      );
      socket = createConnection(this.socketPath);
      socket.setEncoding("utf8");
      socket.once("connect", () => socket.write(payload));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > this.maxResponseBytes) {
          finish(() => reject(new Error(`${method} response exceeded ${this.maxResponseBytes} bytes`)));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        let response: HerdrErrorResponse | HerdrSuccessResponse<T>;
        try {
          response = JSON.parse(buffer.slice(0, newline)) as HerdrErrorResponse | HerdrSuccessResponse<T>;
        } catch (error) {
          finish(() => reject(new Error(`${method} returned invalid JSON`, { cause: error })));
          return;
        }
        if (response.id !== id) {
          finish(() => reject(new Error(`${method} response id mismatch`)));
          return;
        }
        if ("error" in response) {
          finish(() => reject(new HerdrApiError(response.error.code, response.error.message, id)));
          return;
        }
        finish(() => resolve(response.result));
      });
      socket.once("error", (error) => finish(() => reject(error)));
      socket.once("end", () => {
        if (buffer.indexOf("\n") === -1) finish(() => reject(new Error(`${method} connection closed before a response`)));
      });
    });
  }

  ping(): Promise<PongResult> {
    return this.request("ping", {});
  }

  async snapshot(): Promise<SessionSnapshot> {
    const result = await this.request<{ type: "session_snapshot"; snapshot: SessionSnapshot }>(
      "session.snapshot",
      {},
    );
    return result.snapshot;
  }

  workspaceCreate(params: {
    cwd: string;
    focus?: boolean;
    label?: string;
    env?: Record<string, string>;
  }): Promise<{ type: "workspace_created"; workspace: WorkspaceInfo; tab: TabInfo; root_pane: PaneInfo }> {
    return this.request("workspace.create", params);
  }

  worktreeList(params: { workspace_id?: string; cwd?: string }): Promise<{
    type: "worktree_list";
    source: { repo_root: string; source_workspace_id?: string };
    worktrees: WorktreeInfo[];
  }> {
    return this.request("worktree.list", params);
  }

  worktreeCreate(params: {
    workspace_id: string;
    branch: string;

    base?: string;
    path?: string;
    label?: string;
    focus?: boolean;
  }): Promise<{
    type: "worktree_created";
    workspace: WorkspaceInfo;
    tab: TabInfo;
    root_pane: PaneInfo;
    worktree: WorktreeInfo;
  }> {
    return this.request("worktree.create", params);
  }
  serverStop(): Promise<{ type: "ok" }> {
    return this.request("server.stop", {});
  }

  agentStart(params: {
    name: string;
    kind: string;
    pane_id: string;
    args?: string[];
    timeout_ms?: number;
  }): Promise<{ type: "agent_started"; agent: AgentInfo; argv: string[] }> {
    return this.request("agent.start", params);
  }

  agentGet(target: string): Promise<{ type: "agent_info"; agent: AgentInfo }> {
    return this.request("agent.get", { target });
  }

  agentPrompt(params: {
    target: string;
    text: string;
    client_operation_id?: string;
    wait?: { until?: AgentInfo["agent_status"][]; timeout_ms?: number };
  }): Promise<{
    type: "agent_prompted";
    agent: AgentInfo;
    turn_id: string;
    client_operation_id?: string;
    duplicate: boolean;
  }> {
    return this.request("agent.prompt", params);
  }

  agentInterrupt(params: {
    target: string;
    client_operation_id: string;
    expected_terminal_id: string;
    expected_agent_instance_id: string;
  }): Promise<{
    type: "agent_controlled";
    action: "interrupt" | "terminate";
    client_operation_id: string;
    terminal_id: string;
    agent_instance_id: string;
    outcome: "interrupt_sent" | "terminate_sent" | "kill_sent" | "already_stopped";
    duplicate: boolean;
  }> {
    return this.request("agent.interrupt", params);
  }

  agentTerminate(params: {
    target: string;
    client_operation_id: string;
    expected_terminal_id: string;
    expected_agent_instance_id: string;
    force: boolean;
  }): Promise<{
    type: "agent_controlled";
    action: "interrupt" | "terminate";
    client_operation_id: string;
    terminal_id: string;
    agent_instance_id: string;
    outcome: "interrupt_sent" | "terminate_sent" | "kill_sent" | "already_stopped";
    duplicate: boolean;
  }> {
    return this.request("agent.terminate", params);
  }

  agentWait(params: {
    target: string;
    until?: AgentInfo["agent_status"][];
    timeout_ms?: number;
  }): Promise<{ type: "agent_info"; agent: AgentInfo }> {
    return this.request("agent.wait", params);
  }
}
