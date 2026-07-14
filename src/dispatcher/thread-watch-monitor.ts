import type { CanonicalTurnResult, WatchedThreadSnapshot } from "../codex/app-server-client.js";
import type { GatewayStateStore, ThreadWatchRecord } from "../storage/gateway-state-store.js";
import { renderCompletion, renderWatchedBlocked, taskActionKeyboard } from "../telegram/render.js";
import type { TelegramApi } from "../telegram/types.js";

export interface WatchedThreadReader {
  readThreadSnapshot(threadId: string): Promise<WatchedThreadSnapshot>;
}

export class ThreadWatchMonitor {
  private nextPollAt = 0;

  constructor(
    private readonly state: GatewayStateStore,
    private readonly reader: WatchedThreadReader,
    private readonly api: TelegramApi,
    private readonly workspaceAllowed: (cwd: string) => Promise<boolean> = async () => true,
    private readonly pollIntervalMs = 5_000,
  ) {}

  async initializeExistingSelections(): Promise<void> {
    for (const active of this.state.listActiveThreads()) {
      if (this.state.getThreadWatch(active.channel, active.chatId, active.topicId)) continue;
      try {
        const snapshot = await this.reader.readThreadSnapshot(active.codexThreadId);
        if (!(await this.workspaceAllowed(snapshot.cwd))) continue;
        this.state.selectAndWatchThread(
          active.channel,
          active.chatId,
          active.topicId,
          active.codexThreadId,
          {
            turnId: snapshot.latestTerminalTurnId,
            blockedGoalUpdatedAt: snapshot.blockedGoal?.updatedAt ?? null,
          },
        );
      } catch {
        // An unavailable historical selection stays active but is not watched.
      }
    }
  }

  async runOnce(now = Date.now()): Promise<boolean> {
    if (now < this.nextPollAt) return false;
    this.nextPollAt = now + this.pollIntervalMs;
    const watches = this.state.listThreadWatches();
    for (const watch of watches) await this.checkWatch(watch);
    return watches.length > 0;
  }

  private async checkWatch(watch: ThreadWatchRecord): Promise<void> {
    try {
      const snapshot = await this.reader.readThreadSnapshot(watch.codexThreadId);
      if (!(await this.workspaceAllowed(snapshot.cwd))) {
        this.state.clearThreadWatch(watch.channel, watch.chatId, watch.topicId);
        return;
      }
      const current = this.state.getThreadWatch(watch.channel, watch.chatId, watch.topicId);
      if (!current || current.codexThreadId !== watch.codexThreadId) {
        return;
      }

      if (
        snapshot.blockedGoal &&
        snapshot.blockedGoal.updatedAt !== current.lastDeliveredGoalUpdatedAt
      ) {
        await this.sendBlocked(current, snapshot);
        return;
      }

      const turn = snapshot.latestTerminalTurn;
      if (!turn || turn.turnId === current.lastDeliveredTurnId) {
        return;
      }

      if (turn.status === "interrupted" && !turn.finalMessage.trim()) {
        // Codex may expose an empty interruption while a task is being steered,
        // restarted, or resumed. It carries no useful result and can later become
        // a completed turn with the same ID, so neither deliver nor acknowledge it.
        return;
      }

      await this.sendTurn(current, turn);
    } catch {
      // A transient app-server or Telegram failure is retried on the next poll.
    }
  }

  private async sendTurn(watch: ThreadWatchRecord, turn: CanonicalTurnResult): Promise<void> {
    const message = await this.api.sendRichMessage(
      Number(watch.chatId),
      renderCompletion(turn, "Watched Codex task"),
      watch.topicId,
      taskActionKeyboard(turn.threadId),
    );
    this.state.bindMessage(
      watch.channel,
      watch.chatId,
      message.messageId,
      turn.threadId,
      turn.turnId,
    );
    this.state.acknowledgeWatchedState(watch, turn.threadId, { turnId: turn.turnId });
  }

  private async sendBlocked(
    watch: ThreadWatchRecord,
    snapshot: WatchedThreadSnapshot,
  ): Promise<void> {
    const blocked = snapshot.blockedGoal;
    if (!blocked) return;
    const message = await this.api.sendRichMessage(
      Number(watch.chatId),
      renderWatchedBlocked(snapshot),
      watch.topicId,
      taskActionKeyboard(snapshot.threadId),
    );
    this.state.bindMessage(
      watch.channel,
      watch.chatId,
      message.messageId,
      snapshot.threadId,
      snapshot.latestTurn?.turnId ?? `goal:${blocked.updatedAt}`,
    );
    this.state.acknowledgeWatchedState(watch, snapshot.threadId, {
      turnId: snapshot.latestTerminalTurn?.turnId ?? null,
      blockedGoalUpdatedAt: blocked.updatedAt,
    });
  }
}
