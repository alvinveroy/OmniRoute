/**
 * Decision-model configuration: env contract, feature lanes and runtime
 * credential resolution.
 *
 * The lane is provider-agnostic: it can run against TypeSafe's System One wire
 * (the default) or any OpenAI-compatible classifier endpoint — either given
 * explicitly (`OMNIROUTE_JEV_BASE_URL` + `OMNIROUTE_JEV_MODEL`) or derived from
 * an existing OmniRoute provider connection (`OMNIROUTE_JEV_PROVIDER=<id>`),
 * whose stored base URL and credential are reused.
 *
 * Fail-open contract: every surface that consults the decision model keeps its
 * historical behavior when this module cannot resolve a runtime — the resolver
 * returns `null`, callers no-op.
 */
import { logger } from "../../utils/logger.ts";
import type { JevFeature } from "./types.ts";
import type { DecisionWire } from "./adapters.ts";

const log = logger("JEV");

export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_TIMEOUT_MS = 4_000;
export const DEFAULT_JEV_BLOCK_THRESHOLD = 0.9;

export const JEV_FEATURES = [
  "routing",
  "compression",
  "mcp",
  "tool_search",
  "cache",
  "keepalive",
  "tool_loop",
] as const;

/** Enabled feature lanes — a static key table, so a Record (not a Set). */
export type JevFeatureFlags = Partial<Record<JevFeature, true>>;

export type JevEnabledMode = "auto" | "on" | "off";

export interface JevEnvConfig {
  enabledMode: JevEnabledMode;
  apiKey: string | null;
  baseUrl: string | null;
  /** Explicit wire override; null = derive from the provider (typesafe default). */
  wire: DecisionWire | null;
  /** Provider id whose connection supplies the base URL (+ key fallback). */
  providerId: string | null;
  model: string | null;
  timeoutMs: number;
  features: JevFeatureFlags;
  blockThreshold: number;
}

export interface JevRuntime {
  apiKey: string;
  baseUrl: string;
  model: string;
  wire: DecisionWire;
  timeoutMs: number;
  blockThreshold: number;
}

type EnvLike = Record<string, string | undefined>;

function parseEnabledMode(raw: string | undefined): JevEnabledMode {
  const value = raw?.trim().toLowerCase();
  if (value === "0" || value === "false" || value === "off") return "off";
  if (value === "1" || value === "true" || value === "on") return "on";
  return "auto";
}

function parseWire(raw: string | undefined): DecisionWire | null {
  const value = raw?.trim().toLowerCase();
  return value === "typesafe" || value === "openai" ? value : null;
}

function isKnownFeature(token: string): token is JevFeature {
  return (JEV_FEATURES as readonly string[]).includes(token);
}

/**
 * Parse `OMNIROUTE_JEV_FEATURES`. `all`/`*` (or an empty value) enables every
 * lane; otherwise a comma-separated subset. Unknown tokens are ignored.
 */
export function parseJevFeatures(raw: string | undefined): JevFeatureFlags {
  const value = raw?.trim().toLowerCase();
  const flags: JevFeatureFlags = {};
  if (!value || value === "all" || value === "*") {
    for (const feature of JEV_FEATURES) flags[feature] = true;
    return flags;
  }
  for (const token of value.split(",")) {
    const feature = token.trim();
    if (isKnownFeature(feature)) flags[feature] = true;
  }
  return flags;
}

function parseTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 250 && parsed <= 60_000) return Math.floor(parsed);
  return DEFAULT_JEV_TIMEOUT_MS;
}

function parseBlockThreshold(raw: string | undefined): number {
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1) return parsed;
  return DEFAULT_JEV_BLOCK_THRESHOLD;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function readJevEnvConfig(env: EnvLike = process.env): JevEnvConfig {
  const baseUrlRaw = env.OMNIROUTE_JEV_BASE_URL?.trim();
  const providerId = env.OMNIROUTE_JEV_PROVIDER?.trim();
  return {
    enabledMode: parseEnabledMode(env.OMNIROUTE_JEV_ENABLED),
    apiKey: env.OMNIROUTE_JEV_API_KEY?.trim() || env.TYPESAFE_API_KEY?.trim() || null,
    baseUrl: baseUrlRaw ? stripTrailingSlashes(baseUrlRaw) : null,
    wire: parseWire(env.OMNIROUTE_JEV_WIRE),
    providerId: providerId || null,
    model: env.OMNIROUTE_JEV_MODEL?.trim() || null,
    timeoutMs: parseTimeoutMs(env.OMNIROUTE_JEV_TIMEOUT_MS),
    features: parseJevFeatures(env.OMNIROUTE_JEV_FEATURES),
    blockThreshold: parseBlockThreshold(env.OMNIROUTE_JEV_BLOCK_THRESHOLD),
  };
}

/**
 * Synchronous, env-only gate for a single lane. Used on hot paths before any
 * credential/DB work: a lane that is off here can never engage, even when a
 * credential would resolve.
 */
export function isJevFeatureEnabled(feature: JevFeature, env: EnvLike = process.env): boolean {
  const config = readJevEnvConfig(env);
  if (config.enabledMode === "off") return false;
  return config.features[feature] === true;
}

const RUNTIME_POSITIVE_TTL_MS = 60_000;
const RUNTIME_NEGATIVE_TTL_MS = 15_000;

let runtimeCache: { at: number; value: JevRuntime | null } | null = null;

interface DecisionConnection {
  apiKey: string | null;
  baseUrl: string | null;
}

/**
 * Read a provider connection's credential + base URL. The row wins; the static
 * provider registry supplies the base URL when the row stores none (built-in
 * providers). Lazy imports keep this service out of client import graphs.
 */
async function readDecisionConnection(providerId: string): Promise<DecisionConnection | null> {
  let apiKey: string | null = null;
  let baseUrl: string | null = null;
  try {
    const { getDbInstance } = await import("../../../src/lib/db/core.ts");
    const { decrypt, isEncryptionEnabled } = await import("../../../src/lib/db/encryption.ts");
    const db = getDbInstance() as unknown as {
      prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
    };
    const row = db
      .prepare(
        "SELECT api_key, base_url FROM provider_connections WHERE provider = ? AND is_active = 1 LIMIT 1"
      )
      .get(providerId) as { api_key?: unknown; base_url?: unknown } | undefined;
    const rawKey = row?.api_key;
    if (typeof rawKey === "string" && rawKey.length > 0) {
      const value = isEncryptionEnabled() ? decrypt(rawKey, { quiet: true }) : rawKey;
      apiKey = typeof value === "string" && value.length > 0 ? value : null;
    }
    const rawBase = row?.base_url;
    if (typeof rawBase === "string" && rawBase.trim().length > 0) {
      baseUrl = stripTrailingSlashes(rawBase.trim());
    }
  } catch {
    // Missing DB, missing table or decrypt failure all reduce to "no row data".
  }

  if (!baseUrl) {
    try {
      const { REGISTRY } = await import("../../config/providers/index.ts");
      const entry = REGISTRY[providerId];
      if (entry && typeof entry.baseUrl === "string" && entry.baseUrl.length > 0) {
        baseUrl = stripTrailingSlashes(entry.baseUrl);
      }
    } catch {
      // Registry unavailable — baseUrl stays null.
    }
  }

  if (!apiKey && !baseUrl) return null;
  return { apiKey, baseUrl };
}

/**
 * Resolve the runtime credential + connection settings. Returns `null` when the
 * master switch is off or the configuration is incomplete (fail-open for
 * callers). Results are memoized (positive 60s / negative 15s) so hot paths
 * never hit the DB per request.
 *
 * Resolution order:
 *   - key:      OMNIROUTE_JEV_API_KEY || TYPESAFE_API_KEY || connection key
 *   - base URL: OMNIROUTE_JEV_BASE_URL || (explicit provider) connection/registry
 *               || the typesafe default (typesafe wire only)
 *   - wire:     OMNIROUTE_JEV_WIRE || (non-typesafe provider ? "openai" : "typesafe")
 *   - model:    OMNIROUTE_JEV_MODEL || "jev-latest" (typesafe wire only — an
 *               OpenAI-compatible classifier endpoint always needs an explicit
 *               model id)
 */
export async function resolveJevRuntime(): Promise<JevRuntime | null> {
  const env = readJevEnvConfig();
  if (env.enabledMode === "off") return null;

  const now = Date.now();
  if (runtimeCache) {
    const ttl = runtimeCache.value ? RUNTIME_POSITIVE_TTL_MS : RUNTIME_NEGATIVE_TTL_MS;
    if (now - runtimeCache.at < ttl) return runtimeCache.value;
  }

  // The typesafe row is consulted for the key even without an explicit provider
  // (dashboard-managed credentials); an explicit provider additionally supplies
  // its base URL.
  const connection = await readDecisionConnection(env.providerId ?? "typesafe");
  const apiKey = env.apiKey ?? connection?.apiKey ?? null;
  const wire: DecisionWire =
    env.wire ?? (env.providerId && env.providerId !== "typesafe" ? "openai" : "typesafe");
  let resolvedBaseUrl: string | null = env.baseUrl;
  if (!resolvedBaseUrl && env.providerId && connection) resolvedBaseUrl = connection.baseUrl;
  if (!resolvedBaseUrl && wire === "typesafe") resolvedBaseUrl = DEFAULT_JEV_BASE_URL;
  const model = env.model ?? (wire === "typesafe" ? DEFAULT_JEV_MODEL : null);

  const value: JevRuntime | null =
    apiKey && resolvedBaseUrl && model
      ? {
          apiKey,
          baseUrl: resolvedBaseUrl,
          model,
          wire,
          timeoutMs: env.timeoutMs,
          blockThreshold: env.blockThreshold,
        }
      : null;

  runtimeCache = { at: now, value };
  if (!value && env.enabledMode === "on") {
    log.warn("Decision model is enabled but the configuration is incomplete; lanes stay inert", {
      hasKey: Boolean(apiKey),
      hasBaseUrl: Boolean(resolvedBaseUrl),
      hasModel: Boolean(model),
      wire,
      providerId: env.providerId ?? null,
    });
  }
  return value;
}

export function __resetJevRuntimeCacheForTests(): void {
  runtimeCache = null;
}
