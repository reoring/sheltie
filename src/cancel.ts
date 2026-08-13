import type { NodeRecord, OperationRecord } from "./db.ts";
import { SheltieStore } from "./db.ts";
import { HerdrApiError, type AgentInfo, type PongResult } from "./herdr-client.ts";
import { operationIdForRequest, requestHash } from "./ids.ts";
import type { RealRunStatus } from "./run.ts";

export interface AgentControlResult {
  type: "agent_controlled";
  action: "interrupt" | "terminate";
  client_operation_id: string;
  terminal_id: string;
  agent_instance_id: string;
  outcome: "interrupt_sent" | "terminate_sent" | "kill_sent" | "already_stopped";
  duplicate: boolean;
}

export interface CancellationHerdrControl {
  ping(): Promise<PongResult>;
  agentGet(target: string): Promise<{ type: "agent_info"; agent: AgentInfo }>;
  agentWait(params: {
    target: string;
    until?: AgentInfo["agent_status"][];
    timeout_ms?: number;
  }): Promise<{ type: "agent_info"; agent: AgentInfo }>;
  agentInterrupt(params: {
    target: string;
    client_operation_id: string;
    expected_terminal_id: string;
    expected_agent_instance_id: string;
  }): Promise<AgentControlResult>;
  agentTerminate(params: {
    target: string;
    client_operation_id: string;
    expected_terminal_id: string;
    expected_agent_instance_id: string;
    force: boolean;
  }): Promise<AgentControlResult>;
}

export interface CancellationControllerOptions {
  graceMs?: number;
  forceWaitMs?: number;
}

const TERMINAL_NODE_STATES = new Set(["completed", "failed", "cancelled"]);
const CANCELLATION_TREE_STATES = new Set([
  "cancel_requested",
  "cancelling",
  "cancelled",
  "cancel_blocked",
]);

export class CancellationController {
  private readonly graceMs: number;
  private readonly forceWaitMs: number;

  constructor(
    private readonly store: SheltieStore,
    private readonly herdr: CancellationHerdrControl,
    options: CancellationControllerOptions = {},
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

  async cancelRun(): Promise<RealRunStatus> {
    const pong = await this.herdr.ping();
    if (pong.capabilities?.agent_control !== true) {
      throw new Error("Herdr runtime does not advertise agent_control capability");
    }
    this.store.requestCancellation();
    return this.convergeOnce();
  }

  async convergeOnce(): Promise<RealRunStatus> {
    let tree = this.store.getOnlyTree();
    if (tree.status === "completed" || tree.status === "failed" || tree.status === "cancelled") {
      return this.status();
    }
    if (!CANCELLATION_TREE_STATES.has(tree.status)) this.store.requestCancellation();
    tree = this.store.setTreeStatus(tree.treeId, "cancelling");
    const nodes = this.store.listNodes(tree.treeId).toSorted((left, right) => right.depth - left.depth);
    for (const node of nodes) {
      if (TERMINAL_NODE_STATES.has(node.lifecycleStatus)) continue;
      await this.cancelNode(node);
    }
    const current = this.store.listNodes(tree.treeId);
    if (current.some((node) => node.lifecycleStatus === "cancel_blocked")) {
      this.store.setTreeStatus(tree.treeId, "cancel_blocked");
    } else if (current.every((node) => TERMINAL_NODE_STATES.has(node.lifecycleStatus))) {
      this.store.setTreeStatus(tree.treeId, "cancelled");
    }
    return this.status();
  }

  status(): RealRunStatus {
    const tree = this.store.getOnlyTree();
    return {
      tree,
      nodes: this.store.listNodes(tree.treeId),
      operations: this.store.listUnresolvedOperations(tree.treeId),
      steps: this.store.listSteps(tree.treeId),
      messages: this.store.listMessages(tree.treeId),
    };
  }

  private async cancelNode(node: NodeRecord): Promise<void> {
    if (
      node.agentName === null ||
      node.terminalId === null ||
      node.agentInstanceId === null
    ) {
      this.store.setNodeLifecycle(node.nodeId, "cancelled");
      return;
    }
    const request = {
      nodeId: node.nodeId,
      agentName: node.agentName,
      terminalId: node.terminalId,
      agentInstanceId: node.agentInstanceId,
      generation: node.generation,
    };
    const operationId = operationIdForRequest(node.treeId, "cancel", node.nodeId);
    let operation = this.store.reserveOperation({
      operationId,
      treeId: node.treeId,
      nodeId: node.nodeId,
      kind: "cancel",
      requestKey: node.nodeId,
      requestHash: requestHash(request),
      request,
    });
    if (operation.status === "completed") {
      this.store.setNodeLifecycle(node.nodeId, "cancelled");
      return;
    }
    if (operation.status === "blocked" || node.lifecycleStatus === "cancel_blocked") return;
    if (operation.status === "reserved") {
      operation = this.store.setOperationStatus(operation.operationId, "submitted", { incrementAttempt: true });
    }
    try {
      let lifecycle = this.store.getNode(node.nodeId).lifecycleStatus;
      if (lifecycle === "cancel_requested") {
        this.store.setNodeLifecycle(node.nodeId, "interrupting");
        try {
          await this.herdr.agentInterrupt({
            target: node.agentName,
            client_operation_id: `${operation.operationId}:interrupt`,
            expected_terminal_id: node.terminalId,
            expected_agent_instance_id: node.agentInstanceId,
          });
        } catch (error) {
          if (!this.isDeliveryUnknown(error)) throw error;
        }
        lifecycle = "interrupting";
      }
      if (lifecycle === "interrupting") {
        await this.waitForSettled(node.agentName, this.graceMs);
        if (!(await this.sameInstanceActive(node))) {
          this.completeNode(operation, node);
          return;
        }
        this.store.setNodeLifecycle(node.nodeId, "terminating");
        lifecycle = "terminating";
      }
      if (lifecycle === "terminating") {
        try {
          const result = await this.herdr.agentTerminate({
            target: node.agentName,
            client_operation_id: `${operation.operationId}:terminate`,
            expected_terminal_id: node.terminalId,
            expected_agent_instance_id: node.agentInstanceId,
            force: false,
          });
          if (result.outcome === "already_stopped") {
            this.completeNode(operation, node);
            return;
          }
        } catch (error) {
          if (!this.isDeliveryUnknown(error)) throw error;
        }
        await this.waitForSettled(node.agentName, this.graceMs);
        if (!(await this.sameInstanceActive(node))) {
          this.completeNode(operation, node);
          return;
        }
        this.store.setNodeLifecycle(node.nodeId, "force_terminating");
        lifecycle = "force_terminating";
      }
      if (lifecycle === "force_terminating") {
        try {
          const result = await this.herdr.agentTerminate({
            target: node.agentName,
            client_operation_id: `${operation.operationId}:kill`,
            expected_terminal_id: node.terminalId,
            expected_agent_instance_id: node.agentInstanceId,
            force: true,
          });
          if (result.outcome === "already_stopped") {
            this.completeNode(operation, node);
            return;
          }
        } catch (error) {
          if (!this.isDeliveryUnknown(error)) throw error;
        }
        await this.waitForInstanceExit(node, this.forceWaitMs);
        if (await this.sameInstanceActive(node)) {
          throw new Error(`agent instance ${node.agentInstanceId} remained active after forced termination`);
        }
        this.completeNode(operation, node);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setNodeLifecycle(node.nodeId, "cancel_blocked");
      this.store.setOperationStatus(operation.operationId, "blocked", { lastError: message });
    }
  }

  private completeNode(operation: OperationRecord, node: NodeRecord): void {
    this.store.completeNodeCancellation(operation.operationId, node.nodeId, {
      nodeId: node.nodeId,
      terminalId: node.terminalId,
      agentInstanceId: node.agentInstanceId,
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
        throw new Error(
          `agent identity changed from ${node.terminalId}/${node.agentInstanceId} to ${current.terminal_id}/${current.agent_instance_id ?? "missing"}`,
        );
      }
      return true;
    } catch (error) {
      if (error instanceof HerdrApiError && error.code === "agent_not_found") return false;
      throw error;
    }
  }

  private async waitForSettled(target: string, timeoutMs: number): Promise<void> {
    try {
      await this.herdr.agentWait({
        target,
        until: ["idle", "done", "blocked", "unknown"],
        timeout_ms: timeoutMs,
      });
    } catch (error) {
      if (error instanceof HerdrApiError && ["timeout", "agent_not_found"].includes(error.code)) return;
      throw error;
    }
  }

  private async waitForInstanceExit(node: NodeRecord, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.sameInstanceActive(node))) return;
      await Bun.sleep(25);
    }
  }

  private isDeliveryUnknown(error: unknown): boolean {
    return error instanceof HerdrApiError && error.code === "agent_control_delivery_unknown";
  }
}
