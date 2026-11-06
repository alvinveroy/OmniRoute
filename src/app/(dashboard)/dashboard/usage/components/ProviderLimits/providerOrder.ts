export const PROVIDER_ORDER_KEY = "omniroute:limits:providerOrder";
/** The surrounding filters must not prevent the sortable overview from mounting without storage. */
export function readLimitsPreference(key: string, fallback = "all"): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

/**
 * A persisted provider/env filter that no longer matches any option is stale:
 * the provider id was renamed or removed, or the connection's env tag is gone.
 * The provider <Select> already displays "All providers" for an unknown value,
 * so the filter state has to follow the same truth — otherwise the account list
 * stays empty ("No accounts found for tier filter All.") with no visible control
 * able to clear it. The env chip row does not render at all when no connection
 * carries a tag, which is why a stale env filter cannot be reset from the UI.
 */
export function isStaleLimitsFilter(selected: string, available: readonly string[]): boolean {
  if (!selected || selected === "all") return false;
  return !available.includes(selected);
}
export function readProviderOrder(
  storage: () => Pick<Storage, "getItem"> = () => localStorage
): string[] {
  try {
    const value: unknown = JSON.parse(storage().getItem(PROVIDER_ORDER_KEY) || "[]");
    return Array.isArray(value) && value.every((id) => typeof id === "string" && id.length > 0)
      ? [...new Set(value)]
      : [];
  } catch {
    return [];
  }
}
export function writeProviderOrder(
  order: string[],
  storage: () => Pick<Storage, "setItem" | "removeItem"> = () => localStorage
) {
  try {
    if (order.length) storage().setItem(PROVIDER_ORDER_KEY, JSON.stringify(order));
    else storage().removeItem(PROVIDER_ORDER_KEY);
  } catch {
    /* Storage is optional; the in-memory order remains usable. */
  }
}
export function applyProviderOrder(
  ids: string[],
  saved: string[],
  defaults: Record<string, number>
): string[] {
  const available = new Set(ids);
  return [
    ...saved.filter((id) => available.has(id)),
    ...[...available]
      .filter((id) => !saved.includes(id))
      .sort((a, b) => (defaults[a] ?? Infinity) - (defaults[b] ?? Infinity) || a.localeCompare(b)),
  ];
}
/** Only replace visible slots. Missing and filtered IDs keep their exact slots and relative order. */
export function mergeVisibleProviderOrder(
  saved: string[],
  all: string[],
  visible: string[],
  defaults: Record<string, number>
): string[] {
  const complete = [
    ...saved,
    ...applyProviderOrder(all, [], defaults).filter((id) => !saved.includes(id)),
  ];
  const shown = new Set(visible);
  let next = 0;
  return complete.map((id) => (shown.has(id) ? visible[next++] : id));
}
