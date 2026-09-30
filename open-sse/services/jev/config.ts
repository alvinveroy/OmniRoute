/**
 * Jev configuration: env contract, feature lanes and runtime credential
 * resolution (env first, then the dashboard-managed `typesafe` provider
 * connection in the SQLite store).
 *
 * Fail-open contract: every surface that consults Jev keeps its historical
 * behavior when this module cannot resolve a credential — the runtime
 * resolver returns `null`, callers no-op.
 */
import { logger } from "../../utils/logger.ts";
import type { JevFeature } from "./types.ts";

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
  baseUrl: string;
  model: string;
  timeoutMs: number;
  features: JevFeatureFlags;
  blockThreshold: number;
}

export interface JevRuntime {
  apiKey: string;
  baseUrl: string;
  model: string;
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

export function readJevEnvConfig(env: EnvLike = process.env): JevEnvConfig {
  const apiKey = env.OMNIROUTE_JEV_API_KEY?.trim() || env.TYPESAFE_API_KEY?.trim() || null;
  const baseUrl =
    env.OMNIROUTE_JEV_BASE_URL?.trim().replace(/\/+$/, "") ||
    env.TYPESAFE_BASE_URL?.trim().replace(/\/+$/, "") ||
    DEFAULT_JEV_BASE_URL;
  return {
    enabledMode: parseEnabledMode(env.OMNIROUTE_JEV_ENABLED),
    apiKey,
    baseUrl,
    model: env.OMNIROUTE_JEV_MODEL?.trim() || DEFAULT_JEV_MODEL,
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

/**
 * Read the dashboard-managed `typesafe` provider connection credential.
 * Lazy DB import keeps this service out of client/most server import graphs.
 */
async function readTypesafeConnectionKey(): Promise<string | null> {
  try {
    const { getDbInstance } = await import("../../../src/lib/db/core.ts");
    const { decrypt, isEncryptionEnabled } = await import("../../../src/lib/db/encryption.ts");
    const db = getDbInstance() as unknown as {
      prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
    };
    const row = db
      .prepare(
        "SELECT api_key FROM provider_connections WHERE provider = 'typesafe' AND is_active = 1 LIMIT 1"
      )
      .get() as { api_key?: unknown } | undefined;
    const raw = row?.api_key;
    if (typeof raw !== "string" || raw.length === 0) return null;
    const value = isEncryptionEnabled() ? decrypt(raw, { quiet: true }) : raw;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    // Missing DB, missing table or decrypt failure all reduce to "no credential".
    return null;
  }
}

/**
 * Resolve the runtime credential + connection settings. Returns `null` when the
 * master switch is off or no credential is available (fail-open for callers).
 * Results are memoized (positive 60s / negative 15s) so hot paths never hit the
 * DB per request.
 */
export async function resolveJevRuntime(): Promise<JevRuntime | null> {
  const env = readJevEnvConfig();
  if (env.enabledMode === "off") return null;

  const now = Date.now();
  if (runtimeCache) {
    const ttl = runtimeCache.value ? RUNTIME_POSITIVE_TTL_MS : RUNTIME_NEGATIVE_TTL_MS;
    if (now - runtimeCache.at < ttl) return runtimeCache.value;
  }

  const apiKey = env.apiKey ?? (await readTypesafeConnectionKey());
  const value: JevRuntime | null = apiKey
    ? {
        apiKey,
        baseUrl: env.baseUrl,
        model: env.model,
        timeoutMs: env.timeoutMs,
        blockThreshold: env.blockThreshold,
      }
    : null;
  runtimeCache = { at: now, value };
  if (!value && env.enabledMode === "on") {
    log.warn(
      "Jev is enabled (OMNIROUTE_JEV_ENABLED=on) but no credential resolved; decisions stay inert",
      { hasEnvKey: Boolean(env.apiKey) }
    );
  }
  return value;
}

export function __resetJevRuntimeCacheForTests(): void {
  runtimeCache = null;
}
