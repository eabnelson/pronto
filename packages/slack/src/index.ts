import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { locked, readPrivate, writePrivate } from "./store.js";
import type { SlackConversation, SlackMessage, SlackObservation, SlackOptions, SlackRecovery, SlackScope, SlackHealth, SlackOperation } from "./types.js";
export * from "./types.js";
export { createSlackBridge } from "./process.js";

const HANDLE_TTL = 10 * 60_000;
const SCOPE_TTL = 24 * 60 * 60_000;
export const SLACK_RECOVERY_LIMITS = Object.freeze({ requests: 50, bytes: 4 * 1024 * 1024, durationMs: 30_000, searchPages: 5, messages: 100, pageSize: 100, intervalMs: 60_000 });
interface Selection extends SlackConversation { cutoff: number; epoch: string; participated: boolean }
interface Binding { team: string; owner: string; label: string; memberLabel: string; profile: "direct" }
interface State {
  version: 1; installation: string; generation: string; binding: Binding | null;
  selections: Selection[]; seen: Array<{ key: string; at: number }>;
  outbound: Array<{ id: string; at: number; ts?: string; conversation: string }>;
  coverage?: "participated";
  cutoff?: number;
  recoveryCursor?: number;
  recoveryCycle?: string;
  discoveryIncomplete?: boolean;
}
type Request = (operation: SlackOperation, input?: Record<string, unknown>) => Promise<any>;
interface Handle { value: string; expires: number; generation: string; kind: "workspace" | "conversation"; team?: string; conversation?: SlackConversation }
interface Authority { installation: string; generation: string; team: string; owner: string; conversation: string; epoch: string; thread: string | null; trigger: string; id: string; expires: number }
const timestamp = /^\d{10,16}\.\d{1,9}$/;
function ms(ts: string): number { return timestamp.test(ts) ? Number(ts) * 1_000 : NaN; }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("base64url"); }
function ordinary(message: SlackMessage): boolean {
  return timestamp.test(message.ts) && typeof message.user === "string" && message.user.length > 0 && typeof message.text === "string" && message.text.length > 0 && !message.bot_id && !message.app_id && (!message.subtype || message.subtype === "file_share");
}

export function createProntoSlack(options: SlackOptions) { return new ProntoSlack(options); }
export type ProntoSlackProvider = ReturnType<typeof createProntoSlack>;

class ProntoSlack {
  readonly #now: () => number;
  readonly #key: Buffer;
  #serial: Promise<unknown> = Promise.resolve();
  #closed = false;
  #watchClose: (() => Promise<void>) | undefined;
  #watchRefresh: (() => Promise<void>) | undefined;
  constructor(private readonly options: SlackOptions) {
    if (options.referenceKey.length < 32) throw new Error("slack-reference-key-required");
    this.#now = options.now ?? Date.now;
    this.#key = createHash("sha256").update(options.referenceKey).digest();
  }
  async #state(): Promise<State> {
    const state = await readPrivate<State>(join(this.options.directory, "state.json"));
    if (state === null) return { version: 1, installation: randomUUID(), generation: randomUUID(), binding: null, selections: [], seen: [], outbound: [] };
    if (state.version !== 1 || !Array.isArray(state.selections) || state.selections.length > (state.coverage === "participated" ? 500 : 5) || !Array.isArray(state.seen) || !Array.isArray(state.outbound) || typeof state.installation !== "string" || typeof state.generation !== "string") throw new Error("slack-state-version");
    return state;
  }
  #mutate<T>(action: (state: State) => Promise<T>): Promise<T> {
    const run = this.#serial.catch(() => undefined).then(() => locked(this.options.directory, async () => {
      const state = await this.#state();
      const result = await action(state);
      state.seen = state.seen.filter((row) => row.at >= this.#now() - SCOPE_TTL).slice(-5_000);
      state.outbound = state.outbound.filter((row) => row.at >= this.#now() - SCOPE_TTL).slice(-1_000);
      await writePrivate(join(this.options.directory, "state.json"), state);
      return result;
    }));
    this.#serial = run; return run;
  }
  async #handles(add?: Handle[]): Promise<Handle[]> {
    const file = join(this.options.directory, "onboarding.json");
    const handles = (await readPrivate<Handle[]>(file) ?? []).filter((row) => row.expires > this.#now());
    if (add !== undefined) { handles.push(...add); await writePrivate(file, handles.slice(-2_000)); }
    return handles;
  }
  async discover() {
    const result = await this.options.bridge.request("discover");
    return this.#mutate(async (state) => {
      const handles: Handle[] = [];
      const workspaces = (result.workspaces as Array<{ team: string; label: string; profile: string }>).filter((row) => row.profile === "direct").map((row) => {
        const handle = randomUUID(); handles.push({ value: handle, expires: this.#now() + HANDLE_TTL, generation: state.generation, kind: "workspace", team: row.team });
        return { handle, id: this.#workspaceKey(row.team), label: row.label, profile: "direct" };
      });
      await this.#handles(handles); return { workspaces };
    });
  }
  #workspaceKey(team: string): string { return createHmac("sha256", this.#key).update(team).digest("hex").slice(0, 32); }
  async connection() {
    const state = await this.#state();
    return state.binding ? { id: this.#workspaceKey(state.binding.team), label: state.binding.label, member: state.binding.memberLabel, coverage: state.coverage ?? "selected" } : null;
  }
  async workspace(handle: string) {
    const state = await this.#state();
    const selected = (await this.#handles()).find((row) => row.value === handle && row.kind === "workspace" && row.generation === state.generation);
    if (!selected?.team) throw new Error("slack-handle-expired");
    return { id: this.#workspaceKey(selected.team) };
  }
  /** Link one discovered workspace into its own provider namespace. */
  async linkWorkspace(handle: string, directory: string) {
    if (this.#watchClose) throw new Error("slack-onboarding-provider-required");
    return this.#mutate(async (source) => {
      const selected = (await this.#handles()).find((row) => row.value === handle && row.kind === "workspace" && row.generation === source.generation);
      if (!selected?.team) throw new Error("slack-handle-expired");
      if (directory === this.options.directory) {
        throw new Error("slack-workspace-directory-required");
      }
      const target = new ProntoSlack({ ...this.options, directory });
      return target.#mutate(async (state) => {
        if (state.binding && state.binding.team !== selected.team) throw new Error("slack-identity-mismatch");
        const identity = await this.options.bridge.request("connect", { team: selected.team, ...(state.binding ? { owner: state.binding.owner } : {}), interactive: true });
        if (identity.team !== selected.team || !identity.owner || state.binding && identity.owner !== state.binding.owner) throw new Error("slack-identity-mismatch");
        state.generation = randomUUID(); state.binding = { ...identity, profile: "direct" };
        state.coverage = "participated"; state.cutoff = this.#now(); state.recoveryCursor = 0;
        state.selections = []; state.seen = []; state.outbound = [];
        return { linked: true, id: this.#workspaceKey(identity.team as string), workspace: identity.label as string, member: identity.memberLabel as string };
      });
    });
  }
  async useParticipatedConversations() {
    await this.#mutate(async (state) => {
      if (!state.binding) throw new Error("slack-needs-link");
      state.coverage = "participated"; state.cutoff ??= this.#now();
    });
  }
  async link(handle: string) {
    return this.#mutate(async (state) => {
      const selected = (await this.#handles()).find((row) => row.value === handle && row.kind === "workspace" && row.generation === state.generation);
      if (!selected?.team) throw new Error("slack-handle-expired");
      if (state.binding && state.binding.team !== selected.team) throw new Error("slack-identity-mismatch");
      const identity = await this.options.bridge.request("connect", { team: selected.team, ...(state.binding ? { owner: state.binding.owner } : {}), interactive: true });
      if (identity.team !== selected.team || !identity.owner || state.binding && identity.owner !== state.binding.owner) throw new Error("slack-identity-mismatch");
      state.generation = randomUUID(); state.binding = { ...identity, profile: "direct" };
      state.selections = []; state.seen = []; state.outbound = [];
      delete state.coverage; delete state.cutoff; delete state.recoveryCursor; delete state.recoveryCycle; delete state.discoveryIncomplete;
      return { linked: true, workspace: identity.label as string, member: identity.memberLabel as string };
    });
  }
  async #connect(state: State): Promise<Binding> {
    if (!state.binding) throw new Error("slack-needs-link");
    const identity = await this.options.bridge.request("connect", { team: state.binding.team, owner: state.binding.owner, interactive: false });
    if (identity.team !== state.binding.team || identity.owner !== state.binding.owner) throw new Error("slack-identity-mismatch");
    await this.options.bridge.request("select", { conversations: state.selections.map((row) => row.id), observeUnselected: state.coverage === "participated" });
    return state.binding;
  }
  async qualify(): Promise<{ status: "ready" | "needs_link"; degraded: string[]; version: string }> {
    const state = await this.#state();
    if (!state.binding) return { status: "needs_link", degraded: [], version: "1" };
    try { await this.#connect(state); } catch (error) {
      if (/needs-link|identity-mismatch|keychain/.test(String(error))) return { status: "needs_link", degraded: [], version: "1" };
      throw error;
    }
    return { status: "ready", degraded: state.coverage === "participated" || state.selections.length ? [] : ["slack-selection-required"], version: "1" };
  }
  async conversations() {
    const state = await this.#state(); await this.#connect(state);
    const rows: SlackConversation[] = []; let cursor = ""; const started = this.#now();
    for (let page = 0; page < 20 && this.#now() - started < 90_000; page++) {
      const response = await this.options.bridge.request("list", { cursor });
      rows.push(...response.conversations); cursor = response.nextCursor ?? "";
      if (!cursor) break;
    }
    return this.#mutate(async (current) => {
      if (current.generation !== state.generation) throw new Error("slack-link-changed");
      const handles: Handle[] = [];
      const conversations = rows.map((row) => {
        const handle = randomUUID(); handles.push({ value: handle, expires: this.#now() + HANDLE_TTL, generation: state.generation, kind: "conversation", conversation: row });
        const selection = current.selections.find((item) => item.id === row.id);
        return { handle, label: row.label, type: row.type, supported: row.supported, ...(row.reason ? { reason: row.reason } : {}), selected: !!selection, eligibility: selection?.participated ? "eligible" : "unknown" };
      });
      await this.#handles(handles); return { conversations, truncated: !!cursor };
    });
  }
  async select(values: readonly string[]) {
    if (values.length > 100) throw new Error("slack-selection-limit");
    return this.#mutate(async (state) => {
      const handles = await this.#handles();
      const rows = [...new Set(values)].map((value) => {
        const handle = handles.find((row) => row.value === value && row.kind === "conversation" && row.generation === state.generation);
        if (!handle?.conversation) throw new Error("slack-handle-expired"); return handle.conversation;
      });
      const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
      if (unique.length > 5) throw new Error("slack-selection-limit");
      await this.#connect(state);
      const verified: SlackConversation[] = [];
      for (const row of unique) {
        const info = await this.options.bridge.request("info", { conversation: row.id, selectionCheck: true });
        if (info.id !== row.id || !info.supported) throw new Error("slack-conversation-unsupported"); verified.push(info);
      }
      state.selections = verified.map((row) => state.selections.find((old) => old.id === row.id) ?? { ...row, cutoff: this.#now(), epoch: randomUUID(), participated: false });
      delete state.coverage; delete state.cutoff; delete state.recoveryCursor; delete state.discoveryIncomplete;
      return { selected: state.selections.length };
    });
  }
  async unlink() {
    await this.#mutate(async (state) => { state.generation = randomUUID(); state.binding = null; state.selections = []; state.seen = []; state.outbound = []; delete state.coverage; delete state.cutoff; });
    await this.options.bridge.request("unwatch", { clearSession: true }).catch(() => undefined);
  }
  #seal(authority: Authority): SlackScope {
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(authority), "utf8"), cipher.final()]);
    return { provider: "slack", version: 1, id: authority.id, expiresAt: new Date(authority.expires).toISOString(), token: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url") };
  }
  #open(scope: SlackScope): Authority {
    try {
      if (scope.provider !== "slack" || scope.version !== 1 || scope.token.length > 4_096) throw new Error();
      const data = Buffer.from(scope.token, "base64url"); const cipher = createDecipheriv("aes-256-gcm", this.#key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(12, 28));
      const authority = JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8")) as Authority;
      if (authority.id !== scope.id || authority.expires <= this.#now() || new Date(authority.expires).toISOString() !== scope.expiresAt) throw new Error(); return authority;
    } catch { throw new Error("slack-scope-expired"); }
  }
  async #authorize(scope: SlackScope, verifyAccess = true): Promise<Authority> {
    const authority = this.#open(scope); const state = await this.#state();
    if (!state.binding || authority.installation !== state.installation || authority.generation !== state.generation || authority.team !== state.binding.team || authority.owner !== state.binding.owner || !state.selections.some((row) => row.id === authority.conversation && row.epoch === authority.epoch && row.participated)) throw new Error("slack-scope-revoked");
    if (verifyAccess) {
      await this.#connect(state);
      const info = await this.options.bridge.request("info", { conversation: authority.conversation });
      if (!info.supported || info.id !== authority.conversation) throw new Error("slack-access-revoked");
      // Configuration can be revoked while a network request is outstanding.
      await this.#authorize(scope, false);
    }
    return authority;
  }
  async authorized(scope: SlackScope): Promise<boolean> { try { await this.#authorize(scope, false); return true; } catch { return false; } }
  async observe(message: SlackMessage, origin: "live" | "recovered", isRequest = true): Promise<SlackObservation | null> {
    return this.#observe(message, origin, isRequest);
  }
  async #observe(message: SlackMessage, origin: "live" | "recovered", isRequest: boolean, request: Request = this.options.bridge.request.bind(this.options.bridge)): Promise<SlackObservation | null> {
    // Socket chatter is transient. Persist only owner participation and acknowledged requests.
    if (!ordinary(message)) return null;
    const initialAge = this.#now() - ms(message.ts);
    if (initialAge > (origin === "live" ? 300_000 : SCOPE_TTL) || initialAge < -60_000) return null;
    const before = await this.#state();
    if (!before.binding || !isRequest && (message.user !== before.binding.owner || before.selections.some((row) => row.id === message.conversation && row.participated))) return null;
    const seenKey = digest([before.binding.team, before.binding.owner, message.conversation, message.ts]);
    if (before.seen.some((row) => row.key === seenKey)) return null;
    return this.#mutate(async (state) => {
      const binding = state.binding;
      if (!binding || !ordinary(message)) return null;
      const age = this.#now() - ms(message.ts);
      if (age > (origin === "live" ? 300_000 : SCOPE_TTL) || age < -60_000) return null;
      let selection = state.selections.find((row) => row.id === message.conversation);
      if (!selection && state.coverage === "participated") {
        if (state.selections.length >= 500) { state.discoveryIncomplete = true; return null; }
        const info = await request("info", { conversation: message.conversation, selectionCheck: true });
        if (info.id !== message.conversation || !info.supported) return null;
        selection = { ...info, cutoff: state.cutoff ?? this.#now(), epoch: randomUUID(), participated: false } as Selection;
        state.selections.push(selection);
        await request("select", { conversations: state.selections.map((row) => row.id), observeUnselected: true });
      }
      if (!selection) return null;
      if (ms(message.ts) < selection.cutoff) return null;
      if (state.outbound.some((row) => row.conversation === message.conversation && ((message.client_msg_id && row.id === message.client_msg_id) || row.ts === message.ts))) return null;
      if (message.user === binding.owner) selection.participated = true;
      if (!isRequest) return null;
      if (!selection.participated) {
        // A targeted owner search supplies hints only. Verify positive evidence against
        // the canonical message (including bot/app/subtype flags) before granting authority.
        const proof = await request("participation", { conversation: selection.id });
        for (const hint of (proof.messages ?? []).slice(0, 3) as SlackMessage[]) {
          if (hint.conversation !== selection.id || hint.user !== binding.owner) continue;
          const canonical = await this.#readMessage(hint, request);
          if (canonical && ordinary(canonical) && canonical.user === binding.owner) { selection.participated = true; break; }
        }
      }
      if (!selection.participated) return null;
      const key = digest([binding.team, binding.owner, message.conversation, message.ts]);
      // Admission acknowledgement, not observation, advances this set (crash-safe consumer handoff).
      if (state.seen.some((row) => row.key === key)) return null;
      const thread = message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : selection.type === "channel" ? message.ts : null;
      if (thread !== null && !timestamp.test(thread)) return null;
      const id = digest([binding.team, binding.owner, message.conversation, thread]);
      const scope = this.#seal({ installation: state.installation, generation: state.generation, team: binding.team, owner: binding.owner, conversation: message.conversation, epoch: selection.epoch, thread, trigger: message.ts, id, expires: this.#now() + SCOPE_TTL });
      return { scope, message, fromMe: message.user === binding.owner, ownerParticipated: true, origin, messageId: `slack:${key}` };
    });
  }
  async acknowledgeObservation(observation: SlackObservation) {
    const authority = this.#open(observation.scope);
    await this.#mutate(async (state) => { if (state.generation === authority.generation) state.seen.push({ key: observation.messageId.slice(6), at: this.#now() }); });
  }
  async history(scope: SlackScope, limit: number): Promise<SlackMessage[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("slack-history-limit");
    const authority = await this.#authorize(scope);
    const operation = authority.thread ? "replies" : "history";
    let cursor = ""; let messages: SlackMessage[] = []; let root: SlackMessage | undefined;
    // Bounded pagination preserves the root and newest replies even on large threads.
    for (let page = 0; page < 10; page++) {
      await this.#authorize(scope, false);
      const response = await this.options.bridge.request(operation, { conversation: authority.conversation, ...(authority.thread ? { thread: authority.thread } : {}), cursor, limit: 100 });
      const rows = response.messages as SlackMessage[];
      root ??= rows.find((row) => row.ts === authority.thread);
      messages.push(...rows.filter((row) => ordinary(row) && (authority.thread !== null || !row.thread_ts || row.thread_ts === row.ts)));
      cursor = response.nextCursor ?? "";
      if (!cursor) break;
      if (!authority.thread && messages.length >= limit) break;
      if (page === 9) throw new Error("slack-context-incomplete");
    }
    await this.#authorize(scope, false);
    messages = [...new Map(messages.map((row) => [row.ts, row])).values()].sort((a, b) => a.ts.localeCompare(b.ts));
    const selected = messages.slice(-(limit - (root ? 1 : 0)) || messages.length);
    if (root) {
      const replies = limit === 1 ? [] : selected.filter((row) => row.ts !== root!.ts).slice(-(limit - 1));
      return boundedHistory([{ ...root, text: excerpt(root.text, 2_000) }, ...replies], authority.owner, true);
    }
    if (authority.thread) throw new Error("slack-root-unavailable");
    return boundedHistory(messages.slice(-limit), authority.owner, false);
  }
  async reply(scope: SlackScope, text: string): Promise<{ disposition: "confirmed"; guid: string } | { disposition: "ambiguous" } | { disposition: "failed"; retrySafe: boolean }> {
    let authority: Authority;
    try { authority = await this.#authorize(scope); } catch { return { disposition: "failed", retrySafe: false }; }
    if (!text || text.length > 4_000) return { disposition: "failed", retrySafe: false };
    const clientMessageId = randomUUID();
    await this.#mutate(async (state) => {
      if (state.generation !== authority.generation || !state.selections.some((row) => row.id === authority.conversation && row.epoch === authority.epoch)) throw new Error("slack-scope-revoked");
      state.outbound.push({ id: clientMessageId, at: this.#now(), conversation: authority.conversation });
    });
    // Serialize the last authorization check and write with selection/unlink commits.
    // The outbound nonce above is already durable before any remote submission.
    return this.#mutate(async (state) => {
      if (state.generation !== authority.generation || !state.binding || state.binding.owner !== authority.owner || !state.selections.some((row) => row.id === authority.conversation && row.epoch === authority.epoch && row.participated) || authority.expires <= this.#now()) return { disposition: "failed" as const, retrySafe: false };
      let result: any;
      try { result = await this.options.bridge.request("send", { conversation: authority.conversation, thread: authority.thread, text, clientMessageId }); }
      catch { return { disposition: "ambiguous" as const }; }
      if (result.outcome === "confirmed" && timestamp.test(result.ts)) {
        const pending = state.outbound.find((row) => row.id === clientMessageId); if (pending) pending.ts = result.ts;
        return { disposition: "confirmed" as const, guid: `slack:${digest([authority.team, authority.conversation, result.ts])}` };
      }
      return result.outcome === "failed" ? { disposition: "failed" as const, retrySafe: result.retrySafe === true } : { disposition: "ambiguous" as const };
    });
  }

  async #readMessage(hint: SlackMessage, request: Request = this.options.bridge.request.bind(this.options.bridge)): Promise<SlackMessage | null> {
    if (!timestamp.test(hint.ts) || hint.thread_ts && !timestamp.test(hint.thread_ts)) return null;
    const thread = hint.thread_ts && hint.thread_ts !== hint.ts ? hint.thread_ts : undefined;
    const bounds = { conversation: hint.conversation, oldest: hint.ts, latest: hint.ts, limit: 1 };
    let response = await request(thread ? "replies" : "history", { ...bounds, ...(thread ? { thread } : {}) });
    let row = (response.messages as SlackMessage[]).find((row) => row.ts === hint.ts && row.conversation === hint.conversation);
    // Search may omit thread_ts and return a permalink without the root. Slack
    // accepts a reply's own timestamp for replies(), so resolve that exact message
    // without scanning roots or guessing which timeline it belongs to.
    if (!row && !thread) {
      response = await request("replies", { ...bounds, thread: hint.ts });
      row = (response.messages as SlackMessage[]).find((row) => row.ts === hint.ts && row.conversation === hint.conversation);
    }
    if (!row || row.thread_ts && thread && row.thread_ts !== thread) return null;
    return { ...row, ...(thread ? { thread_ts: thread } : {}) };
  }
  async reconcile(
    onObservation: (observation: SlackObservation) => Promise<void>,
    tags: readonly string[] = [],
    isRequest = (text: string) => tags.some((tag) => /^@[A-Za-z0-9_-]{1,32}$/.test(tag)
      && new RegExp(`(?<![\\p{L}\\p{N}\\p{M}._@-])${tag}(?![\\p{L}\\p{N}\\p{M}_-])`, "iu").test(text)),
  ): Promise<SlackRecovery> {
    const started = this.#now(); let requests = 0; let bytes = 0; let delivered = 0; let incomplete = false;
    const state = await this.#state(); await this.#connect(state);
    const cutoff = Math.max(state.cutoff ?? 0, this.#now() - SCOPE_TTL);
    const exhausted = () => this.#closed || requests >= SLACK_RECOVERY_LIMITS.requests || bytes >= SLACK_RECOVERY_LIMITS.bytes || delivered >= SLACK_RECOVERY_LIMITS.messages || this.#now() - started >= SLACK_RECOVERY_LIMITS.durationMs;
    // No channel enumeration or timeline traversal. Slack supplies a bounded set of
    // recent tag candidates; each candidate is verified before durable admission.
    const request: Request = async (operation, input) => {
      if (exhausted()) throw new Error("slack-recovery-budget");
      requests++;
      const response = await this.options.bridge.request(operation, input);
      bytes += Buffer.byteLength(JSON.stringify(response));
      if (bytes > SLACK_RECOVERY_LIMITS.bytes) throw new Error("slack-recovery-budget");
      return response;
    };
    const visited = new Set<string>();
    for (const tag of new Set(tags)) {
      let cursor = "";
      try {
        for (let page = 0; page < SLACK_RECOVERY_LIMITS.searchPages; page++) {
          if (exhausted()) { incomplete = true; break; }
          const response = await request("tagged", { tag, oldest: String(cutoff / 1_000), cursor });
          for (const hint of response.messages as SlackMessage[]) {
            if (exhausted()) { incomplete = true; break; }
            if (!ordinary(hint) || ms(hint.ts) < cutoff || !isRequest(hint.text)) continue;
            const key = digest([state.binding!.team, state.binding!.owner, hint.conversation, hint.ts]);
            if (visited.has(key) || state.seen.some((row) => row.key === key)) continue;
            visited.add(key);
            try {
              const current = await this.#state();
              if (current.generation !== state.generation) throw new Error("slack-link-changed");
              const selection = current.selections.find((row) => row.id === hint.conversation);
              if (!selection && current.coverage !== "participated") continue;
              // Validate membership/destination before reading a search result's context.
              const info = await request("info", { conversation: hint.conversation, selectionCheck: true });
              if (info.id !== hint.conversation || !info.supported) continue;
              if (!selection) {
                await this.#mutate(async (current) => {
                  if (current.generation !== state.generation) throw new Error("slack-link-changed");
                  if (current.selections.length >= 500) throw new Error("slack-selection-limit");
                  if (!current.selections.some((row) => row.id === hint.conversation)) current.selections.push({ ...info, cutoff: current.cutoff ?? started, epoch: randomUUID(), participated: false });
                });
                await this.#connect(await this.#state());
              }
              const message = await this.#readMessage(hint, request);
              if (!message || !isRequest(message.text)) continue; // Deleted/edited; search is only a hint.
              const observation = await this.#observe(message, "recovered", true, request);
              if (!observation) continue;
              await onObservation(observation); await this.acknowledgeObservation(observation); delivered++;
            } catch { incomplete = true; }
          }
          const next = response.nextCursor ?? "";
          if (!next) break;
          if (next === cursor || page === SLACK_RECOVERY_LIMITS.searchPages - 1 || exhausted()) { incomplete = true; break; }
          cursor = next;
        }
      } catch { incomplete = true; }
      if (exhausted()) { incomplete = true; break; }
    }
    const current = await this.#state();
    if (current.generation !== state.generation) incomplete = true;
    const needsSelection = current.coverage !== "participated" && current.selections.length === 0;
    return { status: incomplete || needsSelection ? "degraded" : "recovered", ...(incomplete ? { reason: "slack-recovery-incomplete" } : needsSelection ? { reason: "slack-selection-required" } : {}), messages: delivered, requests, bytes, durationMs: this.#now() - started };
  }
  async subscribe(input: { onObservation: (observation: SlackObservation) => Promise<void>; tags?: () => readonly string[]; isRequest?: (text: string) => boolean; onRecovery?: (outcome: SlackRecovery) => void; onHealth?: (health: SlackHealth) => void }) {
    let stopped = false; let active: Promise<void> = Promise.resolve(); let timer: ReturnType<typeof setTimeout> | undefined;
    let finish!: () => void; const terminated = new Promise<void>((resolve) => { finish = resolve; });
    let generation = ""; let recoveryQueued = false;
    const recover = () => { if (recoveryQueued || stopped) return active; recoveryQueued = true; active = active.catch(() => undefined).then(async () => {
      if (stopped) return;
      try {
        const state = await this.#state(); await this.#connect(state);
        if (state.generation !== generation) { await this.options.bridge.request("watch"); generation = state.generation; }
        const outcome = await this.reconcile(input.onObservation, input.tags?.() ?? [], input.isRequest);
        input.onRecovery?.(outcome);
      } catch (error) {
        const needsLink = /needs-link|identity-mismatch|keychain/.test(String(error));
        if (needsLink) { generation = ""; await this.options.bridge.request("unwatch", { clearSession: true }).catch(() => undefined); }
        input.onHealth?.({ state: needsLink ? "needs_link" : "reconnecting", reason: "slack-recovery-failed" });
      }
    }).finally(() => { recoveryQueued = false; }); return active; };
    const unlisten = this.options.bridge.listen((event) => {
      if (stopped) return;
      if (event.event === "message") {
        active = active.catch(() => undefined).then(async () => {
          const observation = await this.observe(event.message, "live", input.isRequest?.(event.message.text) ?? true);
          if (observation) { await input.onObservation(observation); await this.acknowledgeObservation(observation); }
        }).catch(() => { input.onRecovery?.({ status: "degraded", reason: "slack-admission-failed", messages: 0, requests: 0, bytes: 0, durationMs: 0 }); });
      } else if (event.event === "wake") {
        generation = ""; void recover();
      } else if (event.event === "health") {
        input.onHealth?.(event);
        if (event.state === "connected") void recover();
        if (event.state !== "connected") generation = "";
      }
    });
    const tick = async () => { await recover(); if (!stopped) { timer = setTimeout(() => { void tick(); }, SLACK_RECOVERY_LIMITS.intervalMs); timer.unref?.(); } };
    await tick();
    const close = async () => { if (stopped) return; stopped = true; if (timer) clearTimeout(timer); unlisten(); await this.options.bridge.request("unwatch").catch(() => undefined); await active.catch(() => undefined); finish(); };
    this.#watchClose = close;
    this.#watchRefresh = async () => { await active.catch(() => undefined); await recover(); };
    return { close, terminated };
  }
  async refresh() { await this.#watchRefresh?.(); }
  async close() { this.#closed = true; await this.#watchClose?.(); await this.#serial.catch(() => undefined); await this.options.bridge.close(); }
}
function excerpt(text: string, maximum: number): string { return text.length <= maximum ? text : `${text.slice(0, maximum - 24)}\n[excerpt truncated]`; }

function boundedHistory(messages: SlackMessage[], owner: string, thread: boolean): SlackMessage[] {
  const root = thread ? messages[0] : undefined;
  let remaining = 9_000 - (root?.text.length ?? 0);
  const replies: SlackMessage[] = [];
  for (let index = messages.length - 1; index >= (root ? 1 : 0); index--) {
    if (remaining < 100) break;
    const row = messages[index]!; const text = excerpt(row.text, Math.min(1_500, remaining)); remaining -= text.length;
    replies.unshift({ ...row, text, fromMe: row.user === owner });
  }
  return root ? [{ ...root, fromMe: root.user === owner }, ...replies] : replies;
}
