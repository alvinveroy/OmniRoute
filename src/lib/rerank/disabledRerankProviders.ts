import { getSettings } from "@/lib/db/settings";
import { logger } from "@omniroute/open-sse/utils/logger";

const log = logger("RERANK");

/**
 * Instance-level blocklist for rerank providers.
 *
 * The rerank endpoint bills the provider it dispatches to, and the memory
 * engine's rerank step calls it over loopback on every retrieval. An operator
 * who does not want a provider's rerank metered needs a switch that removes
 * the provider from BOTH the surfaces that can reach it:
 *
 *   1. the curated rerank registry (a direct POST /v1/rerank naming it), and
 *   2. the /v1/models catalog and the memory Rerank selector, which would
 *      otherwise keep offering a model the instance refuses to dispatch.
 *
 * `blockedProviders` is NOT a substitute: that list governs the no-auth
 * synthetic-credential path and the OpenRouter live-catalog mirror, so
 * blocking "openrouter" there would also strip the chat models this instance
 * routes through OpenRouter. This list is scoped to the rerank modality only.
 *
 * Fail-closed: a settings read that throws leaves every provider BLOCKED, so
 * a transient DB error cannot silently re-open a metered path. A blocked
 * rerank provider degrades retrieval to its unranked order (the memory engine
 * treats a failed rerank as "keep the original order"), which is the
 * behaviour an operator disabling a metered provider asked for.
 */
export async function getDisabledRerankProviders(): Promise<Set<string>> {
  try {
    const settings = await getSettings();
    const raw = settings.disabledRerankProviders;
    if (!Array.isArray(raw)) return new Set();
    return new Set(
      raw
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim().toLowerCase())
    );
  } catch (error) {
    log.warn(
      "Could not read disabled rerank providers; treating every rerank provider as blocked",
      error instanceof Error ? error.message : String(error)
    );
    return new Set(["*"]);
  }
}

/**
 * Whether one rerank provider is disabled on this instance. The set is read
 * per call so a dashboard change takes effect without a restart.
 */
export async function isRerankProviderDisabled(
  providerId: string | null | undefined
): Promise<boolean> {
  if (!providerId) return false;
  const blocked = await getDisabledRerankProviders();
  if (blocked.size === 0) return false;
  // "*" is the fail-closed wildcard: every provider is blocked.
  if (blocked.has("*")) return true;
  const id = providerId.trim().toLowerCase();
  // A provider may be listed by its id or by its alias (e.g. "jev" for
  // "typesafe"); match the raw id and the id without a routing suffix.
  return blocked.has(id) || blocked.has(id.replace(/-search$/, ""));
}
