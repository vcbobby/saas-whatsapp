import { getLlmEnv } from "@/lib/env";
import { createAnthropicProvider, createGeminiProvider, createMockProvider, createOpenAiCompatibleProvider } from "./adapters";
import type { LlmProvider } from "./provider";

export function getLlmProvider(): LlmProvider {
  const env = getLlmEnv();
  switch (env.LLM_PROVIDER) {
    case "mock":
      return createMockProvider();
    case "gemini":
      return createGeminiProvider({ apiKey: env.LLM_API_KEY!, model: env.LLM_MODEL! });
    case "anthropic":
      return createAnthropicProvider({ apiKey: env.LLM_API_KEY!, model: env.LLM_MODEL! });
    case "openai":
      return createOpenAiCompatibleProvider({ apiKey: env.LLM_API_KEY!, model: env.LLM_MODEL!, baseUrl: env.LLM_BASE_URL! });
  }
}
