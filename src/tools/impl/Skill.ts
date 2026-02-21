import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getClient } from "../../agent/client";
import { getConversationId, getCurrentAgentId, getSkillsDirectory } from "../../agent/context";
import {
  GLOBAL_SKILLS_DIR,
  getAgentSkillsDir,
  getBundledSkills,
  SKILLS_DIR,
} from "../../agent/skills";
import { queueSkillContent } from "./skillContentRegistry";
import { validateRequiredParams } from "./validation.js";

interface SkillArgs {
  skill: string;
  args?: string;
  /** Injected by executeTool - the tool_call_id for this invocation */
  toolCallId?: string;
}

interface SkillResult {
  message: string;
}

// Cache for isolated block IDs: Map<label, blockId>
// This avoids repeated API calls within a session
let isolatedBlockCache: Map<string, string> | null = null;
let cachedConversationId: string | null = null;

/**
 * Clear the cache (called when conversation changes or on errors)
 */
function clearIsolatedBlockCache(): void {
  isolatedBlockCache = null;
  cachedConversationId = null;
}

/**
 * Clear the skill block cache (called when conversation changes during session).
 * This is the public API for cache invalidation.
 */
export function clearSkillBlockCache(): void {
  clearIsolatedBlockCache();
}

/**
 * Get the block ID for an isolated block label in the current conversation context.
 * Uses caching to avoid repeated API calls.
 * If in a conversation with isolated blocks, returns the isolated block ID.
 * Otherwise returns null (use agent-level block).
 *
 * SAFETY: Any error returns null (falls back to agent-level block).
 * Caching never causes errors - only helps performance.
 */
async function getIsolatedBlockId(
  client: Awaited<ReturnType<typeof getClient>>,
  label: string,
): Promise<string | null> {
  const conversationId = getConversationId();

  // "default" conversation doesn't have isolated blocks
  if (!conversationId || conversationId === "default") {
    return null;
  }

  try {
    // Check if conversation changed - invalidate cache
    if (cachedConversationId !== conversationId) {
      clearIsolatedBlockCache();
      cachedConversationId = conversationId;
    }

    // Check cache first
    if (isolatedBlockCache?.has(label)) {
      return isolatedBlockCache.get(label) ?? null;
    }

    // Cache miss - fetch from API
    const conversation = await client.conversations.retrieve(conversationId);
    const isolatedBlockIds = conversation.isolated_block_ids || [];

    if (isolatedBlockIds.length === 0) {
      // No isolated blocks - cache this fact as empty map
      isolatedBlockCache = new Map();
      return null;
    }

    // Build cache: fetch all isolated blocks and map label -> blockId
    if (!isolatedBlockCache) {
      isolatedBlockCache = new Map();
    }

    for (const blockId of isolatedBlockIds) {
      try {
        const block = await client.blocks.retrieve(blockId);
        if (block.label) {
          isolatedBlockCache.set(block.label, blockId);
        }
      } catch {
        // Individual block fetch failed - skip it, don't fail the whole operation
      }
    }

    return isolatedBlockCache.get(label) ?? null;
  } catch {
    // If anything fails, fall back to agent-level block (safe default)
    // Don't cache the error - next call will try again
    return null;
  }
}

/**
 * Update a block by label, using isolated block if in conversation context.
 *
 * SAFETY: If updating isolated block fails, clears cache and falls back to
 * agent-level block. Errors from agent-level update are propagated (that's
 * the existing behavior).
 */
async function updateBlock(
  client: Awaited<ReturnType<typeof getClient>>,
  agentId: string,
  label: string,
  value: string,
): Promise<void> {
  const isolatedBlockId = await getIsolatedBlockId(client, label);

  if (isolatedBlockId) {
    try {
      // Update the conversation's isolated block directly
      await client.blocks.update(isolatedBlockId, { value });
      return;
    } catch {
      // If isolated block update fails (e.g., block was deleted),
      // clear cache and fall back to agent-level block
      clearIsolatedBlockCache();
      // Fall through to agent-level update
    }
  }

  // Fall back to agent-level block
  await client.agents.blocks.update(label, {
    agent_id: agentId,
    value,
  });
}

/**
 * Retrieve a block by label, using isolated block if in conversation context.
 *
 * SAFETY: If retrieving isolated block fails, clears cache and falls back to
 * agent-level block.
 */
async function retrieveBlock(
  client: Awaited<ReturnType<typeof getClient>>,
  agentId: string,
  label: string,
): Promise<Awaited<ReturnType<typeof client.blocks.retrieve>>> {
  const isolatedBlockId = await getIsolatedBlockId(client, label);

  if (isolatedBlockId) {
    try {
      return await client.blocks.retrieve(isolatedBlockId);
    } catch {
      // If isolated block retrieval fails, clear cache and fall back
      clearIsolatedBlockCache();
      // Fall through to agent-level retrieval
    }
  }

  // Fall back to agent-level block
  return await client.agents.blocks.retrieve(label, { agent_id: agentId });
}

function coreMemoryBlockEditedMessage(label: string): string {
  return (
    `The core memory block with label \`${label}\` has been successfully edited. ` +
    "Your system prompt has been recompiled with the updated memory contents and is now active in your context. " +
    "Review the changes and make sure they are as expected (correct indentation, " +
    "no duplicate lines, etc). Edit the memory block again if necessary."
  );
}

/**
 * Parse loaded_skills block content to extract skill IDs and their content boundaries
 */
function parseLoadedSkills(
  value: string,
): Map<string, { start: number; end: number }> {
  const skillMap = new Map<string, { start: number; end: number }>();
  const skillHeaderRegex = /# Skill: ([^\n]+)/g;

  const headers: { id: string; start: number }[] = [];

  // Find all skill headers
  let match = skillHeaderRegex.exec(value);
  while (match !== null) {
    const skillId = match[1]?.trim();
    if (skillId) {
      headers.push({ id: skillId, start: match.index });
    }
    match = skillHeaderRegex.exec(value);
  }

  // Determine boundaries for each skill
  for (let i = 0; i < headers.length; i++) {
    const current = headers[i];
    const next = headers[i + 1];

    if (!current) continue;

    let end: number;
    if (next) {
      // Find the separator before the next skill
      const searchStart = current.start;
      const searchEnd = next.start;
      const substring = value.substring(searchStart, searchEnd);
      const sepMatch = substring.lastIndexOf("\n\n---\n\n");
      if (sepMatch !== -1) {
        end = searchStart + sepMatch;
      } else {
        end = searchEnd;
      }
    } else {
      end = value.length;
    }

    skillMap.set(current.id, { start: current.start, end });
  }

  return skillMap;
}

/**
 * Get list of loaded skill IDs
 */
function getLoadedSkillIds(value: string): string[] {
  const skillRegex = /# Skill: ([^\n]+)/g;
  const skills: string[] = [];

  let match = skillRegex.exec(value);
  while (match !== null) {
    const skillId = match[1]?.trim();
    if (skillId) {
      skills.push(skillId);
    }
    match = skillRegex.exec(value);
  }

  return skills;
}

/**
 * Extracts skills directory from skills block value
 */
function extractSkillsDir(skillsBlockValue: string): string | null {
  const match = skillsBlockValue.match(/Skills Directory: (.+)/);
  return match ? match[1]?.trim() || null : null;
}

/**
 * Check if a skill directory has additional files beyond SKILL.md
 */
function hasAdditionalFiles(skillMdPath: string): boolean {
  try {
    const skillDir = dirname(skillMdPath);
    const entries = readdirSync(skillDir);
    return entries.some((e) => e.toUpperCase() !== "SKILL.MD");
  } catch {
    return false;
  }
}

/**
 * Read skill content from file or bundled source
 * Returns both content and the path to the SKILL.md file
 *
 * Search order (highest priority first):
 * 1. Project skills (.skills/)
 * 2. Agent skills (~/.letta/agents/{id}/skills/)
 * 3. Global skills (~/.letta/skills/)
 * 4. Bundled skills
 */
async function readSkillContent(
  skillId: string,
  skillsDir: string,
  agentId?: string,
): Promise<{ content: string; path: string }> {
  // 1. Try project skills directory (highest priority)
  const projectSkillPath = join(skillsDir, skillId, "SKILL.md");
  try {
    const content = await readFile(projectSkillPath, "utf-8");
    return { content, path: projectSkillPath };
  } catch {
    // Not in project, continue
  }

  // 2. Try agent skills directory (if agentId provided)
  if (agentId) {
    const agentSkillPath = join(
      getAgentSkillsDir(agentId),
      skillId,
      "SKILL.md",
    );
    try {
      const content = await readFile(agentSkillPath, "utf-8");
      return { content, path: agentSkillPath };
    } catch {
      // Not in agent dir, continue
    }
  }

  // 3. Try global skills directory
  const globalSkillPath = join(GLOBAL_SKILLS_DIR, skillId, "SKILL.md");
  try {
    const content = await readFile(globalSkillPath, "utf-8");
    return { content, path: globalSkillPath };
  } catch {
    // Not in global, continue
  }

  // 4. Try bundled skills (lowest priority)
  const bundledSkills = await getBundledSkills();
  const bundledSkill = bundledSkills.find((s) => s.id === skillId);
  if (bundledSkill?.path) {
    try {
      const content = await readFile(bundledSkill.path, "utf-8");
      return { content, path: bundledSkill.path };
    } catch {
      // Bundled skill path not found, continue to legacy fallback
    }
  }

  // Legacy fallback: check for bundled skills in a repo-level skills directory
  try {
    const bundledSkillsDir = join(process.cwd(), "skills", "skills");
    const bundledSkillPath = join(bundledSkillsDir, skillId, "SKILL.md");
    const content = await readFile(bundledSkillPath, "utf-8");
    return { content, path: bundledSkillPath };
  } catch {
    throw new Error(
      `Skill "${skillId}" not found. Check that the skill name is correct and that it appears in the available skills list.`,
    );
  }
}

/**
 * Get skills directory, trying multiple sources
 */
async function getResolvedSkillsDir(): Promise<string> {
  const skillsDir = getSkillsDirectory();

  if (skillsDir) {
    return skillsDir;
  }

  // Fall back to default .skills directory in cwd
  return join(process.cwd(), SKILLS_DIR);
}

export async function skill(args: SkillArgs): Promise<SkillResult> {
  validateRequiredParams(args, ["skill"], "Skill");
  const { skill: skillName, toolCallId } = args;

  if (!skillName || typeof skillName !== "string") {
    throw new Error(
      'Invalid skill name. The "skill" parameter must be a non-empty string.',
    );
  }

  try {
    const agentId = getCurrentAgentId();
    const skillsDir = await getResolvedSkillsDir();

    // Read the SKILL.md content
    const { content: skillContent, path: skillPath } = await readSkillContent(
      skillName,
      skillsDir,
      agentId,
    );

    // Process the content: replace <SKILL_DIR> placeholder if skill has additional files
    const skillDir = dirname(skillPath);
    const hasExtras = hasAdditionalFiles(skillPath);
    const processedContent = hasExtras
      ? skillContent.replace(/<SKILL_DIR>/g, skillDir)
      : skillContent;

    // Build the full content with skill directory info if applicable
    const dirHeader = hasExtras ? `# Skill Directory: ${skillDir}\n\n` : "";
    const fullContent = `${dirHeader}${processedContent}`;

    // Queue the skill content for harness-level injection as a user message part
    // Wrap in <skill-name> XML tags so the agent can detect already-loaded skills
    if (toolCallId) {
      queueSkillContent(
        toolCallId,
        `<${skillName}>\n${fullContent}\n</${skillName}>`,
      );
    }

    return { message: `Launching skill: ${skillName}` };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to invoke skill "${skillName}": ${String(error)}`);
  }
}
