import type { OutboundNotification } from "../core/types.js";
import type { OutboundNotificationStore } from "../storage/notification-store.js";

export interface NotificationSender {
  sendNotification(notification: OutboundNotification): Promise<{ readonly messageId: string }>;
}

type BoundOutboundNotification = OutboundNotification & {
  readonly source: {
    readonly kind: "bound_task";
    readonly codexThreadId: string;
    readonly codexTurnId: string;
  };
};

export type NotificationBindingRecorder = (
  notification: BoundOutboundNotification,
  messageId: string,
) => void;

export class NotificationDispatcher {
  constructor(
    private readonly notifications: OutboundNotificationStore,
    private readonly sender: NotificationSender,
    private readonly workspaceAllowed: (cwd: string) => Promise<boolean> = async () => true,
    private readonly recordBinding?: NotificationBindingRecorder,
  ) {}

  async runOnce(now = Date.now()): Promise<boolean> {
    const notification = this.notifications.leaseNext({ now, leaseDurationMs: 60_000 });
    if (!notification?.leaseToken) return false;

    try {
      if (!(await this.workspaceAllowed(notification.cwd))) {
        this.notifications.markFailed(
          notification.id,
          notification.leaseToken,
          "workspace not allowed",
          { maxAttempts: 1 },
        );
        return true;
      }
      const sent = await this.sender.sendNotification(notification);
      if (notification.source.kind === "bound_task") {
        if (!this.recordBinding) throw new Error("bound notification recorder is unavailable");
        this.recordBinding(notification as BoundOutboundNotification, sent.messageId);
      }
      this.notifications.markDelivered(notification.id, notification.leaseToken, sent.messageId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "delivery failed";
      this.notifications.markFailed(notification.id, notification.leaseToken, message);
      process.stderr.write(
        `${JSON.stringify({
          level: "warn",
          event: "explicit_notification_delivery_failed",
          notificationId: notification.id,
        })}\n`,
      );
    }
    return true;
  }
}
