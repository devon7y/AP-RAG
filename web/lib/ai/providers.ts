import { createOpenAI } from "@ai-sdk/openai";
import { customProvider } from "ai";
import { isTestEnvironment } from "../constants";
import { CHAT_MODEL_ID } from "./models";

// Direct OpenAI provider (the user's own key) — not the AI Gateway. gpt-5-mini is the
// single model for both answer synthesis and chat-title generation, matching the CLI.
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const myProvider = isTestEnvironment
  ? (() => {
      const { chatModel, titleModel } = require("./models.mock");
      return customProvider({
        languageModels: {
          "chat-model": chatModel,
          "title-model": titleModel,
        },
      });
    })()
  : null;

export function getLanguageModel(_modelId?: string) {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("chat-model");
  }
  return openai(CHAT_MODEL_ID);
}

export function getTitleModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }
  return openai(CHAT_MODEL_ID);
}
