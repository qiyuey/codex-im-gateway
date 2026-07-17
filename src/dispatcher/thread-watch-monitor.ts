import type { CanonicalTurnResult, WatchedThreadSnapshot } from "../codex/app-server-client.js";
import type { GatewayLanguage } from "../core/i18n.js";
import type { GatewayStateStore, ThreadWatchRecord } from "../storage/gateway-state-store.js";
import {
  renderCompletionParts,
  renderWatchedBlockedParts,
  taskActionKeyboard,
} from "../telegram/render.js";
import { sendRichMessageParts } from "../telegram/rich-message-parts.js";
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
    private readonly language: GatewayLanguage = "zh",
    private readonly tasksWorkspace?: string,
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
        const terminal = snapshot.latestTerminalTurn;
        if (
          this.state.isThreadMuted(current, snapshot.threadId) ||
          (terminal &&
            this.state.getTerminalDeliveryMessageId(current, terminal.threadId, terminal.turnId))
        ) {
          this.state.acknowledgeWatchedState(current, snapshot.threadId, {
            turnId: terminal?.turnId ?? null,
            blockedGoalUpdatedAt: snapshot.blockedGoal.updatedAt,
          });
          return;
        }
        await this.sendBlocked(current, snapshot);
        return;
      }

      const turn = snapshot.latestTerminalTurn;
      if (!turn || turn.turnId === current.lastDeliveredTurnId) {
        return;
      }

      if (
        this.state.isThreadMuted(current, turn.threadId) ||
        this.state.getTerminalDeliveryMessageId(current, turn.threadId, turn.turnId)
      ) {
        this.state.acknowledgeWatchedState(current, turn.threadId, { turnId: turn.turnId });
        return;
      }

      if (turn.status === "interrupted") {
        // A second app-server can expose an active Desktop turn as interrupted,
        // including commentary already emitted by that turn. A null duration means
        // the state is not stable and the same ID may later become completed, so do
        // not acknowledge it. Stable interruptions are intentionally silent but can
        // be acknowledged to avoid reconsidering them on every poll.
        if (turn.durationMs !== null && turn.durationMs !== undefined) {
          this.state.acknowledgeWatchedState(current, turn.threadId, { turnId: turn.turnId });
        }
        return;
      }

      await this.sendTurn(current, turn);
    } catch {
      // A transient app-server or Telegram failure is retried on the next poll.
    }
  }

  private async sendTurn(watch: ThreadWatchRecord, turn: CanonicalTurnResult): Promise<void> {
    const message = await sendRichMessageParts(
      this.api,
      Number(watch.chatId),
      renderCompletionParts(
        turn,
        this.language,
        turn.cwd === this.tasksWorkspace ? "Tasks" : undefined,
      ),
      watch.topicId,
      taskActionKeyboard(turn.threadId, this.language),
    );
    this.state.recordTerminalDelivery(
      watch,
      turn.threadId,
      turn.turnId,
      "watch",
      null,
      message.messageId,
    );
    this.state.acknowledgeWatchedState(watch, turn.threadId, { turnId: turn.turnId });
  }

  private async sendBlocked(
    watch: ThreadWatchRecord,
    snapshot: WatchedThreadSnapshot,
  ): Promise<void> {
    const blocked = snapshot.blockedGoal;
    if (!blocked) return;
    const message = await sendRichMessageParts(
      this.api,
      Number(watch.chatId),
      renderWatchedBlockedParts(
        snapshot,
        this.language,
        snapshot.cwd === this.tasksWorkspace ? "Tasks" : undefined,
      ),
      watch.topicId,
      taskActionKeyboard(snapshot.threadId, this.language),
    );
    const terminal = snapshot.latestTerminalTurn;
    if (terminal) {
      this.state.recordTerminalDelivery(
        watch,
        terminal.threadId,
        terminal.turnId,
        "watch",
        `goal:${blocked.updatedAt}`,
        message.messageId,
      );
    } else {
      this.state.bindMessage(
        watch.channel,
        watch.chatId,
        message.messageId,
        snapshot.threadId,
        snapshot.latestTurn?.turnId ?? `goal:${blocked.updatedAt}`,
      );
    }
    this.state.acknowledgeWatchedState(watch, snapshot.threadId, {
      turnId: snapshot.latestTerminalTurn?.turnId ?? null,
      blockedGoalUpdatedAt: blocked.updatedAt,
    });
  }
}
