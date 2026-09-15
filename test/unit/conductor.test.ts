import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ConductorConfig } from "../../packages/cli/src/config";
import {
  ConductorAdapter,
  ConductorApiClient,
  ConductorApiError,
  type ConductorApi,
} from "../../packages/cli/src/runtimes/conductor";
import type { RuntimeInput } from "../../packages/cli/src/runtimes/types";
import { ConductorBindingStore } from "../../packages/cli/src/storage/conductor";
import { openProntoDatabase } from "../../packages/cli/src/storage/database";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const config: ConductorConfig = {
  agent: "codex",
  apiKey: "secret-conductor-api-key",
  model: "gpt-5.5",
  projectId: "project-1",
  tag: "@conductor",
};

const input: RuntimeInput = {
  bridgeExecutablePath: "/Applications/pronto/bin/pronto",
  brokerUrl: "http://127.0.0.1:1234",
  capability: "local-only-capability",
  chatKey: "c_opaque-chat-key",
  prompt: "AUTHORIZED REQUEST\nFix the test",
  requestId: "IMESSAGE-GUID-1",
  workingDirectory: "/Users/example/local-project",
};

class FakeApi implements ConductorApi {
  createCalls: unknown[] = [];
  listMessageCalls: Array<{ after?: string; sessionId: string }> = [];
  sendCalls: Array<{ input: { message: string; messageId: string }; sessionId: string }> = [];
  statuses: Array<"error" | "idle" | "working"> = ["working", "idle"];
  messagePages: unknown[][] = [
    [],
    [],
    [{
      content: { role: "assistant", text: "Fixed the test and ran verification." },
      id: "message-2",
      sessionIndex: 2,
      type: "assistant",
    }],
  ];
  workspaces: Array<{
    deepLink: string;
    id: string;
    name: string;
    projectId: string;
    state: string;
  }> = [];

  async createWorkspace(value: Parameters<ConductorApi["createWorkspace"]>[0]) {
    this.createCalls.push(value);
    return {
      deepLink: "conductor://workspace/workspace-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
    };
  }
  async getProject(projectId: string) {
    return { gitRemote: "git@example.com:repo.git", id: projectId, name: "Repo" };
  }
  async listMessages(sessionId: string, after?: string) {
    this.listMessageCalls.push({
      ...(after === undefined ? {} : { after }),
      sessionId,
    });
    return (this.messagePages.shift() ?? []) as Awaited<
      ReturnType<ConductorApi["listMessages"]>
    >;
  }
  async listProjects() {
    return [{ gitRemote: "git@example.com:repo.git", id: "project-1", name: "Repo" }];
  }
  async listSessions() {
    return [{
      deepLink: "conductor://workspace/workspace-1/session/session-1",
      id: "session-1",
    }];
  }
  async listWorkspaces(_input: Parameters<ConductorApi["listWorkspaces"]>[0]) {
    return this.workspaces;
  }
  async sendMessage(
    sessionId: string,
    value: { message: string; messageId: string },
  ) {
    this.sendCalls.push({ input: value, sessionId });
    return { messageId: value.messageId };
  }
  async sessionStatus() {
    return { status: this.statuses.shift() ?? "idle" };
  }
}

async function harness(api: ConductorApi) {
  const directory = await mkdtemp(join(tmpdir(), "pronto-conductor-"));
  temporaryDirectories.push(directory);
  const database = openProntoDatabase(join(directory, "state.sqlite"));
  const store = new ConductorBindingStore(database);
  let clock = 0;
  const adapter = new ConductorAdapter(config, store, {
    api,
    now: () => clock,
    pollIntervalMs: 10,
    timeoutMs: 1_000,
    wait: async (milliseconds) => {
      clock += milliseconds;
    },
  });
  return { adapter, close: () => database.close(), store };
}

describe("Conductor cloud runtime", () => {
  test("creates one cloud workspace per chat, sends the prompt, and returns the agent reply", async () => {
    const api = new FakeApi();
    const h = await harness(api);
    try {
      expect(await h.adapter.run(input)).toEqual({
        output: { reply: "Fixed the test and ran verification." },
        status: "success",
        toolActivity: "observed",
      });
      expect(api.createCalls).toHaveLength(1);
      expect(api.createCalls[0]).toMatchObject({
        agent: "codex",
        model: "gpt-5.5",
        projectId: "project-1",
        sessionName: "Pronto",
      });
      expect((api.createCalls[0] as { name: string }).name).toMatch(
        /^pronto-[a-f0-9]{12}-[a-f0-9]{8}$/,
      );
      expect((api.createCalls[0] as { name: string }).name).not.toContain("opaque-chat-key");
      expect(api.sendCalls).toHaveLength(1);
      expect(api.sendCalls[0]!.input.message).toContain(
        "Use only files and tools available in this Conductor cloud workspace",
      );
      expect(api.sendCalls[0]!.input.message).toContain("AUTHORIZED REQUEST\nFix the test");
      expect(api.sendCalls[0]!.input.messageId).toMatch(/^pronto-[a-f0-9]{48}$/);
      expect(api.listMessageCalls[0]).toEqual({
        after: api.sendCalls[0]!.input.messageId,
        sessionId: "session-1",
      });
      expect(h.store.get(input.chatKey!)).toMatchObject({
        lastMessageId: "message-2",
        sessionId: "session-1",
        workspaceId: "workspace-1",
      });
    } finally {
      h.close();
    }
  });

  test("reuses a recovered matching workspace instead of creating another one", async () => {
    const api = new FakeApi();
    api.workspaces = [{
      deepLink: "conductor://workspace/existing",
      id: "existing",
      name: "placeholder",
      projectId: "project-1",
      state: "ready",
    }];
    const originalList = api.listWorkspaces.bind(api);
    api.listWorkspaces = async (
      selection: Parameters<ConductorApi["listWorkspaces"]>[0],
    ) => {
      api.workspaces[0]!.name = selection.name;
      return await originalList(selection);
    };
    const h = await harness(api);
    try {
      expect(await h.adapter.run(input)).toMatchObject({ status: "success" });
      expect(api.createCalls).toHaveLength(0);
      expect(h.store.get(input.chatKey!)?.workspaceId).toBe("existing");
    } finally {
      h.close();
    }
  });

  test("parks a turn when message submission may have reached Conductor", async () => {
    const api = new FakeApi();
    api.sendMessage = async () => {
      throw new ConductorApiError("connection closed", { submissionUncertain: true });
    };
    const h = await harness(api);
    try {
      expect(await h.adapter.run(input)).toEqual({
        reason: "conductor-message-submission",
        status: "operational-failure",
        toolActivity: "unknown",
      });
    } finally {
      h.close();
    }
  });

  test("does not treat a previous assistant reply as the current turn's answer", async () => {
    const api = new FakeApi();
    api.messagePages = [
      [{
        content: { role: "assistant", text: "Current answer." },
        id: "message-current",
        sessionIndex: 4,
        type: "assistant",
      }],
    ];
    api.statuses = ["idle"];
    const h = await harness(api);
    try {
      expect(await h.adapter.run(input)).toEqual({
        output: { reply: "Current answer." },
        status: "success",
        toolActivity: "observed",
      });
      expect(api.listMessageCalls).toEqual([{
        after: api.sendCalls[0]!.input.messageId,
        sessionId: "session-1",
      }]);
    } finally {
      h.close();
    }
  });

  test("uses a new workspace after the configured Conductor route changes", async () => {
    const api = new FakeApi();
    const h = await harness(api);
    try {
      expect(await h.adapter.run(input)).toMatchObject({ status: "success" });
      const changedApi = new FakeApi();
      const changed = new ConductorAdapter(
        { ...config, model: "gpt-5.4" },
        h.store,
        {
          api: changedApi,
          now: () => 0,
          pollIntervalMs: 0,
          timeoutMs: 1_000,
          wait: async () => undefined,
        },
      );
      expect(await changed.run({ ...input, requestId: "IMESSAGE-GUID-2" }))
        .toMatchObject({ status: "success" });
      expect(changedApi.createCalls).toHaveLength(1);
      expect(
        (changedApi.createCalls[0] as { name: string }).name,
      ).not.toBe((api.createCalls[0] as { name: string }).name);
    } finally {
      h.close();
    }
  });
});

describe("Conductor API client", () => {
  test("polls transcript messages after the accepted prompt ID", async () => {
    const requests: Array<{
      init?: RequestInit;
      input: string | URL | Request;
    }> = [];
    const client = new ConductorApiClient("secret", {
      fetch: async (fetchInput, init) => {
        requests.push({ input: fetchInput, ...(init === undefined ? {} : { init }) });
        return Response.json({
          data: [{
            content: { role: "assistant", text: "Done." },
            id: "reply-1",
            receivedAt: "2026-09-08T12:00:00.000Z",
            sessionId: "session/one",
            sessionIndex: 2,
            type: "assistant",
          }],
          hasMore: false,
          offset: 0,
        });
      },
    });
    expect(await client.listMessages("session/one", "prompt one")).toEqual([{
      content: { role: "assistant", text: "Done." },
      id: "reply-1",
      sessionIndex: 2,
      type: "assistant",
    }]);
    expect(String(requests[0]!.input)).toBe(
      "https://api.conductor.build/v0/sessions/session%2Fone/messages" +
      "?limit=100&after=prompt%20one",
    );
    expect(requests[0]!.init?.headers).toMatchObject({
      authorization: "Bearer secret",
    });
  });

  test("marks a malformed successful POST response as uncertain", async () => {
    const client = new ConductorApiClient("secret", {
      fetch: async () => new Response("{}", { status: 201 }),
    });
    try {
      await client.sendMessage("session-1", {
        message: "test",
        messageId: "message-1",
      });
      throw new Error("expected sendMessage to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConductorApiError);
      expect((error as ConductorApiError).input.submissionUncertain).toBeTrue();
    }
  });

  test("keeps a definitive authentication rejection replay-safe", async () => {
    const client = new ConductorApiClient("secret", {
      fetch: async () =>
        Response.json(
          { userMessage: "Unauthorized" },
          { status: 401 },
        ),
    });
    try {
      await client.sendMessage("session-1", {
        message: "test",
        messageId: "message-1",
      });
      throw new Error("expected sendMessage to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConductorApiError);
      expect((error as ConductorApiError).input).toEqual({
        status: 401,
        submissionUncertain: false,
      });
    }
  });

  test("marks a server failure after POST as uncertain", async () => {
    const client = new ConductorApiClient("secret", {
      fetch: async () =>
        Response.json(
          { userMessage: "Try again" },
          { status: 503 },
        ),
    });
    try {
      await client.createWorkspace({
        agent: "codex",
        name: "pronto-test",
        projectId: "project-1",
        sessionName: "Pronto",
      });
      throw new Error("expected createWorkspace to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConductorApiError);
      expect((error as ConductorApiError).input).toEqual({
        status: 503,
        submissionUncertain: true,
      });
    }
  });
});
