// AP-RAG uses a single answer model — gpt-6-luna (OpenAI), exactly like the `aprag`
// CLI. The template's multi-model / AI-Gateway selector is replaced by the
// reasoning-effort + retrieval-mode controls (see RagControls). This file keeps the
// symbols the rest of the template imports, but collapsed to that one model.

export const CHAT_MODEL_ID = "gpt-6-luna";
export const DEFAULT_CHAT_MODEL = CHAT_MODEL_ID;

// Fast mode (renamed from Priority Processing on 2026-07-30): ~2.5x faster and more
// consistent latency for a 2x per-token premium. On gpt-6-luna that lands at
// $0.20/$1.00 per MTok (short context), half of gpt-5.6-luna's Fast price. The API takes
// "fast" or "priority" interchangeably, and gpt-6-luna reports "fast" either way.
// @ai-sdk/openai decides per model ID whether a model gets the fast tier and reasoning
// options, and SILENTLY DROPS both for an ID it doesn't recognize (it only logs a
// warning). 3.0.118 recognizes gpt-6; 3.0.74 did not, and would have sent this model on
// standard processing with no reasoning effort. Check the SDK's
// getOpenAILanguageModelCapabilities before changing CHAT_MODEL_ID to a new family.
// Under a hard traffic ramp OpenAI may downgrade a request and bill standard rates —
// the response then reports service_tier "default".
export const SERVICE_TIER = "fast" as const;

// Answer-synthesis reasoning effort, mirroring the CLI's `--reasoning`. "none" (no
// reasoning tokens — fastest) is the default. gpt-6-luna also documents a "max" level,
// but it is Responses-API-only and the PC query server reaches Luna over Chat
// Completions, where it 400s — so the ladder is kept identical across both surfaces on
// purpose. "minimal" is rejected outright.
export const REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "none";

// Output verbosity. Low = fewer output tokens, generated faster. The deployment
// checklist says to pick this per use case rather than globally, so it is stated at
// each call site: "low" for the mechanical calls (titles, JSON extraction), and
// SYNTH_VERBOSITY for the long-form answer/digest surfaces, where too tight a setting
// costs citation coverage and nuance.
export const SYNTH_VERBOSITY = "low" as const;

/**
 * Provider options for every OpenAI call in the app: always Fast mode, with the
 * reasoning effort and verbosity stated explicitly at each call site (mechanical calls
 * pass "none"/"low"; user-facing synthesis passes the requested level).
 */
export function openaiOptions(
  reasoningEffort: string = "none",
  textVerbosity: "low" | "medium" | "high" = "low"
) {
  return {
    openai: { serviceTier: SERVICE_TIER, reasoningEffort, textVerbosity },
  };
}

// Concrete LightRAG retrieval strategies (what the query server actually accepts),
// mirroring the CLI's `--mode`.
export const CONCRETE_RETRIEVAL_MODES = [
  "hybrid",
  "local",
  "global",
  "mix",
  "naive",
] as const;
export type ConcreteRetrievalMode = (typeof CONCRETE_RETRIEVAL_MODES)[number];

// UI-facing modes: "auto" lets the condense LLM pick the strategy per question; the route
// resolves it to a concrete mode before retrieving (the PC never sees "auto").
export const RETRIEVAL_MODES = [
  "auto",
  "hybrid",
  "local",
  "global",
  "mix",
  "naive",
] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];
export const DEFAULT_RETRIEVAL_MODE: RetrievalMode = "auto";

export const titleModel = {
  id: CHAT_MODEL_ID,
  name: CHAT_MODEL_ID,
  provider: "openai",
  description: "Title generation",
};

export type ModelCapabilities = {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
};

export type ChatModel = {
  id: string;
  name: string;
  provider: string;
  description: string;
  gatewayOrder?: string[];
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
};

export const chatModels: ChatModel[] = [
  {
    id: CHAT_MODEL_ID,
    name: CHAT_MODEL_ID,
    provider: "openai",
    description: "AP-RAG answer synthesis (OpenAI gpt-6-luna, Fast mode)",
  },
];

// Luna is a reasoning model with vision; it streams text. We never expose the
// template's document/weather tools, so `tools` is false (keeps the attach button and
// reasoning UI behaving sensibly without hitting the AI Gateway).
const ANSWER_MODEL_CAPABILITIES: ModelCapabilities = {
  tools: false,
  vision: true,
  reasoning: true,
};

export function getCapabilities(): Record<string, ModelCapabilities> {
  return { [CHAT_MODEL_ID]: ANSWER_MODEL_CAPABILITIES };
}

export const isDemo = process.env.IS_DEMO === "1";

export type GatewayModelWithCapabilities = ChatModel & {
  capabilities: ModelCapabilities;
};

export function getAllGatewayModels(): GatewayModelWithCapabilities[] {
  return chatModels.map((m) => ({ ...m, capabilities: ANSWER_MODEL_CAPABILITIES }));
}

export function getActiveModels(): ChatModel[] {
  return chatModels;
}

export const allowedModelIds = new Set(chatModels.map((m) => m.id));

export const modelsByProvider = chatModels.reduce(
  (acc, model) => {
    if (!acc[model.provider]) {
      acc[model.provider] = [];
    }
    acc[model.provider].push(model);
    return acc;
  },
  {} as Record<string, ChatModel[]>
);
