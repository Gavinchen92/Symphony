import type { RunEventType } from "@symphony/shared";

export type RunCodexAgentInput = {
  cwd: string;
  prompt: string;
  baseInstructions: string;
  developerInstructions: string;
  signal: AbortSignal;
  onEvent: (type: RunEventType, message: string, payload?: unknown) => void;
};

export type RunCodexAgentResult = {
  threadId: string | null;
  summary: string;
};

export type AgentRunner = {
  run(input: RunCodexAgentInput): Promise<RunCodexAgentResult>;
};

