/**
 * The instance-level rerank blocklist at the dispatch boundary.
 *
 * The rerank endpoint bills the provider it dispatches to. When an operator
 * disables a metered rerank provider, a POST naming that provider must be
 * rejected BEFORE the route resolves credentials and calls the provider -
 * otherwise the block only hides the model from the catalog while the request
 * still spends money.
 *
 * These tests pin the dispatch rejection and, just as importantly, that the
 * provider is never contacted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rerank-blocked-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-secret";

// Dynamic imports: the DB modules bind to DATA_DIR at import time, so the
// temp dir has to be in the environment before they load.
const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const { POST } = await import("../../src/app/api/v1/rerank/route.ts");

function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => {
  resetStorage();
});

test.after(() => {
  resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

test("a blocked rerank provider is rejected and never called upstream", async () => {
  await settingsDb.updateSettings({ disabledRerankProviders: ["openrouter"] });

  let upstreamCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    upstreamCalled = true;
    return new Response("{}", { status: 200 });
  });

  try {
    const req = new Request("http://localhost:20128/api/v1/rerank", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openrouter/cohere/rerank-4-fast",
        query: "test query",
        documents: ["doc1", "doc2"],
      }),
    });

    const res = await POST(req, {} as Record<string, unknown>);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: { message?: string } };
    assert.match(
      String(body.error?.message ?? ""),
      /disabled/i,
      "the rejection must say the provider is disabled"
    );
    assert.equal(upstreamCalled, false, "a blocked provider must not be contacted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
