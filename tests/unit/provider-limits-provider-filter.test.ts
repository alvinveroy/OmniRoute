// Port of decolua/9router PR #769 — provider dropdown filter for the quota
// dashboard. The upstream PR added the dropdown plus an "Expiring first" sort
// toggle; OmniRoute already always sorts by soonest reset within each status
// group (see ProviderLimits/index.tsx `visibleConnections`), so only the
// dropdown is genuinely new here. These tests guard the pure helpers that
// back the dropdown so regressions in the inline `useMemo` predicates fail
// loudly instead of silently widening / breaking the filter.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProviderOptions,
  matchesProviderFilter,
} from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.tsx";
import {
  activeLimitFilterDimensions,
  isStaleLimitsFilter,
} from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/providerOrder.ts";

test("PR#769: matchesProviderFilter — 'all' lets every connection through", () => {
  assert.equal(matchesProviderFilter({ provider: "openai" }, "all"), true);
  assert.equal(matchesProviderFilter({ provider: "anthropic" }, "all"), true);
  // Defensive: even a malformed connection still matches the "all" sentinel
  // so the dropdown's default never collapses the list to zero.
  assert.equal(matchesProviderFilter({}, "all"), true);
  assert.equal(matchesProviderFilter(null, "all"), true);
});

test("PR#769: matchesProviderFilter — exact match on a specific provider key", () => {
  assert.equal(matchesProviderFilter({ provider: "openai" }, "openai"), true);
  assert.equal(matchesProviderFilter({ provider: "openai" }, "anthropic"), false);
  // Case-sensitive: provider keys are normalized upstream, so the filter must
  // not match "OpenAI" against "openai" — that would silently union two
  // distinct registry rows.
  assert.equal(matchesProviderFilter({ provider: "OpenAI" }, "openai"), false);
});

test("PR#769: matchesProviderFilter — non-string provider is excluded under a specific filter", () => {
  // Connections with a missing or non-string provider field cannot match a
  // specific provider; only the "all" sentinel accepts them. This keeps
  // dropdown filtering deterministic when the API returns partial rows.
  assert.equal(matchesProviderFilter({}, "openai"), false);
  assert.equal(matchesProviderFilter({ provider: undefined }, "openai"), false);
  assert.equal(matchesProviderFilter({ provider: 42 as unknown }, "openai"), false);
  assert.equal(matchesProviderFilter(null, "openai"), false);
});

test("PR#769: matchesProviderFilter — empty filter string is treated like 'all'", () => {
  // Defensive: if the persisted localStorage value is somehow blanked the
  // dropdown should keep listing everything instead of hiding all rows.
  assert.equal(matchesProviderFilter({ provider: "openai" }, ""), true);
});

test("PR#769: buildProviderOptions — de-duplicates and sorts alphabetically", () => {
  const connections = [
    { provider: "openai" },
    { provider: "anthropic" },
    { provider: "openai" },
    { provider: "gemini" },
    { provider: "anthropic" },
  ];
  assert.deepEqual(buildProviderOptions(connections), ["anthropic", "gemini", "openai"]);
});

test("PR#769: buildProviderOptions — drops missing/empty/non-string provider keys", () => {
  const connections = [
    { provider: "openai" },
    { provider: "" },
    { provider: undefined },
    { provider: null as unknown },
    { provider: 42 as unknown },
    {},
    { provider: "anthropic" },
  ];
  assert.deepEqual(buildProviderOptions(connections), ["anthropic", "openai"]);
});

test("PR#769: buildProviderOptions — honors a custom comparator (e.g. Turkish-aware)", () => {
  // The production call site passes `compareTr` so locale-aware ordering
  // applies. The helper must thread the comparator through Array#sort
  // unchanged — verify with a reverse comparator instead of pulling in the
  // real i18n helper.
  const reverse = (a: string, b: string) => b.localeCompare(a);
  const out = buildProviderOptions(
    [{ provider: "a" }, { provider: "c" }, { provider: "b" }],
    reverse
  );
  assert.deepEqual(out, ["c", "b", "a"]);
});

test("PR#769: buildProviderOptions — returns [] for an empty connection list", () => {
  assert.deepEqual(buildProviderOptions([]), []);
});

/**
 * A persisted filter (omniroute:limits:providerFilter / :envFilter) survives
 * across releases, so it can name a provider that was renamed or an env tag
 * that no connection carries any more. The Provider Limits page then renders
 * "No accounts found for tier filter All." — the provider <Select> already
 * displays "All providers" for the unknown value, and the env chip row does not
 * render at all, so nothing on screen can clear it.
 */
test("stale persisted filters are detected against the live option set", () => {
  // A provider that no longer exists (renamed / connection removed).
  assert.equal(isStaleLimitsFilter("kimi-coding", ["command-code", "openrouter"]), true);
  // An env tag that no connection carries any more (empty option set).
  assert.equal(isStaleLimitsFilter("prod", []), true);
});

test("a live filter and the 'all' sentinel are never stale", () => {
  assert.equal(isStaleLimitsFilter("command-code", ["command-code", "openrouter"]), false);
  assert.equal(isStaleLimitsFilter("all", []), false);
  // A blank stored value behaves like "all" (readLimitsPreference's fallback).
  assert.equal(isStaleLimitsFilter("", []), false);
});

test("the empty state names every filter that is narrowing the list", () => {
  // A persisted status kind with zero accounts is the case that used to read
  // as "No accounts found for tier filter All".
  assert.deepEqual(activeLimitFilterDimensions({ status: "empty" }), ["status"]);
  assert.deepEqual(
    activeLimitFilterDimensions({
      provider: "opencode",
      env: "prod",
      purchaseType: "apikey",
      status: "empty",
      tier: "pro",
    }),
    ["provider", "env", "purchaseType", "status", "tier"]
  );
});

test("no narrowing filter means no dimension to name", () => {
  assert.deepEqual(activeLimitFilterDimensions({}), []);
  assert.deepEqual(
    activeLimitFilterDimensions({
      provider: "all",
      env: "all",
      purchaseType: "all",
      status: "all",
      tier: "all",
    }),
    []
  );
  // A missing value is not an active filter either.
  assert.deepEqual(activeLimitFilterDimensions({ status: null, tier: undefined }), []);
});
