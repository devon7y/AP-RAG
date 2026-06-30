// AP-RAG uses a single answer model — gpt-5-mini (OpenAI), exactly like the `aprag`
// CLI. The template's multi-model / AI-Gateway selector is replaced by the
// reasoning-effort + retrieval-mode controls (see RagControls). This file keeps the
// symbols the rest of the template imports, but collapsed to that one model.

export const CHAT_MODEL_ID = "gpt-5.4-mini";
export const DEFAULT_CHAT_MODEL = CHAT_MODEL_ID;

// Answer-synthesis reasoning effort, mirroring the CLI's `--reasoning`. gpt-5.4-mini's
// levels are none/low/medium/high/xhigh (it does NOT accept "minimal"); "none" (no
// reasoning tokens — fastest) is the default.
export const REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "none";

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
  name: "gpt-5.4-mini",
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
    name: "gpt-5.4-mini",
    provider: "openai",
    description: "AP-RAG answer synthesis (OpenAI gpt-5.4-mini)",
  },
];

// gpt-5-mini is a reasoning model with vision; it streams text. We never expose the
// template's document/weather tools, so `tools` is false (keeps the attach button and
// reasoning UI behaving sensibly without hitting the AI Gateway).
const GPT5_MINI_CAPABILITIES: ModelCapabilities = {
  tools: false,
  vision: true,
  reasoning: true,
};

export function getCapabilities(): Record<string, ModelCapabilities> {
  return { [CHAT_MODEL_ID]: GPT5_MINI_CAPABILITIES };
}

export const isDemo = process.env.IS_DEMO === "1";

export type GatewayModelWithCapabilities = ChatModel & {
  capabilities: ModelCapabilities;
};

export function getAllGatewayModels(): GatewayModelWithCapabilities[] {
  return chatModels.map((m) => ({ ...m, capabilities: GPT5_MINI_CAPABILITIES }));
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
