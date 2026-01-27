# Fork Upstream Merge Guide

This guide documents specific conflict resolution strategies from merging upstream `letta-ai/letta-code` into our fork.

## Quick Reference Commands

```bash
# Fetch and merge upstream
git fetch upstream
git merge upstream/main

# List unmerged files
git diff --name-only --diff-filter=U

# Find conflict markers in all files
for f in $(git diff --name-only --diff-filter=U); do
  echo "=== $f ===" && grep -n "^<<<<<<< " "$f" 2>/dev/null || echo "0 conflicts"
done

# Check for stray markers after resolving
grep -rn "^<<<<<<< \|^=======\|^>>>>>>> " src/

# Regenerate package-lock (never manually merge it)
rm package-lock.json && npm install --legacy-peer-deps
```

---

## Specific Conflict Resolutions

### 1. AgentSelector.tsx - Keyboard Handling + Delete Feature

**Conflict**: HEAD had `determineKeyboardAction` abstraction, upstream added delete agent (D key) handling.

**Resolution**: Add D key handling BEFORE the keyboard abstraction fallback:

```typescript
} else if (input === "d" || input === "D") {
  // Delete agent - from upstream
  let selectedAgent: AgentState | null = null;
  let selectedAgentId: string | null = null;
  // ... delete handling logic from upstream
} else {
  // Keyboard abstraction fallback - from HEAD
  const action = determineKeyboardAction(input, { ctrl: key.ctrl, meta: key.meta }, {
    activeTab,
    isSearchMode,
  });
  switch (action.type) {
    // ... existing keyboard action handling
  }
}
```

**Also update `getFooterHints`** to include delete hint:
```typescript
const deleteHint = " · D delete";
return `Enter select · ↑↓ navigate · ←→ page · Tab switch${searchHint}${deleteHint}${newHint} · Esc ${escHint}`;
```

---

### 2. ModelSelector.tsx - BYOK Tabs + CLIProxy Safety Filter

**Conflict**: Upstream added BYOK tabs, billing tier logic, self-hosted server support. HEAD had CLIProxy safety filter (`showNonCliProxyModels`).

**Resolution**: Keep BOTH - upstream's tab system AND HEAD's filtering:

**Type definition** - take upstream's expanded categories:
```typescript
type ModelCategory =
  | "supported"
  | "byok"
  | "byok-all"
  | "all"
  | "server-recommended"
  | "server-all";
```

**Category function** - use upstream's billing/self-hosted logic:
```typescript
function getModelCategories(billingTier?: string, isSelfHosted?: boolean): ModelCategory[] {
  if (isSelfHosted) {
    return ["server-recommended", "server-all"];
  }
  const isFreeTier = billingTier?.toLowerCase() === "free";
  return isFreeTier
    ? ["byok", "byok-all", "supported", "all"]
    : ["supported", "all", "byok", "byok-all"];
}
```

**State initialization** - use upstream's `modelCategories` memo:
```typescript
const modelCategories = useMemo(
  () => getModelCategories(billingTier, isSelfHosted),
  [billingTier, isSelfHosted],
);
const defaultCategory = modelCategories[0] ?? "supported";
const [category, setCategory] = useState<ModelCategory>(defaultCategory);

// ALSO keep HEAD's CLIProxy filter state
const [showNonCliProxyModels, setShowNonCliProxyModels] = useState<boolean>(
  settingsManager.getSettingSafe("showNonCliProxyModels") ?? false,
);
```

**Model filtering** - keep HEAD's CLIProxy filter in useMemo:
```typescript
const supportedModels = useMemo(() => {
  // ... upstream's logic
  
  // HEAD's CLIProxy filter - KEEP THIS
  if (!showNonCliProxyModels) {
    baseModels = typedModels.filter((m) => m.handle.startsWith("cliproxy/"));
  }
  
  // ... rest of logic
}, [typedModels, availableHandles, filterProvider, searchQuery, isFreeTier, showNonCliProxyModels]);
//                                                                          ^^^^^^^^^^^^^^^^^^^^
//                                                        Include BOTH upstream and HEAD dependencies
```

**Category cycling** - use `modelCategories` (not old `getModelCategories(showNonCliProxyModels)`):
```typescript
const cycleCategory = useCallback(() => {
  setCategory((current) => {
    const idx = modelCategories.indexOf(current);
    return modelCategories[(idx + 1) % modelCategories.length] as ModelCategory;
  });
  setSelectedIndex(0);
  setSearchQuery("");
}, [modelCategories]);
```

---

### 3. executor.ts - Multi-Launcher System

**Conflict**: HEAD had simple `getShellCommand` function, upstream refactored to `trySpawnWithLauncher` with multiple launcher fallback.

**Resolution**: Take upstream's more robust architecture entirely. The multi-launcher approach tries bash, zsh, sh with fallback.

```typescript
// Take upstream's trySpawnWithLauncher function
function trySpawnWithLauncher(
  launcher: string[],
  workingDirectory: string,
  input: HookInput,
): ChildProcess {
  const [executable, ...args] = launcher;
  if (!executable) {
    throw new Error("Empty launcher");
  }
  return spawn(executable, args, {
    cwd: workingDirectory,
    env: { ...process.env, LETTA_HOOK_EVENT: input.event_type, LETTA_WORKING_DIR: workingDirectory },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// In executeWithLauncher, just call trySpawnWithLauncher
try {
  child = trySpawnWithLauncher(launcher, workingDirectory, input);
} catch (error) {
  reject(error);
  return;
}
// ... rest of process management code follows (shared, not duplicated)
```

---

### 4. index.ts - Model Resolution (Async vs Sync)

**Conflict**: HEAD used `resolveModelAsync`, upstream used sync `resolveModel`.

**Resolution**: Keep `resolveModelAsync` - the dynamic server lookup is important for CLIProxy passthrough models.

```typescript
if (model) {
  const { resolveModelAsync, getModelUpdateArgs } = await import("./agent/model");
  const modelHandle = await resolveModelAsync(model);  // Keep async version
  if (!modelHandle) {
    console.error(`Error: Invalid model "${model}"`);
    process.exit(1);
  }
  // ...
}
```

**Also**: Port the self-hosted passthrough improvement from `resolveModel` to `resolveModelAsync`:
```typescript
// In resolveModelAsync, after the server lookup try/catch:
} catch (_error) {
  // If server check fails, fall through to passthrough check below
}

// Add this passthrough (was only in resolveModel before)
if (modelIdentifier.includes("/")) {
  return modelIdentifier;
}

return null;
```

---

### 5. index.ts - Help Text Examples

**Conflict**: HEAD had `--new-agent`, upstream had `--new`.

**Resolution**: Keep BOTH examples in help text:
```
EXAMPLES
  letta                    # Show profile selector or create new
  letta --new-agent        # Create new agent directly
  letta --new              # Create new conversation
  letta --agent agent_123  # Open specific agent
```

---

### 6. settings-manager.test.ts - Multiple Test Suites

**Conflict**: HEAD added "Default Model Settings Tests", upstream added "Agents Array Migration Tests".

**Resolution**: Keep BOTH test suites - they test different features:

```typescript
// ============================================================================
// Default Model Settings Tests (from HEAD)
// ============================================================================
describe("Settings Manager - Default Model", () => {
  test("Default model is null by default", () => { /* ... */ });
  test("Can set default model", () => { /* ... */ });
  test("Can clear default model by setting to null", () => { /* ... */ });
  test("Default model persists to disk", async () => { /* ... */ });
  test("Default model is independent of other settings", () => { /* ... */ });
});

// ============================================================================
// Agents Array Migration Tests (from upstream)
// ============================================================================
describe("Settings Manager - Agents Array Migration", () => {
  test("Migrates from pinnedAgents (oldest legacy format)", async () => { /* ... */ });
  test("Migrates from pinnedAgentsByServer (newer legacy format)", async () => { /* ... */ });
  // ... more tests
});
```

---

### 7. toolset.ts - Tool Switching Approach

**Conflict**: HEAD had explicit `unlinkToolsFromAgent()` and `clearTools()` calls before switching. Upstream removed them, relying on lock-based `clearToolsWithLock()`.

**Resolution**: Take upstream's cleaner lock-based approach:

```typescript
export async function forceToolsetSwitch(
  toolsetName: ToolsetName,
  agentId: string,
): Promise<void> {
  // DON'T include HEAD's explicit unlink/clear:
  // await unlinkToolsFromAgent(agentId);  // REMOVED
  // clearTools();                          // REMOVED

  // Load the appropriate toolset
  // Note: loadTools/loadSpecificTools acquire a switch lock that causes
  // sendMessageStream to wait, preventing messages from being sent with
  // stale or partial tools during the switch.
  if (toolsetName === "none") {
    clearToolsWithLock();  // Upstream's atomic approach
    return;
  }
  // ... rest of loading logic
}
```

---

### 8. InlineGenericApproval.tsx - Line Width

**Conflict**: HEAD used `columns - 2`, upstream used `columns`.

**Resolution**: Keep HEAD's `columns - 2` for proper border alignment:
```typescript
const solidLine = SOLID_LINE.repeat(Math.max(columns - 2, 10));
```

---

## Security Fix Added During Merge

Added `validateBlockLabel` in `memoryFilesystem.ts` to prevent path traversal:

```typescript
export function validateBlockLabel(label: string, targetDir: string): string {
  // Reject absolute paths
  if (label.startsWith("/") || label.startsWith("\\") || /^[a-zA-Z]:/.test(label)) {
    throw new Error(`Invalid block label: absolute paths are not allowed: "${label}"`);
  }

  // Reject labels containing ".." segments
  if (label.includes("..")) {
    throw new Error(`Invalid block label: parent directory traversal (..) is not allowed: "${label}"`);
  }

  // Normalize and verify path stays within target directory
  const normalizedLabel = normalize(label).replace(/\\/g, "/");
  const fullPath = resolve(targetDir, `${normalizedLabel}.md`);
  const resolvedTargetDir = resolve(targetDir);

  if (!fullPath.startsWith(resolvedTargetDir + "/") && fullPath !== resolvedTargetDir) {
    throw new Error(`Invalid block label: path escapes target directory: "${label}"`);
  }

  return normalizedLabel;
}
```

**Valid labels** (these work): `persona`, `persona/soul`, `test/block`, `my-notes`, `2024-01-27`

**Blocked labels** (these throw): `../etc/passwd`, `/etc/passwd`, `..`, `foo/../bar`, `C:\Windows`

---

## Post-Merge Validation: App.tsx

**CRITICAL**: After resolving merge conflicts, validate App.tsx for missing refs and constants. Build may pass but runtime will fail!

### Compare useRef declarations
```bash
# Extract upstream App.tsx
git show upstream/main:src/cli/App.tsx > /tmp/upstream_app.tsx

# Compare useRef declarations
diff <(grep "= useRef" /tmp/upstream_app.tsx | sort) <(grep "= useRef" src/cli/App.tsx | sort)
```

### Key refs to verify exist:
- `sessionStartTimeRef` - tracks session duration
- `sessionHooksRanRef` - prevents duplicate hook runs  
- `conversationBusyRetriesRef` - 409 error retry counter
- `toolResultsInFlightRef` - prevents interrupt during result processing

### Key constants to verify exist:
```typescript
const CONVERSATION_BUSY_MAX_RETRIES = 1;
const CONVERSATION_BUSY_RETRY_DELAY_MS = 2500;
```

### Function signatures to check:
```typescript
// Upstream has parameters, HEAD might not
function sendDesktopNotification(
  message = "Awaiting your input",
  level: "info" | "warning" | "error" = "info",
)
```

### Check for refs used but not defined:
```bash
# Find refs that are used but not declared
grep -o "[a-zA-Z]*Ref\.current" src/cli/App.tsx | sort -u | while read ref; do
  name=$(echo $ref | sed 's/\.current//')
  if ! grep -q "const $name = useRef" src/cli/App.tsx; then
    echo "MISSING: $name"
  fi
done
```

---

## Post-Merge Checklist

- [ ] `grep -rn "^<<<<<<< " src/` returns nothing
- [ ] `npm run build` succeeds  
- [ ] `npm test` passes (especially `memoryFilesystem.test.ts`)
- [ ] **Run the app** - check for runtime errors about undefined refs
- [ ] Model selector shows BYOK tabs AND respects CLIProxy filter
- [ ] Delete agent (D key) works in agent selector
- [ ] `resolveModelAsync` works with dynamic server models
