import type { CanonicalTurnResult } from "../codex/app-server-client.js";
import type { CompletionEventStore } from "../storage/event-store.js";
import type { DeliveryTarget, GatewayStateStore } from "../storage/gateway-state-store.js";

export interface CompletionSender {
  sendCompletion(
    result: CanonicalTurnResult,
    eventId: string,
  ): Promise<{ readonly messageId: string }>;
}

export interface CompletionReader {
  readTurn(threadId: string, turnId: string): Promise<CanonicalTurnResult>;
}

export class Dispatcher {
  constructor(
    private readonly events: CompletionEventStore,
    private readonly state: GatewayStateStore,
    private readonly appServer: CompletionReader,
    private readonly sender: CompletionSender,
    private readonly target: DeliveryTarget,
    private readonly workspaceAllowed: (cwd: string) => Promise<boolean> = async () => true,
  ) {}

  async runOnce(now = Date.now()): Promise<boolean> {
    const event = this.events.leaseNext({ now, leaseDurationMs: 60_000 });
    if (!event?.leaseToken) return false;

    try {
      if (this.state.hasSentDelivery(event.id, this.target)) {
        this.events.markDelivered(event.id, event.leaseToken);
        return true;
      }
      const result = await this.appServer.readTurn(event.codexThreadId, event.codexTurnId);
      if (result.status === "in_progress") throw new Error("Codex turn is still in progress");
      if (!(await this.workspaceAllowed(result.cwd))) {
        this.events.markFailed(event.id, event.leaseToken, "workspace not allowed", {
          maxAttempts: 1,
        });
        return true;
      }
      const sent = await this.sender.sendCompletion(result, event.id);
      this.state.recordSentDelivery(event.id, this.target, sent.messageId, {
        threadId: result.threadId,
        turnId: result.turnId,
      });
      this.events.markDelivered(event.id, event.leaseToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : "delivery failed";
      this.events.markFailed(event.id, event.leaseToken, message);
      process.stderr.write(
        `${JSON.stringify({ level: "warn", event: "completion_delivery_failed", eventId: event.id })}\n`,
      );
    }
    return true;
  }
}
