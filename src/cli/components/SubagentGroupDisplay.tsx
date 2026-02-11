/**
 * SubagentGroupDisplay - Live/interactive subagent status display
 *
 * Used in the ACTIVE render area for subagents that may still be running.
 */

import { Box, useInput } from "ink";
import Link from "ink-link";
import { memo, useSyncExternalStore } from "react";
import { useAnimation } from "../contexts/AnimationContext.js";
import { formatStats, getTreeChars } from "../helpers/subagentDisplay.js";
import {
  getSnapshot,
  type SubagentState,
  subscribe,
  toggleExpanded,
} from "../helpers/subagentState.js";
import { useTerminalWidth } from "../hooks/useTerminalWidth.js";
import { BlinkDot } from "./BlinkDot.js";
import { colors } from "./colors.js";
import { Text } from "./Text";

const isTmux = Boolean(process.env.TMUX);

function formatToolArgs(argsStr: string): string {
  try {
    const args = JSON.parse(argsStr);
    const entries = Object.entries(args)
      .filter(([_, value]) => value !== undefined && value !== null)
      .slice(0, 2);

    if (entries.length === 0) return "";

    return entries
      .map(([key, value]) => {
        let displayValue = String(value);
        if (displayValue.length > 50) {
          displayValue = `${displayValue.slice(0, 47)}...`;
        }
        return `${key}: "${displayValue}"`;
      })
      .join(", ");
  } catch {
    return "";
  }
}

function formatAgentIds(agent: SubagentState): string {
  const ids = [
    agent.taskId,
    agent.agentId,
    agent.conversationId,
  ].filter(Boolean) as string[];
  return ids.join(" · ");
}

interface AgentRowProps {
  agent: SubagentState;
  isLast: boolean;
  expanded: boolean;
  condensed?: boolean;
}

const AgentRow = memo(
  ({ agent, isLast, expanded, condensed = false }: AgentRowProps) => {
    const { treeChar, continueChar } = getTreeChars(isLast);
    const columns = useTerminalWidth();
    const gutterWidth = 8;
    const contentWidth = Math.max(0, columns - gutterWidth);

    const isRunning = agent.status === "pending" || agent.status === "running";
    const shouldDim = isRunning && !agent.isBackground;
    const stats = formatStats(
      agent.toolCalls.length,
      agent.totalTokens,
      isRunning,
    );
    const ids = formatAgentIds(agent);
    const modelLabel = agent.model ? `Model: ${agent.model}` : "";
    const subagentLabel = `Subagent: ${agent.type.toLowerCase()}`;
    const lastTool = agent.toolCalls[agent.toolCalls.length - 1];

    if (condensed) {
      const isComplete =
        agent.status === "completed" || agent.status === "error";
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Text>
              <Text color={colors.subagent.treeChar}>
                {"   "}
                {treeChar}{" "}
              </Text>
              <Text bold={!shouldDim} dimColor={shouldDim}>
                {agent.description}
              </Text>
              <Text dimColor>
                {agent.taskId ? ` · ${agent.taskId}` : ""}
              </Text>
            </Text>
          </Box>

          <Box flexDirection="row">
            <Text color={colors.subagent.treeChar}>
              {"   "}
              {continueChar} ⎿{" "}
            </Text>
            <Text dimColor>{subagentLabel}</Text>
          </Box>

          {modelLabel && (
            <Box flexDirection="row">
              <Text color={colors.subagent.treeChar}>
                {"   "}
                {continueChar} ⎿{" "}
              </Text>
              <Text dimColor>{modelLabel}</Text>
            </Box>
          )}

          {agent.agentURL && (
            <Box flexDirection="row">
              <Text color={colors.subagent.treeChar}>
                {"   "}
                {continueChar} ⎿{" "}
              </Text>
              {!isTmux ? (
                <Link url={agent.agentURL}>
                  <Text dimColor>Agent ↗</Text>
                </Link>
              ) : (
                <Text dimColor>{agent.agentURL}</Text>
              )}
            </Box>
          )}

          {ids && (
            <Box flexDirection="row">
              <Text color={colors.subagent.treeChar}>
                {"   "}
                {continueChar} ⎿{" "}
              </Text>
              <Text dimColor>{"IDs: "}</Text>
              <Text dimColor>{ids}</Text>
            </Box>
          )}

          <Box flexDirection="row">
            <Text color={colors.subagent.treeChar}>
              {"   "}
              {continueChar}
            </Text>
            <Text dimColor>{"   "}</Text>
            {agent.status === "error" ? (
              <Text color={colors.subagent.error}>Error</Text>
            ) : isComplete ? (
              <Text dimColor>Done</Text>
            ) : agent.isBackground ? (
              <Text dimColor>Running in the background</Text>
            ) : (
              <Text dimColor>Running...</Text>
            )}
          </Box>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text>
            <Text color={colors.subagent.treeChar}>
              {"   "}
              {treeChar}{" "}
            </Text>
            <Text bold={!shouldDim} dimColor={shouldDim}>
              {agent.description}
            </Text>
            <Text dimColor>
              {" · "}
              {stats}
            </Text>
          </Text>
        </Box>

        <Box flexDirection="row">
          <Text color={colors.subagent.treeChar}>
            {"   "}
            {continueChar} ⎿{" "}
          </Text>
          <Text dimColor>{subagentLabel}</Text>
        </Box>

        {modelLabel && (
          <Box flexDirection="row">
            <Text color={colors.subagent.treeChar}>
              {"   "}
              {continueChar} ⎿{" "}
            </Text>
            <Text dimColor>{modelLabel}</Text>
          </Box>
        )}

        {agent.agentURL && (
          <Box flexDirection="row">
            <Text color={colors.subagent.treeChar}>
              {"   "}
              {continueChar} ⎿{" "}
            </Text>
            {!isTmux ? (
              <Link url={agent.agentURL}>
                <Text dimColor>Agent ↗</Text>
              </Link>
            ) : (
              <Text dimColor>{agent.agentURL}</Text>
            )}
          </Box>
        )}

        {ids && (
          <Box flexDirection="row">
            <Text color={colors.subagent.treeChar}>
              {"   "}
              {continueChar} ⎿{" "}
            </Text>
            <Text dimColor>{"IDs: "}</Text>
            <Text dimColor>{ids}</Text>
          </Box>
        )}

        {expanded &&
          agent.toolCalls.map((tc) => {
            const formattedArgs = formatToolArgs(tc.args);
            return (
              <Box key={tc.id} flexDirection="row">
                <Text color={colors.subagent.treeChar}>
                  {"   "}
                  {continueChar}
                </Text>
                <Text dimColor>
                  {"     "}
                  {tc.name}({formattedArgs})
                </Text>
              </Box>
            );
          })}

        <Box flexDirection="row">
          {agent.status === "completed" ? (
            <>
              <Text color={colors.subagent.treeChar}>
                {"   "}
                {continueChar}
              </Text>
              <Text dimColor>{"   Done"}</Text>
            </>
          ) : agent.status === "error" ? (
            <>
              <Box width={gutterWidth} flexShrink={0}>
                <Text>
                  <Text color={colors.subagent.treeChar}>
                    {"   "}
                    {continueChar}
                  </Text>
                  <Text dimColor>{"   "}</Text>
                </Text>
              </Box>
              <Box flexGrow={1} width={contentWidth}>
                <Text wrap="wrap" color={colors.subagent.error}>
                  {agent.error}
                </Text>
              </Box>
            </>
          ) : agent.isBackground ? (
            <>
              <Text color={colors.subagent.treeChar}>
                {"   "}
                {continueChar}
              </Text>
              <Text dimColor>{"   Running in the background"}</Text>
            </>
          ) : lastTool ? (
            <>
              <Text color={colors.subagent.treeChar}>
                {"   "}
                {continueChar}
              </Text>
              <Text dimColor>
                {"   "}
                {lastTool.name}
              </Text>
            </>
          ) : (
            <>
              <Text color={colors.subagent.treeChar}>
                {"   "}
                {continueChar}
              </Text>
              <Text dimColor>{"   Starting..."}</Text>
            </>
          )}
        </Box>
      </Box>
    );
  },
);
AgentRow.displayName = "AgentRow";

interface GroupHeaderProps {
  count: number;
  allCompleted: boolean;
  hasErrors: boolean;
  expanded: boolean;
}

const GroupHeader = memo(
  ({ count, allCompleted, hasErrors, expanded }: GroupHeaderProps) => {
    const hint = expanded ? "(ctrl+o to collapse)" : "(ctrl+o to expand)";
    const dotColor = hasErrors
      ? colors.subagent.error
      : colors.subagent.completed;
    const runningDotColor = hasErrors
      ? colors.subagent.error
      : colors.tool.pending;
    const label = allCompleted ? "Ran" : "Running";
    const suffix = count !== 1 ? "agents" : "agent";

    return (
      <Box flexDirection="row">
        {allCompleted ? (
          <Text color={dotColor}>●</Text>
        ) : (
          <BlinkDot color={runningDotColor} />
        )}
        <Text>
          {" "}
          {label} <Text bold>{count}</Text> {suffix}
        </Text>
        <Text color={colors.subagent.hint}> {hint}</Text>
      </Box>
    );
  },
);
GroupHeader.displayName = "GroupHeader";

export const SubagentGroupDisplay = memo(() => {
  const { agents, expanded } = useSyncExternalStore(subscribe, getSnapshot);
  const { shouldAnimate } = useAnimation();

  useInput((input, key) => {
    if (key.ctrl && input === "o") {
      toggleExpanded();
    }
  });

  if (agents.length === 0) {
    return null;
  }

  const condensed = !shouldAnimate;
  const allCompleted = agents.every(
    (a) => a.status === "completed" || a.status === "error",
  );
  const hasErrors = agents.some((a) => a.status === "error");

  return (
    <Box flexDirection="column" marginTop={1}>
      <GroupHeader
        count={agents.length}
        allCompleted={allCompleted}
        hasErrors={hasErrors}
        expanded={expanded}
      />
      {agents.map((agent, index) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          isLast={index === agents.length - 1}
          expanded={expanded}
          condensed={condensed}
        />
      ))}
    </Box>
  );
});

SubagentGroupDisplay.displayName = "SubagentGroupDisplay";
