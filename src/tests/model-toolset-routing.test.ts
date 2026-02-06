import { expect, test } from "bun:test";
import { isGeminiModel, isOpenAIModel } from "../tools/manager";

test("routes GPT/Codex models to codex toolset family", () => {
  const codexModels = [
    "gpt-5.3-codex-plus-pro-high",
    "chatgpt-plus-pro/gpt-5.3-codex",
    "openai/gpt-5.3-codex",
    "cliproxy/gpt-5.3-codex-high",
    "cliproxy/copilot-gpt-5.3-codex-high",
    "lc-openai/gpt-5.3-codex",
    "openrouter/openai/gpt-5.3-codex",
  ];

  for (const model of codexModels) {
    expect(isOpenAIModel(model)).toBe(true);
    expect(isGeminiModel(model)).toBe(false);
  }
});

test("routes Gemini models to gemini toolset family", () => {
  const geminiModels = [
    "gemini-pro",
    "google_ai/gemini-2.5-pro",
    "google_vertex/gemini-3-pro-preview",
    "lc-gemini/gemini-2.5-pro",
    "cliproxy/gemini-3-pro-preview",
    "cliproxy/copilot-gemini-3-pro-preview",
    "openrouter/google/gemini-2.5-pro",
  ];

  for (const model of geminiModels) {
    expect(isGeminiModel(model)).toBe(true);
    expect(isOpenAIModel(model)).toBe(false);
  }
});

test("routes Claude and non-matching models to default family", () => {
  const defaultModels = [
    "opus",
    "anthropic/claude-opus-4-5-20251101",
    "cliproxy/gemini-claude-opus-4-5-thinking",
    "some-provider/custom-model",
  ];

  for (const model of defaultModels) {
    expect(isOpenAIModel(model)).toBe(false);
    expect(isGeminiModel(model)).toBe(false);
  }
});