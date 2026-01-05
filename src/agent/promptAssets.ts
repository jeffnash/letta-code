// Additional system prompts for /system command

import anthropicPrompt from "./prompts/claude.md";
import codexPrompt from "./prompts/codex.md";
import geminiPrompt from "./prompts/gemini.md";
import humanPrompt from "./prompts/human.mdx";
// init_memory.md is now a bundled skill at src/skills/builtin/init/SKILL.md
import lettaAnthropicPrompt from "./prompts/letta_claude.md";
import lettaCodexPrompt from "./prompts/letta_codex.md";
import lettaGeminiPrompt from "./prompts/letta_gemini.md";
import loadedSkillsPrompt from "./prompts/loaded_skills.mdx";
import memoryCheckReminder from "./prompts/memory_check_reminder.txt";
import personaPrompt from "./prompts/persona.mdx";
import personaClaudePrompt from "./prompts/persona_claude.mdx";
import personaKawaiiPrompt from "./prompts/persona_kawaii.mdx";
import planModeReminder from "./prompts/plan_mode_reminder.txt";
import projectPrompt from "./prompts/project.mdx";
import rememberPrompt from "./prompts/remember.md";
import skillCreatorModePrompt from "./prompts/skill_creator_mode.md";
import skillUnloadReminder from "./prompts/skill_unload_reminder.txt";
import skillsPrompt from "./prompts/skills.mdx";
import stylePrompt from "./prompts/style.mdx";
import systemPrompt from "./prompts/system_prompt.txt";

export const SYSTEM_PROMPT = systemPrompt;
export const PLAN_MODE_REMINDER = planModeReminder;
export const SKILL_UNLOAD_REMINDER = skillUnloadReminder;
export const SKILL_CREATOR_PROMPT = skillCreatorModePrompt;
export const REMEMBER_PROMPT = rememberPrompt;
export const MEMORY_CHECK_REMINDER = memoryCheckReminder;

/**
 * Error thrown when a bundled prompt asset is missing or invalid.
 * This indicates a build/packaging issue that requires reinstallation.
 */
export class MissingPromptAssetError extends Error {
  constructor(assetName: string, details?: string) {
    const message =
      `Missing bundled prompt asset: ${assetName}. ` +
      `This usually means the CLI was not built correctly. ` +
      `Try reinstalling with: npm install -g letta-code` +
      (details ? ` (${details})` : "");
    super(message);
    this.name = "MissingPromptAssetError";
  }
}

/**
 * Validate that all critical prompt assets are present and non-empty.
 * Call this early in the CLI startup to catch packaging issues.
 *
 * @throws {MissingPromptAssetError} if any critical asset is missing
 */
export function validatePromptAssets(): void {
  const criticalAssets: Array<[string, unknown]> = [
    ["systemPrompt", systemPrompt],
    ["lettaAnthropicPrompt", lettaAnthropicPrompt],
    ["lettaCodexPrompt", lettaCodexPrompt],
    ["lettaGeminiPrompt", lettaGeminiPrompt],
    ["personaPrompt", personaPrompt],
    ["humanPrompt", humanPrompt],
    ["projectPrompt", projectPrompt],
    ["skillsPrompt", skillsPrompt],
    ["loadedSkillsPrompt", loadedSkillsPrompt],
  ];

  for (const [name, asset] of criticalAssets) {
    if (asset === undefined || asset === null) {
      throw new MissingPromptAssetError(name, "asset is undefined/null");
    }
    if (typeof asset !== "string") {
      throw new MissingPromptAssetError(
        name,
        `expected string, got ${typeof asset}`,
      );
    }
    if (asset.trim().length === 0) {
      throw new MissingPromptAssetError(name, "asset is empty");
    }
  }
}

/**
 * Get a diagnostic report of all prompt assets for debugging.
 * Useful for troubleshooting build/packaging issues.
 */
export function getPromptAssetsDiagnostics(): Record<
  string,
  { loaded: boolean; length: number; preview: string }
> {
  const assets: Array<[string, unknown]> = [
    ["systemPrompt", systemPrompt],
    ["lettaAnthropicPrompt", lettaAnthropicPrompt],
    ["lettaCodexPrompt", lettaCodexPrompt],
    ["lettaGeminiPrompt", lettaGeminiPrompt],
    ["anthropicPrompt", anthropicPrompt],
    ["codexPrompt", codexPrompt],
    ["geminiPrompt", geminiPrompt],
    ["personaPrompt", personaPrompt],
    ["personaClaudePrompt", personaClaudePrompt],
    ["personaKawaiiPrompt", personaKawaiiPrompt],
    ["humanPrompt", humanPrompt],
    ["projectPrompt", projectPrompt],
    ["skillsPrompt", skillsPrompt],
    ["loadedSkillsPrompt", loadedSkillsPrompt],
    ["stylePrompt", stylePrompt],
    ["planModeReminder", planModeReminder],
    ["skillUnloadReminder", skillUnloadReminder],
    ["skillCreatorModePrompt", skillCreatorModePrompt],
    ["rememberPrompt", rememberPrompt],
    ["memoryCheckReminder", memoryCheckReminder],
  ];

  const result: Record<
    string,
    { loaded: boolean; length: number; preview: string }
  > = {};

  for (const [name, asset] of assets) {
    if (typeof asset === "string") {
      result[name] = {
        loaded: true,
        length: asset.length,
        preview:
          asset.substring(0, 50).replace(/\n/g, "\\n") +
          (asset.length > 50 ? "..." : ""),
      };
    } else {
      result[name] = {
        loaded: false,
        length: 0,
        preview: `[${typeof asset}]`,
      };
    }
  }

  return result;
}

export const MEMORY_PROMPTS: Record<string, string> = {
  "persona.mdx": personaPrompt,
  "persona_claude.mdx": personaClaudePrompt,
  "persona_kawaii.mdx": personaKawaiiPrompt,
  "human.mdx": humanPrompt,
  "project.mdx": projectPrompt,
  "skills.mdx": skillsPrompt,
  "loaded_skills.mdx": loadedSkillsPrompt,
  "style.mdx": stylePrompt,
};

// System prompt options for /system command
export interface SystemPromptOption {
  id: string;
  label: string;
  description: string;
  content: string;
  isDefault?: boolean;
  isFeatured?: boolean;
}

export const SYSTEM_PROMPTS: SystemPromptOption[] = [
  {
    id: "default",
    label: "Default",
    description: "Standard Letta Code system prompt (Claude-optimized)",
    content: lettaAnthropicPrompt,
    isDefault: true,
    isFeatured: true,
  },
  {
    id: "legacy",
    label: "Legacy",
    description: "Original system prompt",
    content: systemPrompt,
  },
  {
    id: "letta-codex",
    label: "Codex",
    description: "For Codex models",
    content: lettaCodexPrompt,
    isFeatured: true,
  },
  {
    id: "letta-gemini",
    label: "Gemini",
    description: "For Gemini models",
    content: lettaGeminiPrompt,
    isFeatured: true,
  },
  {
    id: "anthropic",
    label: "Claude (basic)",
    description: "For Claude models (no skills/memory instructions)",
    content: anthropicPrompt,
  },
  {
    id: "codex",
    label: "Codex (basic)",
    description: "For Codex models (no skills/memory instructions)",
    content: codexPrompt,
  },
  {
    id: "gemini",
    label: "Gemini (basic)",
    description: "For Gemini models (no skills/memory instructions)",
    content: geminiPrompt,
  },
];

/**
 * Resolve a system prompt ID to its content.
 *
 * Resolution order:
 * 1. If it matches an ID from SYSTEM_PROMPTS, use its content
 * 2. If it matches a subagent name, use that subagent's system prompt
 * 3. Otherwise, use the default system prompt
 *
 * @param systemPromptId - The system prompt ID (e.g., "codex") or subagent name (e.g., "explore")
 * @returns The resolved system prompt content
 */
export async function resolveSystemPrompt(
  systemPromptId: string | undefined,
): Promise<string> {
  // No input - use default
  if (!systemPromptId) {
    return SYSTEM_PROMPT;
  }

  // 1. Check if it matches a system prompt ID
  const matchedPrompt = SYSTEM_PROMPTS.find((p) => p.id === systemPromptId);
  if (matchedPrompt) {
    return matchedPrompt.content;
  }

  // 2. Check if it matches a subagent name
  const { getAllSubagentConfigs } = await import("./subagents");
  const subagentConfigs = await getAllSubagentConfigs();
  const matchedSubagent = subagentConfigs[systemPromptId];
  if (matchedSubagent) {
    return matchedSubagent.systemPrompt;
  }

  // 3. Fall back to default
  return SYSTEM_PROMPT;
}
