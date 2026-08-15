import type { NodeRecord, OperationRecord, TreeRecord } from "./db.ts";
import { SheltieStore } from "./db.ts";
import { HerdrApiError, type AgentInfo, type PongResult } from "./herdr-client.ts";
import { operationIdForRequest, requestHash } from "./ids.ts";

export interface QuiesceAgentControlResult {
  type: "agent_controlled";
  action: "interrupt" | "terminate";
  client_operation_id: string;
  terminal_id: string;
  agent_instance_id: string;
  outcome: "interrupt_sent" | "terminate_sent" | "kill_sent" | "already_stopped";
  duplicate: boolean;
}

export interface QuiesceHerdrControl {
  ping(): Promise<PongResult>;
  agentGet(target: string): Promise<{ type: "agent_info"; agent: AgentInfo }>;
  agentWait(params: {
    target: string;
    until?: AgentInfo["agent_status"][];
    timeout_ms?: number;
  }): Promise<{ type: "agent_info"; agent: AgentInfo }>;
  agentTerminate(params: {
    target: string;
    client_operation_id: string;
    expected_terminal_id: string;
    expected_agent_instance_id: string;
    force: boolean;
  }): Promise<QuiesceAgentControlResult>;
}

export interface QuiesceControllerOptions {
  graceMs?: number;
  forceWaitMs?: number;
}

export interface QuiesceRunResult {
  tree: TreeRecord;
  nodes: NodeRecord[];
  receipts: OperationRecord[];
  unresolvedOperations: OperationRecord[];
}

class QuiesceBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuiesceBlockedError";
  }
}

const QUIESCIBLE_TREE_STATUSES = new Set(["completed", "failed", "cancelled"]);

export class QuiesceController {
  private readonly graceMs: number;
  private readonly forceWaitMs: number;

  constructor(
    private readonly store: SheltieStore,
    private readonly herdr: QuiesceHerdrControl,
    options: QuiesceControllerOptions = {},
  ) {
    this.graceMs = options.graceMs ?? 5_000;
    this.forceWaitMs = options.forceWaitMs ?? 1_000;
    if (!Number.isInteger(this.graceMs) || this.graceMs < 1 || this.graceMs > 30_000) {
      throw new Error("graceMs must be an integer from 1 to 30000");
    }
    if (!Number.isInteger(this.forceWaitMs) || this.forceWaitMs < 1 || this.forceWaitMs > 30_000) {
      throw new Error("forceWaitMs must be an integer from 1 to 30000");
    }
  }

  async quiesceRun(): Promise<QuiesceRunResult> {
    const tree = this.store.getOnlyTree();
    if (!QUIESCIBLE_TREE_STATUSES.has(tree.status)) {
      throw new Error(`run quiesce requires a terminal tree; ${tree.treeId} is ${tree.status}`);
    }
    const pong = await this.herdr.ping();
    if (pong.capabilities?.agent_control !== true) {
      throw new Error("Herdr runtime does not advertise agent_control capability");
    }
    if (pong.version !== tree.herdrVersion || pong.protocol !== tree.herdrProtocol) {
      throw new Error(
        `Herdr runtime changed from ${tree.herdrVersion}/protocol-${tree.herdrProtocol} to ${pong.version}/protocol-${pong.protocol}`,
      );
    }
    const nodes = this.store
      .listNodes(tree.treeId)
      .toSorted((left, right) => right.depth - left.depth || left.nodeId.localeCompare(right.nodeId));
    for (const node of nodes) await this.quiesceNode(node);
    return this.status();
  }

  status(): QuiesceRunResult {
    const tree = this.store.getOnlyTree();
    return {
      tree,
      nodes: this.store.listNodes(tree.treeId),
      receipts: this.store.listOperations(tree.treeId).filter((operation) => operation.kind === "quiesce"),
      unresolvedOperations: this.store.listUnresolvedOperations(tree.treeId),
    };
  }

  private async quiesceNode(node: NodeRecord): Promise<void> {
    if (
      node.agentName === null &&
      node.terminalId === null &&
      node.agentInstanceId === null
    ) {
      return;
    }
    if (node.agentName === null || node.terminalId === null || node.agentInstanceId === null) {
      throw new Error(`node ${node.nodeId} has incomplete Agent identity and cannot be quiesced`);
    }
    const request = {
      nodeId: node.nodeId,
      agentName: node.agentName,
      terminalId: node.terminalId,
      agentInstanceId: node.agentInstanceId,
      generation: node.generation,
    };
    const operationId = operationIdForRequest(node.treeId, "quiesce", node.nodeId);
    let operation = this.store.reserveOperation({
      operationId,
      treeId: node.treeId,
      nodeId: node.nodeId,
      kind: "quiesce",
      requestKey: node.nodeId,
      requestHash: requestHash(request),
      request,
    });
    if (operation.status === "completed" || operation.status === "blocked") return;
    if (operation.status === "reserved") {
      operation = this.store.setOperationStatus(operation.operationId, "submitted", { incrementAttempt: true });
    }

    let reconciled = operation.status === "delivery_unknown";
    try {
      if (!(await this.sameInstanceActive(node))) {
        this.completeOperation(operation, node, false, true);
        return;
      }
      reconciled = (await this.sendTerminate(operation, node, false)) || reconciled;
      await this.waitForExit(node, this.graceMs);
      if (!(await this.sameInstanceActive(node))) {
        this.completeOperation(operation, node, false, reconciled);
        return;
      }
      reconciled = (await this.sendTerminate(operation, node, true)) || reconciled;
      await this.waitForExit(node, this.forceWaitMs);
      if (await this.sameInstanceActive(node)) {
        throw new QuiesceBlockedError(
          `agent instance ${node.agentInstanceId} remained active after forced quiesce`,
        );
      }
      this.completeOperation(operation, node, true, reconciled);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setOperationStatus(
        operation.operationId,
        error instanceof QuiesceBlockedError ? "blocked" : "delivery_unknown",
        { lastError: message },
      );
    }
  }

  private async sendTerminate(
    operation: OperationRecord,
    node: NodeRecord,
    force: boolean,
  ): Promise<boolean> {
    if (node.agentName === null || node.terminalId === null || node.agentInstanceId === null) {
      throw new Error(`node ${node.nodeId} lost its Agent identity during quiesce`);
    }
    try {
      await this.herdr.agentTerminate({
        target: node.agentName,
        client_operation_id: `${operation.operationId}:${force ? "kill" : "terminate"}`,
        expected_terminal_id: node.terminalId,
        expected_agent_instance_id: node.agentInstanceId,
        force,
      });
      return false;
    } catch (error) {
      if (!(error instanceof HerdrApiError) || error.code !== "agent_control_delivery_unknown") throw error;
      return true;
    }
  }

  private completeOperation(
    operation: OperationRecord,
    node: NodeRecord,
    forced: boolean,
    reconciled: boolean,
  ): void {
    this.store.setOperationStatus(operation.operationId, "completed", {
      result: {
        nodeId: node.nodeId,
        terminalId: node.terminalId,
        agentInstanceId: node.agentInstanceId,
        forced,
        reconciled,
      },
      lastError: null,
    });
  }

  private async sameInstanceActive(node: NodeRecord): Promise<boolean> {
    if (node.agentName === null) return false;
    try {
      const current = (await this.herdr.agentGet(node.agentName)).agent;
      if (
        current.terminal_id !== node.terminalId ||
        current.agent_instance_id !== node.agentInstanceId
      ) {
        throw new QuiesceBlockedError(
          `agent identity changed from ${node.terminalId}/${node.agentInstanceId} to ${current.terminal_id}/${current.agent_instance_id ?? "missing"}`,
        );
      }
      return true;
    } catch (error) {
      if (error instanceof HerdrApiError && ["agent_not_found", "agent_not_running"].includes(error.code)) return false;
      throw error;
    }
  }

  private async waitForExit(node: NodeRecord, timeoutMs: number): Promise<void> {
    if (node.agentName === null) return;
    try {
      await this.herdr.agentWait({
        target: node.agentName,
        until: ["unknown"],
        timeout_ms: timeoutMs,
      });
    } catch (error) {
      if (
        error instanceof HerdrApiError &&
        ["timeout", "agent_not_found", "agent_not_running"].includes(error.code)
      ) return;
      throw error;
    }
  }
}
