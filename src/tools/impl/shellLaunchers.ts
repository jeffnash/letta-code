const SEP = "\u0000";

function pushUnique(
  list: string[][],
  seen: Set<string>,
  entry: string[],
): void {
  if (!entry.length || !entry[0]) return;
  const key = entry.join(SEP);
  if (seen.has(key)) return;
  seen.add(key);
  list.push(entry);
}

function windowsLaunchers(command: unknown): string[][] {
  const trimmed = normalizeShellScript(command);
  if (!trimmed) return [];
  const launchers: string[][] = [];
  const seen = new Set<string>();
  const powerShellCommand =
    trimmed.startsWith("&") ||
    trimmed.startsWith('"') ||
    trimmed.startsWith("'")
      ? trimmed.startsWith("&")
        ? trimmed
        : `& ${trimmed}`
      : trimmed;

  // Default to PowerShell on Windows (same as Gemini CLI and Codex CLI)
  // This ensures better PATH compatibility since many tools are configured
  // in PowerShell profiles rather than system-wide cmd.exe PATH
  pushUnique(launchers, seen, [
    "powershell.exe",
    "-NoProfile",
    "-Command",
    powerShellCommand,
  ]);
  pushUnique(launchers, seen, [
    "pwsh",
    "-NoProfile",
    "-Command",
    powerShellCommand,
  ]);

  // Fall back to cmd.exe if PowerShell fails
  const envComSpecRaw = process.env.ComSpec || process.env.COMSPEC;
  const envComSpec = envComSpecRaw?.trim();
  if (envComSpec) {
    pushUnique(launchers, seen, [envComSpec, "/d", "/s", "/c", trimmed]);
  }
  pushUnique(launchers, seen, ["cmd.exe", "/d", "/s", "/c", trimmed]);

  return launchers;
}

function unixLaunchers(command: unknown): string[][] {
  const trimmed = normalizeShellScript(command);
  if (!trimmed) return [];
  const launchers: string[][] = [];
  const seen = new Set<string>();

  // On macOS, ALWAYS prefer zsh first due to bash 3.2's HEREDOC parsing bug
  // with odd numbers of apostrophes. This takes precedence over $SHELL.
  if (process.platform === "darwin") {
    pushUnique(launchers, seen, ["/bin/zsh", "-c", trimmed]);
  }

  // Try user's preferred shell from $SHELL environment variable
  // Use -c (non-login) to avoid profile sourcing that can hang on CI
  const envShell = process.env.SHELL?.trim();
  if (envShell) {
    pushUnique(launchers, seen, [envShell, "-c", trimmed]);
  }

  // Fallback defaults - prefer simple "bash" PATH lookup first (like original code)
  // then absolute paths. Use -c (non-login shell) to avoid profile sourcing.
  const defaults: string[][] =
    process.platform === "darwin"
      ? [
          ["/bin/zsh", "-c", trimmed],
          ["bash", "-c", trimmed], // PATH lookup, like original
          ["/bin/bash", "-c", trimmed],
          ["/usr/bin/bash", "-c", trimmed],
          ["/bin/sh", "-c", trimmed],
          ["/bin/ash", "-c", trimmed],
          ["/usr/bin/env", "zsh", "-c", trimmed],
          ["/usr/bin/env", "bash", "-c", trimmed],
          ["/usr/bin/env", "sh", "-c", trimmed],
          ["/usr/bin/env", "ash", "-c", trimmed],
        ]
      : [
          ["/bin/bash", "-c", trimmed],
          ["/usr/bin/bash", "-c", trimmed],
          ["/bin/zsh", "-c", trimmed],
          ["/bin/sh", "-c", trimmed],
          ["/bin/ash", "-c", trimmed],
          ["/usr/bin/env", "bash", "-c", trimmed],
          ["/usr/bin/env", "zsh", "-c", trimmed],
          ["/usr/bin/env", "sh", "-c", trimmed],
          ["/usr/bin/env", "ash", "-c", trimmed],
        ];
  for (const entry of defaults) {
    pushUnique(launchers, seen, entry);
  }
  return launchers;
}

export function buildShellLaunchers(command: unknown): string[][] {
  return process.platform === "win32"
    ? windowsLaunchers(command)
    : unixLaunchers(command);
}

function normalizeShellScript(command: unknown): string {
  // Some call sites (or tool plumbing) may accidentally pass an argv-style
  // array like ["bash", "-lc", "echo hi"]. Be defensive to avoid crashing
  // the UI on a .trim() call.
  if (Array.isArray(command)) {
    const idx = command.findIndex((t) => t === "-c" || t === "-lc");
    const script = idx >= 0 ? command[idx + 1] : undefined;
    if (typeof script === "string") return script.trim();
    return command.join(" ").trim();
  }
  if (typeof command === "string") return command.trim();
  return "";
}
