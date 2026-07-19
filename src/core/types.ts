export const eventStates = ["queued", "leased", "delivered", "dead_letter"] as const;
export type EventState = (typeof eventStates)[number];

export const completionEventTypes = ["completed", "failed", "blocked"] as const;
export type CompletionEventType = (typeof completionEventTypes)[number];

export type IngressProducer = "stop_hook" | "mcp" | "internal" | "legacy";

export interface IngressMetadata {
  readonly producer: IngressProducer;
  readonly producerVersion: string;
  readonly protocolVersion: number;
}

export interface EnqueueCompletionInput {
  readonly idempotencyKey: string;
  readonly codexThreadId: string;
  readonly codexTurnId: string;
  readonly cwd: string;
  readonly eventType: CompletionEventType;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly ingress?: Partial<IngressMetadata>;
}

export interface CompletionEvent {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly codexThreadId: string;
  readonly codexTurnId: string;
  readonly cwd: string;
  readonly eventType: CompletionEventType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly ingress: IngressMetadata;
  readonly state: EventState;
  readonly attemptCount: number;
  readonly nextAttemptAt: number;
  readonly leaseExpiresAt: number | null;
  readonly leaseToken: string | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EventCounts {
  readonly queued: number;
  readonly leased: number;
  readonly delivered: number;
  readonly deadLetter: number;
}

export type NotificationSource =
  | { readonly kind: "notification_only" }
  | {
      readonly kind: "bound_thread";
      readonly codexThreadId: string;
    }
  | {
      readonly kind: "bound_task";
      readonly codexThreadId: string;
      readonly codexTurnId: string;
    };

export interface EnqueueNotificationInput {
  readonly idempotencyKey: string;
  readonly channel: "telegram";
  readonly cwd: string;
  readonly title: string;
  readonly message: string;
  readonly source: NotificationSource;
  readonly ingress?: Partial<IngressMetadata>;
}

export interface OutboundNotification extends Omit<EnqueueNotificationInput, "ingress"> {
  readonly id: string;
  readonly ingress: IngressMetadata;
  readonly state: EventState;
  readonly attemptCount: number;
  readonly nextAttemptAt: number;
  readonly leaseExpiresAt: number | null;
  readonly leaseToken: string | null;
  readonly platformMessageId: string | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
