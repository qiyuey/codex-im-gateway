import { GatewayApplication } from "../application/gateway-application.js";
import { AppServerClient } from "../codex/app-server-client.js";
import { resolveCodexChatsWorkspace } from "../codex/chats-workspace.js";
import { authorizedWorkspaces, loadRuntimeConfig } from "../config/runtime-config.js";
import { Dispatcher } from "../dispatcher/dispatcher.js";
import { NotificationDispatcher } from "../dispatcher/notification-dispatcher.js";
import { ThreadWatchMonitor } from "../dispatcher/thread-watch-monitor.js";
import { LocalKillSwitch } from "../security/kill-switch.js";
import { isWorkspaceAllowed } from "../security/workspace.js";
import { CompletionEventStore } from "../storage/event-store.js";
import { GatewayStateStore } from "../storage/gateway-state-store.js";
import { OutboundNotificationStore } from "../storage/notification-store.js";
import { openGatewayDatabase } from "../storage/open-store.js";
import { TelegramCompletionSender } from "../telegram/completion-sender.js";
import { GrammyTelegramAdapter } from "../telegram/grammy-adapter.js";
import { TelegramNotificationSender } from "../telegram/notification-sender.js";
import { TelegramService } from "../telegram/telegram-service.js";
import { RuntimeStatusWriter, resolveRuntimeStatusPath } from "./runtime-status.js";
import { resolveRuntimeLockPath, SingleInstanceLock } from "./single-instance-lock.js";

export function createGatewayApplication(env: NodeJS.ProcessEnv = process.env): GatewayApplication {
  const config = loadRuntimeConfig(env);
  const chatsWorkspace = resolveCodexChatsWorkspace();
  const workspaceRoots = authorizedWorkspaces(config);
  const database = openGatewayDatabase(env);
  const events = new CompletionEventStore(database);
  const notifications = new OutboundNotificationStore(database);
  const state = new GatewayStateStore(database);
  const appServer = new AppServerClient();
  const telegram = new GrammyTelegramAdapter(
    config.telegramBotToken,
    config.telegramAllowedUserId,
    config.language,
  );
  const killSwitch = new LocalKillSwitch(env);
  const service = new TelegramService(config, telegram, state, appServer, 750, () =>
    killSwitch.isInboundEnabled(),
  );
  const target = {
    channel: "telegram" as const,
    chatId: String(config.telegramAllowedChatId),
  };
  const dispatcher = new Dispatcher(
    events,
    state,
    appServer,
    new TelegramCompletionSender(
      telegram,
      config.telegramAllowedChatId,
      config.language,
      chatsWorkspace,
    ),
    target,
    (cwd) => isWorkspaceAllowed(cwd, workspaceRoots),
  );
  const notificationDispatcher = new NotificationDispatcher(
    notifications,
    new TelegramNotificationSender(telegram, config.telegramAllowedChatId, config.language),
    (cwd) => isWorkspaceAllowed(cwd, workspaceRoots),
    {
      findDeliveredMessageId: (notification) =>
        state.getTerminalDeliveryMessageId(
          target,
          notification.source.codexThreadId,
          notification.source.codexTurnId,
        ),
      recordDelivered: (notification, messageId) => {
        state.recordTerminalDelivery(
          target,
          notification.source.codexThreadId,
          notification.source.codexTurnId,
          "explicit_notification",
          notification.id,
          messageId,
        );
      },
    },
  );
  const threadWatchMonitor = new ThreadWatchMonitor(
    state,
    appServer,
    telegram,
    (cwd) => isWorkspaceAllowed(cwd, workspaceRoots),
    5_000,
    config.language,
    chatsWorkspace,
  );
  return new GatewayApplication({
    config,
    database,
    appServer,
    telegram,
    service,
    dispatcher,
    notificationDispatcher,
    threadWatchMonitor,
    runtimeStatus: new RuntimeStatusWriter(
      resolveRuntimeStatusPath(env),
      Date.now,
      process.pid,
      () => appServer.isConnected(),
    ),
    instanceLock: new SingleInstanceLock(resolveRuntimeLockPath(env)),
  });
}
