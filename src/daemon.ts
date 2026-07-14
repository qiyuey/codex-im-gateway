#!/usr/bin/env node
import { AppServerClient } from "./codex/app-server-client.js";
import { loadRuntimeConfig } from "./config/runtime-config.js";
import { Dispatcher } from "./dispatcher/dispatcher.js";
import { NotificationDispatcher } from "./dispatcher/notification-dispatcher.js";
import { ThreadWatchMonitor } from "./dispatcher/thread-watch-monitor.js";
import { LocalKillSwitch } from "./security/kill-switch.js";
import { isWorkspaceAllowed } from "./security/workspace.js";
import { CompletionEventStore } from "./storage/event-store.js";
import { GatewayStateStore } from "./storage/gateway-state-store.js";
import { OutboundNotificationStore } from "./storage/notification-store.js";
import { openEventStore } from "./storage/open-store.js";
import { TelegramCompletionSender } from "./telegram/completion-sender.js";
import { GrammyTelegramAdapter } from "./telegram/grammy-adapter.js";
import { TelegramNotificationSender } from "./telegram/notification-sender.js";
import { TelegramService } from "./telegram/telegram-service.js";

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const { database } = openEventStore();
  const events = new CompletionEventStore(database);
  const notifications = new OutboundNotificationStore(database);
  const state = new GatewayStateStore(database);
  const appServer = new AppServerClient();
  const telegram = new GrammyTelegramAdapter(config.telegramBotToken);
  const killSwitch = new LocalKillSwitch();
  const service = new TelegramService(config, telegram, state, appServer, 750, () =>
    killSwitch.isInboundEnabled(),
  );
  const sender = new TelegramCompletionSender(telegram, config.telegramAllowedChatId);
  const dispatcher = new Dispatcher(
    events,
    state,
    appServer,
    sender,
    {
      channel: "telegram",
      chatId: String(config.telegramAllowedChatId),
    },
    (cwd) => isWorkspaceAllowed(cwd, config.allowedWorkspaces),
  );
  const notificationDispatcher = new NotificationDispatcher(
    notifications,
    new TelegramNotificationSender(telegram, config.telegramAllowedChatId),
    (cwd) => isWorkspaceAllowed(cwd, config.allowedWorkspaces),
    (notification, messageId) => {
      state.bindMessage(
        "telegram",
        String(config.telegramAllowedChatId),
        messageId,
        notification.source.codexThreadId,
        notification.source.codexTurnId,
      );
    },
  );
  const threadWatchMonitor = new ThreadWatchMonitor(state, appServer, telegram, (cwd) =>
    isWorkspaceAllowed(cwd, config.allowedWorkspaces),
  );

  let dispatching = false;
  let dispatchPromise: Promise<void> | null = null;
  let stopping = false;
  await appServer.connect();
  await threadWatchMonitor.initializeExistingSelections();
  await telegram.configureCommandMenu(config.telegramAllowedChatId);
  telegram.onMessage((message) => service.handleMessage(message));
  telegram.onCallbackQuery((query) => service.handleCallbackQuery(query));

  const interval = setInterval(() => {
    if (dispatching || stopping) return;
    dispatching = true;
    dispatchPromise = drainDispatchers(dispatcher, notificationDispatcher, threadWatchMonitor)
      .catch(() => undefined)
      .finally(() => {
        dispatching = false;
        dispatchPromise = null;
      });
  }, config.dispatchIntervalMs);

  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    telegram.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  process.stdout.write(`${JSON.stringify({ level: "info", event: "gateway_started" })}\n`);
  try {
    await telegram.start();
  } finally {
    stop();
    await dispatchPromise;
    await service.drain();
    await appServer.close();
    database.close();
    process.stdout.write(`${JSON.stringify({ level: "info", event: "gateway_stopped" })}\n`);
  }
}

async function drainDispatchers(
  dispatcher: Dispatcher,
  notificationDispatcher: NotificationDispatcher,
  threadWatchMonitor: ThreadWatchMonitor,
): Promise<void> {
  for (let processed = 0; processed < 20; processed += 1) {
    const completionProcessed = await dispatcher.runOnce();
    const notificationProcessed = await notificationDispatcher.runOnce();
    if (!completionProcessed && !notificationProcessed) break;
  }
  await threadWatchMonitor.runOnce();
}

await main().catch((error: unknown) => {
  const kind = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(`${JSON.stringify({ level: "error", event: "gateway_crashed", kind })}\n`);
  process.exitCode = 1;
});
