import type { RegistryEntry } from "../../shared.ts";

export const nvidiaProvider: RegistryEntry = {
  id: "nvidia",
  alias: "nvidia",
  format: "openai",
  executor: "default",
  baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  toolNameMaxLength: 64,
  // #6773: NVIDIA multiplexes models from multiple upstream vendors
  // (moonshotai/, deepseek-ai/, nvidia/, meta/, poolside/, google/, openai/)
  // behind ONE connection — mark it passthrough
  // so a single stale/renamed model's 404 locks out only that model instead
  // of cooling down the whole connection (see accountFallback.ts
  // hasPerModelQuota doc comment; matches modelscope/synthetic/kilo-gateway).
  passthroughModels: true,
  // NVIDIA's `GET /v1/models` is a PARTIAL view of what the credential can
  // route: it lists the media/infra buckets (flux, whisper, tacotron2,
  // parakeet, embeddings, rerankers) and only the two `nvidia/*` chat models,
  // while the static registry below also carries the third-party vendors the
  // same connection fronts (moonshotai/, deepseek-ai/, meta/, poolside/,
  // openai/). With the default `liveCatalogAuthoritative: true` every one of
  // those static routes was rejected pre-dispatch with
  // "Model '<id>' is not available in the active live catalog for provider
  // 'nvidia'" — observed 159× on 2026-09-12 for `moonshotai/kimi-k3` alone,
  // which also made the nvidia combo target unusable.
  //
  // Opt out so exact-id coverage suppression keeps the omitted static routes
  // routable (same contract as command-code / oneminai / perplexity-agent,
  // whose discovery is likewise a partial routing catalog). A model that the
  // credential genuinely cannot serve still fails upstream with its own 4xx,
  // and `passthroughModels` above keeps that failure scoped to the one model.
  liveCatalogAuthoritative: false,
  models: [
    // #18418: NVIDIA retired the free endpoints for moonshotai/kimi-k3 (2026-10-15),
    // deepseek-ai/deepseek-v4-pro-0813 (2026-09-14), deepseek-ai/deepseek-v4-flash-0731
    // (2026-09-21) and openai/gpt-oss-120b (2026-09-03); each now answers 410 "reached its
    // end of life", so they are no longer listed here.
    { id: "meta/muse-glimmer-30b", name: "Muse Glimmer 30B" },
    { id: "poolside/laguna-xs-2.1", name: "Laguna XS 2.1" },
    { id: "google/gemma-4-31b-it", name: "Gemma 4 31B" },
    { id: "google/diffusiongemma-26b-a4b-it", name: "DiffusionGemma 26B A4B IT" },
    { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra 550B A55B" },
    // Nemotron 3 Super 120B A12B was retired by NVIDIA on 2026-10-20 (404 "Function not found");
    // Nemotron 3.5 Super VL is NVIDIA's announced replacement (NVIDIA/NemoClaw#13536).
    {
      id: "nvidia/nemotron-3.5-super-vl-120b-a12b",
      name: "Nemotron 3.5 Super VL 120B A12B",
      supportsVision: true,
    },
    {
      id: "nvidia/nemotron-3.5-lightning-30b-a3b",
      name: "Nemotron 3.5 Lightning 30B A3B",
    },
    {
      id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      name: "Nemotron 3 Nano Omni 30B A3B Reasoning",
      supportsReasoning: true,
      supportsVision: true,
    },
  ],
};
