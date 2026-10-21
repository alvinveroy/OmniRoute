// ── Adaptive TLS-fingerprint ladder ──────────────────────────────────────────
// The wreq-js (browser-JA3) transport fixes Cloudflare 1010 signature bans but
// empirically STALLS streaming inference: the response object resolves yet its
// body produces no bytes for minutes (observed 2026-09-03/04 — opencode-go,
// command-code, bailian all zero-byte while plain node fetch streamed the same
// requests in seconds). So the transport must never be eager by default:
//
//   1. Plain direct fetch is the fast path.
//   2. When a response is a Cloudflare fingerprint rejection (403 +
//      error_code 1010 / browser_signature_banned), the provider is ARMED in a
//      TTL cache and the request is retried once through wreq-js.
//   3. Every wreq response carries a first-byte watchdog: if the gateway
//      buffers beyond the window, the request falls back to the direct
//      dispatcher instead of hanging the caller.
//
// Operators can still force eager impersonation per provider with the legacy
// TLS_FINGERPRINT_PROVIDERS allowlist (then the watchdog is the only guard).
const FINGERPRINT_ARM_TTL_MS = 60 * 60 * 1000;
const fingerprintArmedUntil = new Map<string, number>();

export function providerFingerprintArmed(provider: string | null | undefined): boolean {
  if (!provider) return false;
  const key = provider.trim().toLowerCase();
  const until = fingerprintArmedUntil.get(key);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    fingerprintArmedUntil.delete(key);
    return false;
  }
  return true;
}

export function armProviderFingerprint(provider: string | null | undefined): boolean {
  if (!provider) return false;
  fingerprintArmedUntil.set(provider.trim().toLowerCase(), Date.now() + FINGERPRINT_ARM_TTL_MS);
  return true;
}

/** Cheap transport-level sniff: Cloudflare 1010 / browser-signature ban body. */
export async function looksLikeFingerprintRejection(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    const peek = response.clone();
    const text = await peek.text();
    return /error_code"?\s*:\s*"?1010|browser_signature_banned|fingerprint_rejection/i.test(text);
  } catch {
    return false;
  }
}
