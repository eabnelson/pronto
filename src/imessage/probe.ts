const REQUIRED_METHODS = [
  "initialize",
  "status",
  "chats.list",
  "messages.history",
  "messages.after",
  "messages.stats",
  "watch.subscribe",
  "watch.unsubscribe",
  "send",
] as const;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid imsg status response");
  }
  return value as Record<string, unknown>;
}

export interface QualifiedImsg {
  degraded: string[];
  version: string;
}

export function qualifyImsgStatus(value: unknown): QualifiedImsg {
  const status = object(value);
  if (status.protocol_version !== 1) throw new Error("Unsupported imsg RPC protocol");
  if (typeof status.version !== "string" || status.version.length === 0) {
    throw new Error("imsg did not report a version");
  }
  const database = object(status.database);
  if (database.ready !== true) throw new Error("Messages database is not readable");
  if (!Array.isArray(status.methods) || !status.methods.every((method) => typeof method === "string")) {
    throw new Error("imsg did not report usable methods");
  }
  for (const method of REQUIRED_METHODS) {
    if (!status.methods.includes(method)) throw new Error(`imsg method is unavailable: ${method}`);
  }

  const features =
    database.features !== null && typeof database.features === "object"
      ? (database.features as Record<string, unknown>)
      : {};
  const degraded: string[] = [];
  if (features.reactions !== true) degraded.push("reactions");
  if (features.balloon_payloads !== true) degraded.push("polls");
  if (features.reply_context !== true) degraded.push("reply-context");
  if (features.routing_metadata !== true) degraded.push("routing-metadata");
  return { degraded, version: status.version };
}
