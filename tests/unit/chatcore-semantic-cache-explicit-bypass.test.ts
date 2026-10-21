/**
 * Unit tests: the Jev cache-read widen must never override an explicit
 * caller opt-out.
 *
 * `isCacheableForRead` returns false for two different reasons: a heuristic
 * miss (temperature is not 0) and an explicit bypass (`x-omniroute-no-cache`
 * or `cache-control: no-cache`). The decision-model widen may only rescue the
 * first - the second is the caller's instruction. `cacheDefaultMode ===
 * "bypass"` and `videoTranscriptSensitive` are already handled by early
 * returns for the same reason.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated DATA_DIR set BEFORE importing anything that touches the DB.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-bypass-"));
process.env.DATA_DIR = TEST_DATA_DIR;

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

const { checkSemanticCache } = await import("../../open-sse/handlers/chatCore/semanticCache.ts");
const core = await import("../../src/lib/db/core.ts");
const { generateSignature, setCachedResponse, clearCache } =
  await import("../../src/lib/semanticCache.ts");
const { __resetJevClientForTests, __resetJevRuntimeCacheForTests } =
  await import("../../open-sse/services/jev/index.ts");

const originalFetch = globalThis.fetch;

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function useJevCacheLane(): void {
  process.env.OMNIROUTE_JEV_API_KEY = "test-key";
  process.env.OMNIROUTE_JEV_BASE_URL = "https://jev.test";
  process.env.OMNIROUTE_JEV_FEATURES = "cache";
}

/** The decision model answers "safe to serve from cache" with high confidence. */
function stubCacheSafeAnswer(): void {
  globalThis.fetch = (async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ answers: { cacheSafe: { type: "noul", noul: 0.95 } } }),
      text: async () => "",
    } as unknown as Response;
  }) as typeof fetch;
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    semanticCacheEnabled: true,
    body: { model: "gpt-4o", messages: [{ role: "user", content: "bypass me" }], temperature: 0 },
    clientRawRequest: { headers: {} },
    model: "gpt-4o",
    provider: "openai",
    stream: false,
    reqLogger: { logConvertedResponse: () => {} },
    effectiveServiceTier: undefined,
    pendingScope: { id: null, model: "gpt-4o", provider: "openai", connectionId: null },
    startTime: Date.now(),
    log: { debug: () => {} },
    persistAttemptLogs: () => {},
    apiKeyId: null,
    cacheDefaultMode: undefined,
    ...overrides,
  };
}

function seedCachedResponse(body: Record<string, unknown>): void {
  const signature = generateSignature(
    "gpt-4o",
    body.messages as never,
    body.temperature as never,
    body.top_p as never,
    undefined,
    { toolChoice: body.tool_choice, tools: body.tools, responseFormat: body.response_format }
  );
  setCachedResponse(signature, "gpt-4o", {
    id: "chatcmpl-cached-bypass",
    choices: [
      { index: 0, message: { role: "assistant", content: "cached answer" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

test.beforeEach(() => {
  for (const key of JEV_ENV_KEYS) delete process.env[key];
  clearCache();
  __resetJevClientForTests();
  __resetJevRuntimeCacheForTests();
  useJevCacheLane();
  stubCacheSafeAnswer();
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("an explicit x-omniroute-no-cache header is not widened into a cache HIT", async () => {
  const body = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "bypass me" }],
    temperature: 0,
  };
  seedCachedResponse(body);

  const result = await checkSemanticCache(
    baseArgs({
      body,
      clientRawRequest: { headers: { "x-omniroute-no-cache": "true" } },
    }) as Parameters<typeof checkSemanticCache>[0]
  );

  assert.equal(result, null, "an explicit cache opt-out must never become a cache HIT");
});

test("an explicit cache-control: no-cache header is not widened into a cache HIT", async () => {
  const body = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "bypass me" }],
    temperature: 0,
  };
  seedCachedResponse(body);

  const result = await checkSemanticCache(
    baseArgs({
      body,
      clientRawRequest: { headers: { "cache-control": "no-cache" } },
    }) as Parameters<typeof checkSemanticCache>[0]
  );

  assert.equal(result, null, "an explicit cache opt-out must never become a cache HIT");
});

test("without an explicit opt-out the decision model may still widen the gate", async () => {
  // The widen itself must keep working: this is the feature, and the fix must
  // not disable it. temperature 0.7 is a heuristic miss, not an opt-out.
  const body = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "bypass me" }],
    temperature: 0.7,
  };
  seedCachedResponse(body);

  const result = await checkSemanticCache(
    baseArgs({ body }) as Parameters<typeof checkSemanticCache>[0]
  );

  assert.ok(result, "a heuristic miss may still be widened into a cache HIT");
  assert.equal(result.success, true);
});
