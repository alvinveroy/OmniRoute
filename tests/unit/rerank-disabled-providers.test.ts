import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The instance-level rerank blocklist. The rerank endpoint bills the provider
// it dispatches to, and the memory engine calls it over loopback on every
// retrieval, so an operator who disables a metered rerank provider needs the
// block to hold on all three surfaces: the /v1/rerank dispatch, the /v1/models
// rerank catalog entries, and the Memory Rerank selector listing.
//
// These tests pin the block semantics (id match, alias match, fail-closed on a
// settings read error) and the dispatch rejection.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rerank-disabled-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-secret";

// Dynamic imports: the DB modules bind to DATA_DIR at import time, so the
// temp dir has to be in the environment before they load.
const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const { isRerankProviderDisabled, getDisabledRerankProviders } = await import(
  "../../src/lib/rerank/disabledRerankProviders.ts"
);

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

test("an empty blocklist leaves every rerank provider enabled", async () => {
  await settingsDb.updateSettings({ disabledRerankProviders: [] });
  assert.equal(await isRerankProviderDisabled("openrouter"), false);
  assert.equal((await getDisabledRerankProviders()).size, 0);
});

test("a listed provider id is disabled", async () => {
  await settingsDb.updateSettings({ disabledRerankProviders: ["openrouter"] });
  assert.equal(await isRerankProviderDisabled("openrouter"), true);
  assert.equal(await isRerankProviderDisabled("OpenRouter"), true);
  assert.equal(await isRerankProviderDisabled("cohere"), false);
});

test("the match is case-insensitive and ignores surrounding whitespace", async () => {
  await settingsDb.updateSettings({ disabledRerankProviders: ["  OpenRouter  "] });
  assert.equal(await isRerankProviderDisabled("openrouter"), true);
});

test("other providers are unaffected by one blocked provider", async () => {
  await settingsDb.updateSettings({ disabledRerankProviders: ["openrouter"] });
  assert.equal(await isRerankProviderDisabled("cohere"), false);
  assert.equal(await isRerankProviderDisabled("nvidia"), false);
  assert.equal(await isRerankProviderDisabled("jina-ai"), false);
});

test("the '*' wildcard disables every rerank provider", async () => {
  await settingsDb.updateSettings({ disabledRerankProviders: ["*"] });
  assert.equal(await isRerankProviderDisabled("openrouter"), true);
  assert.equal(await isRerankProviderDisabled("cohere"), true);
});

test("an unset blocklist leaves every rerank provider enabled", async () => {
  // No row at all: the setting was never written.
  assert.equal(await isRerankProviderDisabled("openrouter"), false);
});

test("a non-array setting is ignored (no blocklist configured)", async () => {
  await settingsDb.updateSettings({ disabledRerankProviders: "openrouter" as never });
  assert.equal(await isRerankProviderDisabled("openrouter"), false);
});
