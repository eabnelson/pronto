import { expect, test } from "bun:test";
import {
  STANDALONE_SCOPE_TTL_MS,
  standaloneMessagesOptions,
} from "../../packages/cli/src/core/daemon";

test("standalone conversation scope outlives the bounded runtime queue", () => {
  const worstCaseRuntimeQueueMs = 32 * 2 * 10 * 60 * 1_000;
  expect(STANDALONE_SCOPE_TTL_MS).toBeGreaterThan(worstCaseRuntimeQueueMs);
  expect(standaloneMessagesOptions({
    chatKeySalt: "0123456789abcdef0123456789abcdef",
    imsgPath: "/opt/homebrew/bin/imsg",
    legacyUnscopedCursor: 40,
    providerStatePath: "/tmp/provider-state.json",
  })).toEqual({
    imsgPath: "/opt/homebrew/bin/imsg",
    legacyUnscopedCursor: 40,
    referenceKey: "0123456789abcdef0123456789abcdef",
    scopeLimits: { ttlMs: STANDALONE_SCOPE_TTL_MS },
    statePath: "/tmp/provider-state.json",
  });
});
