/** Private, versioned helper operations. This is a transport seam, not a raw Slack API. */
export type SlackOperation = "discover" | "connect" | "select" | "list" | "info" | "history" | "replies" | "send" | "watch" | "unwatch";
export interface SlackBridge {
  request(operation: SlackOperation, input?: Record<string, unknown>): Promise<any>;
  listen(callback: (event: SlackBridgeEvent) => void): () => void;
  close(): Promise<void>;
}
export interface SlackMessage {
  fromMe?: boolean;
  conversation: string;
  ts: string;
  user: string;
  text: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  app_id?: string;
  client_msg_id?: string;
  reply_count?: number;
  latest_reply?: string;
}
export type SlackBridgeEvent =
  | { event: "message"; message: SlackMessage }
  | { event: "wake" }
  | { event: "health"; state: "connected" | "reconnecting" | "needs_link"; reason?: string };
export type SlackConversationType = "self" | "dm" | "group" | "channel";
export interface SlackConversation {
  id: string;
  label: string;
  type: SlackConversationType;
  supported: boolean;
  reason?: string;
}
export interface SlackScope {
  version: 1;
  provider: "slack";
  /** Stable opaque identity for memory, folders, and queueing; contains no provider IDs. */
  id: string;
  expiresAt: string;
  /** Sealed, installation/generation/selection-bound reply authority. */
  token: string;
}
export interface SlackObservation {
  scope: SlackScope;
  message: SlackMessage;
  ownerParticipated: boolean;
  fromMe: boolean;
  origin: "live" | "recovered";
  /** Stable opaque identity independent of timeline/thread presentation. */
  messageId: string;
}
export type SlackHealth = { state: "connected" | "reconnecting" | "needs_link"; reason?: string };
export interface SlackRecovery { status: "recovered" | "degraded"; reason?: string; messages: number; requests: number; bytes: number; durationMs: number; progress?: { checked: number; total: number } }
export interface SlackOptions {
  directory: string;
  referenceKey: string;
  bridge: SlackBridge;
  now?: () => number;
}
