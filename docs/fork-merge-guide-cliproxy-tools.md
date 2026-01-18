# Fork merge guide: maintaining CLIProxy API tool support

This repo is a fork that maintains **CLIProxy API** support for tools. Upstream changes (especially around tool management and agent initialization) can accidentally break this because upstream’s assumptions are typically:

- tools are already present on the server, or
- tool attachment happens only at agent creation, or
- tool switching only affects local registry, not server-side agent tool bindings.

The fork’s changes ensure **three invariants**:

1. **Tools exist on the server** (upsert if needed).
2. **Agents have the Letta Code tools attached** (link tools to agent).
3. **Toolset switches update the agent’s server-side tool bindings** (unlink old + relink new).

This document explains what to preserve during upstream merges, where conflicts usually occur, and why each piece matters.

---

## What breaks without these changes

Symptoms you’ll see after an upstream merge if something is missing:

- Tool calls fail with “tool not found” / “unknown tool” on the Letta server.
- Agents can chat, but cannot use any client-side tools.
- Switching toolsets appears to work locally, but the agent continues to have stale tool bindings.
- Resumed agents lose tools after model/system prompt updates.

Root cause: upstream may change tool load order / agent creation flows, but **CLIProxy requires tools to be created/upserted and linked at runtime**, because the tool definitions are local and executed via client approval.

---

## Required invariants (keep these after merges)

### 1) Upsert tools to server (cacheable)

**Goal:** ensure the Letta server knows about all client-side tool schemas, with `default_requires_approval: true`.

**Where:** `src/tools/manager.ts`

**Key pieces to preserve:**

- A function to upsert each tool in `toolRegistry` using `client.tools.upsert(...)`.
- Stubs for tool source (Python) so the server has a callable tool definition even though execution is client-side.
- A hash/cache mechanism so upserting isn’t done every run.

Current fork implementation (as of this change set):

- `computeToolsHash()`
- `upsertToolsToServer(client)`
- `upsertToolsIfNeeded(client, serverUrl)`
- `forceUpsertTools(client, serverUrl)`

**Important context from upstream:** `createAgent()` now only attaches *server-side base tools* (e.g. `memory`, `memory_apply_patch`, `web_search`, etc.) and relies on `client_tools` for client-side tools per-request. CLIProxy support intentionally reintroduces server-side tool registration and linking so the backend can “see” the client tools and emit approval requests for them.

**Why:** CLIProxy tool execution depends on tool schemas being registered on the server; otherwise the agent can’t call them.

### 2) Link tools to agents (+ requires_approval rules)

**Goal:** after tools exist on the server, ensure each agent has the tool IDs attached, and has `requires_approval` tool rules set so the client executes tools through the approval flow.

**Where:** `src/agent/modify.ts`

**Key pieces to preserve:**

- `linkToolsToAgent(agentId)`
  - Lists current agent tools (`include: ["agent.tools"]`).
  - Computes which Letta Code tools are missing.
  - Resolves server tool IDs via `client.tools.list({ name: serverName })`.
  - Updates agent with `tool_ids` + adds tool rules:
    - `{ tool_name: <serverName>, type: "requires_approval", prompt_template: null }`

- (Optional but currently implemented) `unlinkToolsFromAgent(agentId)`
  - Removes Letta Code tool IDs and tool rules from an agent.

**Why:** tools can be upserted but still not usable unless the agent is actually configured to use them.

### 3) Link tools in all relevant lifecycle paths

Upstream often changes lifecycle flows; merging can drop one of the call sites.

Preserve these call sites (or equivalent behavior) so tools are linked for **every agent provenance**:

- New agent creation: `src/agent/create.ts`
  - After agent create completes: `await linkToolsToAgent(agent.id)`.

- Agent import: `src/agent/import.ts`
  - After import returns an agent ID: `await linkToolsToAgent(agentId)`.

- Headless resume / update flows: `src/headless.ts`
  - If resuming an agent and applying model/system prompt updates: re-link tools.

- Interactive CLI flows: `src/index.ts`
  - Ensure upsert happens before agent creation/resume.
  - Ensure linking happens after create/resume.
  - Ensure re-link happens after model/system prompt updates for resumed agents.

**Why:** upstream may only attach tools on create; but in this fork, resumed/imported agents must be repaired to keep tools attached.

### 4) Toolset switching must also update server-side agent tools

**Goal:** when switching toolsets (e.g. codex/default), the agent’s tools on the server must be updated, not just the local registry.

**Where:** `src/tools/toolset.ts`

**Key pieces to preserve:**

- Before switching: `await unlinkToolsFromAgent(agentId)`
- After switching + ensuring correct memory tool: `await linkToolsToAgent(agentId)`

This is implemented in:

- `forceToolsetSwitch(...)`
- `switchToolsetForModel(...)`

**Why:** otherwise tool selection changes locally but the server agent still points at the previous tool IDs.

---

## Merge conflict checklist (what to re-apply)

When merging upstream, scan these files and ensure the fork invariants still hold:

1. `src/tools/manager.ts`
   - Tool upsert still exists and uses `client.tools.upsert`.
   - Tool naming mapping still matches `TOOL_NAME_MAPPINGS` / `getServerToolName`.
   - Any new tools added upstream are included in `toolRegistry` and thus upserted.
   - Hash-based caching still stores per-server URL.

2. `src/settings-manager.ts`
   - Settings type includes `toolUpsertHashes?: Record<string, string>`.
   - Settings serialization/deserialization still preserves unknown keys.

3. `src/agent/modify.ts`
   - `linkToolsToAgent` still exists and composes:
     - current tool IDs
     - missing tool IDs resolved from `client.tools.list({ name })`
     - tool rules with `requires_approval`
   - `unlinkToolsFromAgent` still exists if toolset switching expects it.

4. `src/agent/create.ts`, `src/agent/import.ts`
   - Call `linkToolsToAgent(...)` on any newly created/imported agent.

5. `src/index.ts`, `src/headless.ts`
   - Upsert occurs early enough (before linking/creation).
   - Linking is performed on resume paths (and after any updates).

6. `src/tools/toolset.ts`
   - Unlink then relink around toolset switch.

7. `src/cli/App.tsx`, `src/cli/components/WelcomeScreen.tsx`
   - Loading state union includes an upsert phase and it renders a sensible message.

---

## Per-file merge notes (what to keep)

This section is intentionally “diff-shaped”: it’s the stuff that commonly gets dropped during conflict resolution.

### `src/tools/manager.ts`

- Keep `upsertToolsToServer()` + `upsertToolsIfNeeded()` + hashing (`computeToolsHash()`).
- Keep Python stub generation (`generatePythonStub`) and parameter sanitization (`sanitizePythonParamName`) so odd arg names (e.g. `-C`, `-A`, `-B`) don’t break stub codegen.
- Ensure server names match `getServerToolName()` / `TOOL_NAME_MAPPINGS`.

Common conflict: upstream refactors tool registry and/or removes any server-side tool registration with comments like “no more stub tool registration”. For CLIProxy, we intentionally still upsert so the backend can emit approval requests.

### `src/settings-manager.ts`

- Preserve `toolUpsertHashes?: Record<string, string>` on `Settings`.
- Ensure `SettingsManager.initialize()` merges defaults with loaded JSON so new fields aren’t dropped.

Common conflict: upstream changes settings schema or defaults and accidentally omits the new cache field.

### `src/agent/modify.ts`

- Preserve `linkToolsToAgent(agentId)`:
  - retrieves `agent.tools` via `include: ["agent.tools"]`
  - resolves missing tool IDs via `client.tools.list({ name: serverName })`
  - updates `tool_ids` and appends `tool_rules` entries of type `requires_approval`
- Preserve `unlinkToolsFromAgent(agentId)` if toolset switching needs a clean detach.

Common conflict: upstream changes agent update payload shape (`tool_ids`, `tool_rules`) or adjusts includes.

### `src/agent/create.ts`

- Preserve the post-create `linkToolsToAgent(agent.id)` call.
- Be careful not to let upstream comments about “client_tools only” convince you to remove linking; CLIProxy needs server-side registration + linkage.

Common conflict: upstream modifies base tools selection (memory tool logic). This fork’s change is *additive* (link tools after create), and should remain even if base tools logic changes.

### `src/agent/import.ts`

- Preserve `linkToolsToAgent(agentId)` immediately after import.

Common conflict: upstream changes import flow and overwrites tool behavior (`override_existing_tools`). Ensure we still attach Letta Code tools after import.

### `src/tools/toolset.ts`

- Preserve the unlink → switch tool registry → ensure memory tool → relink sequence:
  - `unlinkToolsFromAgent(agentId)` before switching
  - `linkToolsToAgent(agentId)` after switching

Common conflict: upstream adds new toolset logic but only changes local registry. For CLIProxy, server-side agent tool bindings must be updated too.

### `src/index.ts`

- Preserve early upsert (after `loadTools`, before create/resume): `await upsertToolsIfNeeded(client, baseURL)`.
- Preserve `loadingState: "upserting"` wiring.
- Preserve `linkToolsToAgent(agent.id)` after agent resolution (create/import/resume).
- Preserve re-linking after model/system prompt updates for resumed agents.

Common conflict: upstream rearranges initialization ordering. The key is: tools must be loaded → upserted → agent linked.

### `src/headless.ts`

- Preserve re-linking for resumed agents after model/system prompt updates.

Common conflict: upstream headless flow diverges from interactive; don’t lose the relink step.

### `src/cli/App.tsx` and `src/cli/components/WelcomeScreen.tsx`

- Preserve the loading state union addition (`"upserting"`).
- Ensure `WelcomeScreen` maps `"upserting"` to a message (e.g. “Registering tools...”).

Common conflict: upstream adds/removes loading phases; mismatched unions cause TS errors or a confusing “Loading...” message.

---

## Why the Python stub exists

The server expects `source_code` when upserting tools. In this fork, tools are executed client-side via approval, so the server-side implementation is never called in practice.

The stub exists purely to:

- satisfy server tool definition requirements,
- keep schemas discoverable,
- allow the model to plan tool usage using the server’s tool registry.

---

## Known upstream-sensitive areas

These parts frequently change upstream and tend to cause regressions:

- agent initialization/resume logic (ordering of: load tools → upsert → create/resume → update prompt/model)
- tool name mappings and filtering
- tool rule schema changes (e.g. renames of `requires_approval` or fields)
- settings schema changes (dropping unknown fields, renaming settings paths)

After any merge, validate by:

- creating a new agent and running a tool call
- resuming an existing agent and running a tool call
- switching toolsets and running a tool call

---

## Skills sync: `refreshAgentSkills` → `syncSkillsToAgent`

**Background:** The fork originally had `refreshAgentSkills` in `src/agent/skills.ts`. Upstream replaced this with `syncSkillsToAgent` which is a **superset** with additional features.

**Comparison:**

| Feature | `refreshAgentSkills` (Fork) | `syncSkillsToAgent` (Upstream) |
|---------|----------------------------|-------------------------------|
| Discover skills from filesystem | ✅ | ✅ |
| Format skills for memory block | ✅ | ✅ |
| Update agent's skills block via API | ✅ | ✅ |
| Handle errors gracefully | ✅ try/catch | ✅ console.warn |
| Return discovered skills | ❌ void | ✅ `{ synced, skills }` |
| Hash-based caching | ❌ | ✅ `skipIfUnchanged` option |
| Skip unnecessary API calls | ❌ | ✅ |

**Action during merge:** Accept upstream's `syncSkillsToAgent`. It properly replaces `refreshAgentSkills` with improvements:
- Hash-based caching avoids redundant API calls
- Returns sync status and skill list for caller inspection
- Uses project-local `.letta/skills-hash.json` for cache

**Call site changes:** Update any calls from:
```typescript
// Old fork pattern
await refreshAgentSkills({ client, agentId, skillsDirectory });

// New upstream pattern  
await syncSkillsToAgent(client, agentId, resolvedSkillsDirectory, { skipIfUnchanged: true });
```

---

## Model safety: CLIProxy-only model filtering

**Where:** `src/agent/available-models.ts`

**What to preserve:**
- Filter to only expose `cliproxy/` models from the API response
- Context window alias handling (supports `context_window`, `max_context_window`, `context_window_limit`, `max_context_window_limit`)

```typescript
// Fork's safety filter - KEEP THIS
const cliproxyModels = modelsList.filter((m) => m.handle?.startsWith("cliproxy/"));
```

**Why:** Prevents users from accidentally selecting non-CLIProxy models that would bypass the proxy's safety features.

---

## Memory block support checking

**Where:** `src/agent/context.ts`

**What to preserve:**
- `getMemoryBlockSupport(agent)` - checks if agent has `skills` and `loaded_skills` blocks
- Used to skip skills operations for subagents with restricted memory blocks

```typescript
export function getMemoryBlockSupport(agent: AgentWithMemory): MemoryBlockSupport {
  const blocks = agent.memory?.blocks;
  if (!Array.isArray(blocks)) {
    return { supportsSkills: false, supportsLoadedSkills: false };
  }
  const labels = new Set(blocks.map((block) => block?.label));
  return {
    supportsSkills: labels.has("skills"),
    supportsLoadedSkills: labels.has("loaded_skills"),
  };
}
```

**Call sites to preserve:**
- `src/index.ts` - before skills sync
- `src/headless.ts` - before skills sync

---

## Conversation management (upstream feature)

Upstream added conversation isolation which the fork should adopt:

**Key additions:**
- `ISOLATED_BLOCK_LABELS` - memory blocks isolated per conversation
- `specifiedConversationId`, `selectedConversationId` state variables
- `resumedExistingConversation` flag for UI messaging
- `ConversationSelector` component for `/resume` command

**What to preserve:** These are upstream features that work well with the fork. Accept them during merge.

---

## Merge checklist (January 2026 update)

After merging upstream, verify these fork-specific features still work:

### Tool management
- [ ] `upsertToolsIfNeeded` called before agent creation in `index.ts` and `headless.ts`
- [ ] `linkToolsToAgent` called after agent creation/resume
- [ ] `linkToolsToAgent` called after model/system prompt updates
- [ ] Toolset switching calls `unlinkToolsFromAgent` then `linkToolsToAgent`

### Model safety  
- [ ] `available-models.ts` filters to `cliproxy/` models only
- [ ] Model detection functions handle `cliproxy/` prefixes (`isOpenAIModelHandle`, `isGeminiModelHandle`)

### Skills
- [ ] `getMemoryBlockSupport` check before skills operations
- [ ] `syncSkillsToAgent` used (not old `refreshAgentSkills`)

### Tests
- [ ] `src/tests/agent/model-resolution.test.ts` passes
- [ ] `src/tests/approval-recovery.test.ts` passes

---

## If something changes upstream

If upstream changes the Letta API surface:

- If `client.tools.upsert` changes shape: update `upsertToolsToServer` accordingly.
- If tool rules schema changes: update `linkToolsToAgent` to emit the new rule format.
- If tool listing changes: update tool ID resolution (`client.tools.list({ name })`).

Prefer to keep the invariants rather than the exact implementation.
