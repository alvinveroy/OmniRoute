/**
 * Unit tests: the Jev cache-read gate must treat "the decision layer returned
 * no answer" as a plain skip, not as a failure.
 *
 * `decideCacheRead` returns null whenever the decision layer has no runtime
 * (feature disabled, no credential, or an upstream failure). The gate used to
 * destructure that null unconditionally, so every non-cacheable request threw
 * a TypeError inside the gate and was reported through the error path instead
 * of quietly skipping. The throw is invisible in production (the gate
 * fail-closes to "skip" either way) but it burned an exception per request
 * and mislabelled a normal condition as a failure.
 */
import test from "node:test";
import assert from "node:assert/strict";

const JEV_ENV_KEYS = [
  "OMNIROUTE_JEV_ENABLED",
  "OMNIROUTE_JEV_API_KEY",
  "OMNIROUTE_JEV_BASE_URL",
  "OMNIROUTE_JEV_WIRE",
  "OMNIROUTE_JEV_PROVIDER",
  "OMNIROUTE_JEV_MODEL",
  "OMNIROUTE_JEV_TIMEOUT_MS",
  "OMNIROUTE_JEV_FEATURES",
  "OMNIROUTE_JEV_BLOCK_THRESHOLD",
];
const savedEnv = new Map<string, string | undefined>();
for (const key of JEV_ENV_KEYS) savedEnv.set(key, process.env[key]);

const { maybeAllowJevCacheRead } = await import("../../open-sse/handlers/chatCore/jevCacheGate.ts");
const { __resetJevClientForTests, __resetJevRuntimeCacheForTests } =
  await import("../../open-sse/services/jev/index.ts");

const originalFetch = globalThis.fetch;

function clearJevEnv(): void {
  for (const key of JEV_ENV_KEYS) delete process.env[key];
}

/** A credential + enabled cache feature, but the upstream answers nothing usable. */
function useCredential(): void {
  process.env.OMNIROUTE_JEV_API_KEY = "test-key";
  process.env.OMNIROUTE_JEV_BASE_URL = "https://jev.test";
  process.env.OMNIROUTE_JEV_FEATURES = "cache";
}

/** The upstream always fails, so the client gives up and answers nothing. */
function stubUpstreamFailure(): void {
  globalThis.fetch = (async () => {
    return {
      ok: false,
      status: 503,
      json: async () => ({ detail: "upstream unavailable" }),
      text: async () => "upstream unavailable",
    } as unknown as Response;
  }) as typeof fetch;
}

const BODY = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "hi" }],
};

test.beforeEach(() => {
  clearJevEnv();
  __resetJevClientForTests();
  __resetJevRuntimeCacheForTests();
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("the cache gate skips without throwing when the decision layer returns no answer", async () => {
  useCredential();
  stubUpstreamFailure();

  const debugCalls: unknown[][] = [];
  const allowed = await maybeAllowJevCacheRead({
    body: BODY,
    model: "gpt-4o",
    log: { debug: (...args: unknown[]) => debugCalls.push(args) },
  });

  assert.equal(allowed, false, "no decision -> keep today's skip");
  assert.deepEqual(
    debugCalls,
    [],
    "a missing decision is not an error and must not be reported through the error path"
  );
});

test("the cache gate skips without throwing when the decision layer has no runtime", async () => {
  // No credential at all: the decision layer cannot resolve, so there is no
  // answer to act on. The gate must skip quietly.
  const debugCalls: unknown[][] = [];
  const allowed = await maybeAllowJevCacheRead({
    body: BODY,
    model: "gpt-4o",
    log: { debug: (...args: unknown[]) => debugCalls.push(args) },
  });

  assert.equal(allowed, false);
  assert.deepEqual(debugCalls, []);
});

test("the cache gate rejects a body it cannot turn into conversation text", async () => {
  useCredential();
  stubUpstreamFailure();

  const allowed = await maybeAllowJevCacheRead({
    body: { model: "gpt-4o" },
    model: "gpt-4o",
    log: { debug: () => {} },
  });

  assert.equal(allowed, false, "no messages -> no conversation -> skip");
});
