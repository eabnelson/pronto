import { createHash } from "node:crypto";
import type { ConductorConfig } from "../config";
import type {
  ConductorBinding,
  ConductorBindingStore,
} from "../storage/conductor";
import { MAX_RUNTIME_TEXT_CHARACTERS } from "../workspace";
import type {
  RuntimeAdapter,
  RuntimeAttemptResult,
  RuntimeInput,
} from "./types";

const DEFAULT_API_URL = "https://api.conductor.build/v0";
const DEFAULT_IDLE_REPLY_GRACE_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_TRANSCRIPT_PAGES = 20;
const PAGE_LIMIT = 100;

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface ConductorProject {
  readonly gitRemote: string;
  readonly id: string;
  readonly name: string;
}

interface ConductorWorkspace {
  readonly deepLink: string;
  readonly id: string;
  readonly name: string;
  readonly projectId?: string;
  readonly state: string;
}

interface ConductorSession {
  readonly archivedAt?: string;
  readonly deepLink: string;
  readonly id: string;
}

interface ConductorMessage {
  readonly content: unknown;
  readonly id: string;
  readonly sessionIndex: number;
  readonly type: string;
}

interface ConductorSessionStatus {
  readonly errorMessage?: string;
  readonly lastError?: string;
  readonly status: "error" | "idle" | "working";
}

interface Page<T> {
  readonly data: readonly T[];
  readonly hasMore: boolean;
  readonly offset: number;
}

interface CreatedWorkspace {
  readonly deepLink: string;
  readonly sessionId: string;
  readonly workspaceId: string;
}

export interface ConductorApi {
  createWorkspace(input: {
    readonly agent: ConductorConfig["agent"];
    readonly branch?: string;
    readonly effort?: ConductorConfig["effort"];
    readonly fastMode?: boolean;
    readonly model?: string;
    readonly name: string;
    readonly projectId: string;
    readonly sessionName: string;
  }): Promise<CreatedWorkspace>;
  getProject(projectId: string): Promise<ConductorProject>;
  listMessages(sessionId: string, after?: string): Promise<readonly ConductorMessage[]>;
  listProjects(): Promise<readonly ConductorProject[]>;
  listSessions(workspaceId: string): Promise<readonly ConductorSession[]>;
  listWorkspaces(input: {
    readonly name: string;
    readonly projectId: string;
  }): Promise<readonly ConductorWorkspace[]>;
  sendMessage(
    sessionId: string,
    input: { readonly message: string; readonly messageId: string },
  ): Promise<{ readonly messageId: string }>;
  sessionStatus(sessionId: string): Promise<ConductorSessionStatus>;
}

export class ConductorApiError extends Error {
  constructor(
    message: string,
    readonly input: {
      readonly status?: number;
      readonly submissionUncertain?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "ConductorApiError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConductorApiError("Conductor returned an invalid response");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new ConductorApiError("Conductor returned an invalid response");
  }
  return candidate;
}

function parsePage<T>(
  value: unknown,
  parseItem: (item: unknown) => T,
): Page<T> {
  const page = record(value);
  if (
    !Array.isArray(page.data) ||
    typeof page.hasMore !== "boolean" ||
    typeof page.offset !== "number"
  ) {
    throw new ConductorApiError("Conductor returned an invalid page");
  }
  return {
    data: page.data.map(parseItem),
    hasMore: page.hasMore,
    offset: page.offset,
  };
}

export class ConductorApiClient implements ConductorApi {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: Fetch;
  readonly #requestTimeoutMs: number;

  constructor(
    apiKey: string,
    options: {
      readonly baseUrl?: string;
      readonly fetch?: Fetch;
      readonly requestTimeoutMs?: number;
    } = {},
  ) {
    this.#apiKey = apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/u, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async getProject(projectId: string): Promise<ConductorProject> {
    return this.#project(await this.#request("GET", `/projects/${encodeURIComponent(projectId)}`));
  }

  async listProjects(): Promise<readonly ConductorProject[]> {
    return await this.#allPages(
      (offset) => `/projects?limit=${PAGE_LIMIT}&offset=${offset}`,
      (value) => this.#project(value),
    );
  }

  async listWorkspaces(input: {
    readonly name: string;
    readonly projectId: string;
  }): Promise<readonly ConductorWorkspace[]> {
    const query = new URLSearchParams({
      includeArchived: "false",
      limit: String(PAGE_LIMIT),
      name: input.name,
      offset: "0",
      repo: input.projectId,
    });
    return await this.#allPages(
      (offset) => {
        query.set("offset", String(offset));
        return `/workspaces?${query}`;
      },
      (value) => {
        const workspace = record(value);
        return {
          deepLink: requiredString(workspace, "deepLink"),
          id: requiredString(workspace, "id"),
          name: requiredString(workspace, "name"),
          ...(typeof workspace.projectId === "string"
            ? { projectId: workspace.projectId }
            : {}),
          state: requiredString(workspace, "state"),
        };
      },
    );
  }

  async createWorkspace(input: {
    readonly agent: ConductorConfig["agent"];
    readonly branch?: string;
    readonly effort?: ConductorConfig["effort"];
    readonly fastMode?: boolean;
    readonly model?: string;
    readonly name: string;
    readonly projectId: string;
    readonly sessionName: string;
  }): Promise<CreatedWorkspace> {
    try {
      const result = record(await this.#request("POST", "/workspaces", input, true));
      return {
        deepLink: requiredString(result, "deepLink"),
        sessionId: requiredString(result, "sessionId"),
        workspaceId: requiredString(result, "workspaceId"),
      };
    } catch (error) {
      throw this.#submissionError(error);
    }
  }

  async listSessions(workspaceId: string): Promise<readonly ConductorSession[]> {
    return await this.#allPages(
      (offset) =>
        `/workspaces/${encodeURIComponent(workspaceId)}/sessions` +
        `?limit=${PAGE_LIMIT}&offset=${offset}&includeArchived=false`,
      (value) => {
        const session = record(value);
        return {
          ...(typeof session.archivedAt === "string"
            ? { archivedAt: session.archivedAt }
            : {}),
          deepLink: requiredString(session, "deepLink"),
          id: requiredString(session, "id"),
        };
      },
    );
  }

  async listMessages(
    sessionId: string,
    after?: string,
  ): Promise<readonly ConductorMessage[]> {
    if (after !== undefined) {
      const values: ConductorMessage[] = [];
      let cursor = after;
      for (let pageIndex = 0; pageIndex < MAX_TRANSCRIPT_PAGES; pageIndex += 1) {
        const page = parsePage(
          await this.#request(
            "GET",
            `/sessions/${encodeURIComponent(sessionId)}/messages` +
              `?limit=${PAGE_LIMIT}&after=${encodeURIComponent(cursor)}`,
          ),
          (value) => this.#message(value),
        );
        values.push(...page.data);
        if (!page.hasMore) return values;
        const next = page.data.at(-1)?.id;
        if (next === undefined || next === cursor) {
          throw new ConductorApiError("Conductor transcript pagination did not advance");
        }
        cursor = next;
      }
      throw new ConductorApiError("Conductor transcript exceeded its safety limit");
    }
    return await this.#allPages(
      (offset) =>
        `/sessions/${encodeURIComponent(sessionId)}/messages` +
        `?limit=${PAGE_LIMIT}&offset=${offset}`,
      (value) => this.#message(value),
    );
  }

  async sendMessage(
    sessionId: string,
    input: { readonly message: string; readonly messageId: string },
  ): Promise<{ readonly messageId: string }> {
    try {
      const response = record(await this.#request(
        "POST",
        `/sessions/${encodeURIComponent(sessionId)}/messages`,
        input,
        true,
      ));
      return { messageId: requiredString(response, "messageId") };
    } catch (error) {
      throw this.#submissionError(error);
    }
  }

  async sessionStatus(sessionId: string): Promise<ConductorSessionStatus> {
    const result = record(await this.#request(
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}/status`,
    ));
    const status = result.status;
    if (status !== "idle" && status !== "working" && status !== "error") {
      throw new ConductorApiError("Conductor returned an invalid session status");
    }
    return {
      ...(typeof result.errorMessage === "string"
        ? { errorMessage: result.errorMessage }
        : {}),
      ...(typeof result.lastError === "string" ? { lastError: result.lastError } : {}),
      status,
    };
  }

  async #allPages<T>(
    path: (offset: number) => string,
    parseItem: (item: unknown) => T,
  ): Promise<readonly T[]> {
    const values: T[] = [];
    let offset = 0;
    for (let pageIndex = 0; pageIndex < MAX_TRANSCRIPT_PAGES; pageIndex += 1) {
      const page = parsePage(await this.#request("GET", path(offset)), parseItem);
      values.push(...page.data);
      if (!page.hasMore) return values;
      const nextOffset = page.offset + page.data.length;
      if (nextOffset <= offset) throw new ConductorApiError("Conductor pagination did not advance");
      offset = nextOffset;
    }
    throw new ConductorApiError("Conductor pagination exceeded its safety limit");
  }

  #project(value: unknown): ConductorProject {
    const project = record(value);
    return {
      gitRemote: requiredString(project, "gitRemote"),
      id: requiredString(project, "id"),
      name: requiredString(project, "name"),
    };
  }

  #message(value: unknown): ConductorMessage {
    const message = record(value);
    if (
      typeof message.sessionIndex !== "number" ||
      !Number.isSafeInteger(message.sessionIndex) ||
      message.sessionIndex < 0
    ) {
      throw new ConductorApiError("Conductor returned an invalid transcript message");
    }
    return {
      content: message.content,
      id: requiredString(message, "id"),
      sessionIndex: message.sessionIndex,
      type: requiredString(message, "type"),
    };
  }

  #submissionError(error: unknown): ConductorApiError {
    if (error instanceof ConductorApiError) {
      return new ConductorApiError(error.message, {
        ...error.input,
        submissionUncertain:
          error.input.submissionUncertain ??
          (error.input.status === undefined || error.input.status >= 500),
      });
    }
    return new ConductorApiError(
      error instanceof Error ? error.message : "Conductor request failed",
      { submissionUncertain: true },
    );
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    submission = false,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}${path}`, {
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          method,
          signal: controller.signal,
        });
      } catch (error) {
        throw new ConductorApiError(
          error instanceof Error ? error.message : "Conductor request failed",
          { submissionUncertain: submission },
        );
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        throw new ConductorApiError(
          error instanceof Error ? error.message : "Conductor response failed",
          {
            status: response.status,
            submissionUncertain:
              submission &&
              (response.ok || response.status === 408 || response.status >= 500),
          },
        );
      }
      let value: unknown = {};
      if (text.trim() !== "") {
        try {
          value = JSON.parse(text);
        } catch {
          throw new ConductorApiError("Conductor returned invalid JSON", {
            status: response.status,
            submissionUncertain:
              submission &&
              (response.ok || response.status === 408 || response.status >= 500),
          });
        }
      }
      if (!response.ok) {
        const error = recordOrEmpty(value);
        const message =
          typeof error.userMessage === "string"
            ? error.userMessage
            : typeof error.debugMessage === "string"
              ? error.debugMessage
              : `Conductor request failed with status ${response.status}`;
        throw new ConductorApiError(message, {
          status: response.status,
          submissionUncertain:
            submission && (response.status === 408 || response.status >= 500),
        });
      }
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
}

function workspaceName(chatKey: string, config: ConductorConfig): string {
  const chatDigest = createHash("sha256").update(chatKey).digest("hex").slice(0, 12);
  const routingDigest = createHash("sha256")
    .update(JSON.stringify([
      config.projectId,
      config.agent,
      config.branch ?? null,
      config.effort ?? null,
      config.fastMode ?? false,
      config.model ?? null,
    ]))
    .digest("hex")
    .slice(0, 8);
  return `pronto-${chatDigest}-${routingDigest}`;
}

function messageId(requestId: string): string {
  return `pronto-${createHash("sha256").update(requestId).digest("hex").slice(0, 48)}`;
}

function contentText(value: unknown, depth = 0): string {
  if (depth > 5 || value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => contentText(item, depth + 1)).filter(Boolean).join("\n");
  }
  if (typeof value !== "object") return "";
  const candidate = value as Record<string, unknown>;
  for (const key of ["text", "message", "reply", "output", "content"]) {
    const text = contentText(candidate[key], depth + 1).trim();
    if (text !== "") return text;
  }
  return "";
}

function assistantMessageText(message: ConductorMessage): string {
  const type = message.type.toLowerCase();
  const content = recordOrEmpty(message.content);
  const role = typeof content.role === "string" ? content.role.toLowerCase() : "";
  if (
    !type.includes("assistant") &&
    !type.includes("agent") &&
    !type.includes("model") &&
    role !== "assistant" &&
    role !== "agent"
  ) {
    return "";
  }
  return contentText(message.content).trim();
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function conductorPrompt(prompt: string): string {
  return [
    "This task was authorized through Pronto from an iMessage or RCS conversation.",
    "Use only files and tools available in this Conductor cloud workspace.",
    "Your final response will be sent back as plain text in Messages.",
    "",
    prompt,
  ].join("\n");
}

export class ConductorAdapter implements RuntimeAdapter {
  readonly executablePath = "https://api.conductor.build/v0";
  readonly kind = "conductor" as const;
  readonly #api: ConductorApi;
  readonly #config: ConductorConfig;
  readonly #idleReplyGraceMs: number;
  readonly #now: () => number;
  readonly #pollIntervalMs: number;
  readonly #store: ConductorBindingStore;
  readonly #timeoutMs: number;
  readonly #wait: (milliseconds: number) => Promise<void>;

  constructor(
    config: ConductorConfig,
    store: ConductorBindingStore,
    options: {
      readonly api?: ConductorApi;
      readonly idleReplyGraceMs?: number;
      readonly now?: () => number;
      readonly pollIntervalMs?: number;
      readonly timeoutMs?: number;
      readonly wait?: (milliseconds: number) => Promise<void>;
    } = {},
  ) {
    this.#config = config;
    this.#store = store;
    this.#api = options.api ?? new ConductorApiClient(config.apiKey);
    this.#idleReplyGraceMs =
      options.idleReplyGraceMs ?? DEFAULT_IDLE_REPLY_GRACE_MS;
    this.#now = options.now ?? Date.now;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#wait = options.wait ?? (async (milliseconds) => await Bun.sleep(milliseconds));
  }

  async run(input: RuntimeInput): Promise<RuntimeAttemptResult> {
    if (input.chatKey === undefined || input.requestId === undefined) {
      return {
        reason: "conductor-turn-identity-missing",
        status: "application-failure",
        toolActivity: "none",
      };
    }
    let binding: ConductorBinding;
    try {
      binding = await this.#binding(input.chatKey);
    } catch (error) {
      return this.#failure(error, "workspace-resolution", false);
    }
    const requestMessageId = messageId(input.requestId);
    let cursor: string;
    try {
      const accepted = await this.#api.sendMessage(binding.sessionId, {
        message: conductorPrompt(input.prompt),
        messageId: requestMessageId,
      });
      cursor = accepted.messageId;
      this.#store.updateCursor(binding.chatKey, cursor);
    } catch (error) {
      return this.#failure(error, "message-submission", true);
    }

    const deadline = this.#now() + this.#timeoutMs;
    let latestReply = "";
    let seenWorking = false;
    let idleSince: number | undefined;
    while (this.#now() < deadline) {
      try {
        const [messages, status] = await Promise.all([
          this.#api.listMessages(binding.sessionId, cursor),
          this.#api.sessionStatus(binding.sessionId),
        ]);
        for (const message of messages) {
          cursor = message.id;
          this.#store.updateCursor(binding.chatKey, message.id);
          const reply = assistantMessageText(message);
          if (reply !== "") latestReply = reply;
        }
        if (status.status === "working") {
          seenWorking = true;
          idleSince = undefined;
        } else if (status.status === "error") {
          return {
            reason: status.errorMessage ?? status.lastError ?? "conductor-session-error",
            status: "application-failure",
            toolActivity: seenWorking || messages.length > 0 ? "observed" : "unknown",
          };
        } else if (latestReply !== "") {
          return {
            output: {
              reply: latestReply.slice(0, MAX_RUNTIME_TEXT_CHARACTERS).trimEnd(),
            },
            status: "success",
            toolActivity: "observed",
          };
        } else if (seenWorking) {
          idleSince ??= this.#now();
          if (this.#now() - idleSince >= this.#idleReplyGraceMs) {
            return {
              reason: "conductor-response-missing",
              status: "application-failure",
              toolActivity: "observed",
            };
          }
        }
      } catch (error) {
        return this.#failure(error, "session-poll", true);
      }
      await this.#wait(this.#pollIntervalMs);
    }
    return {
      reason: "conductor-timeout",
      status: "operational-failure",
      toolActivity: "unknown",
    };
  }

  async #binding(chatKey: string): Promise<ConductorBinding> {
    const name = workspaceName(chatKey, this.#config);
    const existing = this.#store.get(chatKey);
    if (existing !== null && existing.workspaceName === name) return existing;
    const matches = (await this.#api.listWorkspaces({
      name,
      projectId: this.#config.projectId,
    })).filter((workspace) =>
      workspace.name === name &&
      workspace.state !== "archived" &&
      workspace.state !== "deleted" &&
      (workspace.projectId === undefined || workspace.projectId === this.#config.projectId)
    );
    if (matches.length > 1) {
      throw new ConductorApiError("Multiple matching Conductor workspaces require manual cleanup");
    }
    if (matches.length === 1) {
      const workspace = matches[0]!;
      const sessions = (await this.#api.listSessions(workspace.id))
        .filter((session) => session.archivedAt === undefined);
      if (sessions.length === 0) {
        throw new ConductorApiError("The matching Conductor workspace has no active session");
      }
      const session = sessions[0]!;
      return this.#store.save({
        chatKey,
        deepLink: session.deepLink || workspace.deepLink,
        sessionId: session.id,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
      });
    }
    const created = await this.#api.createWorkspace({
      agent: this.#config.agent,
      ...(this.#config.branch === undefined ? {} : { branch: this.#config.branch }),
      ...(this.#config.effort === undefined ? {} : { effort: this.#config.effort }),
      ...(this.#config.fastMode === undefined ? {} : { fastMode: this.#config.fastMode }),
      ...(this.#config.model === undefined ? {} : { model: this.#config.model }),
      name,
      projectId: this.#config.projectId,
      sessionName: "Pronto",
    });
    try {
      return this.#store.save({
        chatKey,
        deepLink: created.deepLink,
        sessionId: created.sessionId,
        workspaceId: created.workspaceId,
        workspaceName: name,
      });
    } catch (error) {
      throw new ConductorApiError(
        error instanceof Error
          ? error.message
          : "Unable to save the Conductor workspace binding",
        { submissionUncertain: true },
      );
    }
  }

  #failure(
    error: unknown,
    fallbackReason: string,
    submissionMayHaveOccurred: boolean,
  ): RuntimeAttemptResult {
    const uncertain =
      error instanceof ConductorApiError
        ? error.input.submissionUncertain === true
        : submissionMayHaveOccurred;
    return {
      reason:
        error instanceof ConductorApiError && error.input.status === 401
          ? "conductor-authentication"
          : `conductor-${fallbackReason}`,
      status: "operational-failure",
      toolActivity: uncertain ? "unknown" : "none",
    };
  }
}
