import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { RERANK_PROVIDERS } from "@omniroute/open-sse/config/rerankRegistry.ts";
import { getProviderCredentials } from "@/sse/services/auth";
import {
  buildRerankProviderListing,
  mergeRerankProviderListings,
} from "@/lib/memory/embedding/rerankListings";
import { listProviderNodeModalityListings } from "@/lib/memory/embedding/nodeModalityListings";
import { getDisabledRerankProviders } from "@/lib/rerank/disabledRerankProviders";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

/**
 * GET /api/memory/rerank-providers
 *
 * Lists rerank providers with hasKey state for the memory Rerank selector:
 * curated RERANK_PROVIDERS entries first, then local provider_nodes.
 */
export async function GET(request: NextRequest) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const curated = [];
    // The instance-level rerank blocklist hides a disabled provider here too,
    // so the Memory Rerank selector never offers a provider the rerank route
    // would refuse to dispatch.
    const disabledRerankProviders = await getDisabledRerankProviders();
    for (const [providerId, config] of Object.entries(RERANK_PROVIDERS)) {
      if (disabledRerankProviders.has("*")) continue;
      if (disabledRerankProviders.has(providerId.toLowerCase())) continue;
      let hasKey = false;
      try {
        const creds = await getProviderCredentials(providerId);
        hasKey = !!(
          creds &&
          !("allRateLimited" in creds && (creds as { allRateLimited?: boolean }).allRateLimited) &&
          ((creds as { apiKey?: string | null }).apiKey ||
            (creds as { accessToken?: string | null }).accessToken)
        );
      } catch {
        hasKey = false;
      }
      curated.push(buildRerankProviderListing(providerId, config, hasKey));
    }

    // Local provider nodes, listed with the rerank-typed models they expose
    // (synced + custom rows; see nodeModalityListings.ts).
    const extra = await listProviderNodeModalityListings("rerank");

    return NextResponse.json({ providers: mergeRerankProviderListings(curated, extra) });
  } catch (err: unknown) {
    const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: { message } }, { status: 500 });
  }
}
