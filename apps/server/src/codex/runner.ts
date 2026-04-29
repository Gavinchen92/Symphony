import type { RunCodexAgentInput, RunCodexAgentResult } from "../runnerTypes";
import { CodexAppServerClient } from "./appServerClient";

type ThreadStartResponse = {
  thread: { id: string };
};

type TurnStartResponse = {
  turn: { id: string; status: string };
};

type TurnCompletedNotification = {
  threadId: string;
  turn: { status: "completed" | "failed" | "interrupted"; error?: { message?: string } | null };
};

export class CodexAppServerRunner {
  async run(input: RunCodexAgentInput): Promise<RunCodexAgentResult> {
    const client = new CodexAppServerClient();
    const transcript: string[] = [];
    let threadId: string | null = null;

    const unsubscribe = client.onNotification((notification) => {
      input.onEvent("codex", notification.method, notification.params ?? null);

      if (notification.method === "item/agentMessage/delta") {
        const text = extractText(notification.params);
        if (text) {
          transcript.push(text);
        }
      }
    });

    const abortHandler = () => {
      void client.stop();
    };
    input.signal.addEventListener("abort", abortHandler, { once: true });

    try {
      await client.start();
      input.onEvent("codex", "Codex app-server 已初始化", null);

      const thread = await client.request<ThreadStartResponse>("thread/start", {
        cwd: input.cwd,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        baseInstructions: input.baseInstructions,
        developerInstructions: input.developerInstructions,
        ephemeral: false,
        experimentalRawEvents: false,
        persistExtendedHistory: true
      });
      threadId = thread.thread.id;
      input.onEvent("codex", `Codex 会话已启动：${threadId}`, thread);

      await client.request<TurnStartResponse>("turn/start", {
        threadId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }]
      });

      const result = await waitForTurnCompletion(client, threadId, input.signal);
      if (result.turn.status === "failed") {
        throw new Error(result.turn.error?.message ?? "Codex 回合失败");
      }
      if (result.turn.status === "interrupted") {
        throw new Error("Codex 回合已中断");
      }

      return {
        threadId,
        summary: transcript.join("").trim() || "Codex 运行已完成。"
      };
    } finally {
      input.signal.removeEventListener("abort", abortHandler);
      unsubscribe();
      await client.stop();
    }
  }
}

function waitForTurnCompletion(
  client: CodexAppServerClient,
  threadId: string,
  signal: AbortSignal
): Promise<TurnCompletedNotification> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Codex 运行已取消"));
      return;
    }

    const onAbort = () => {
      cleanup();
      reject(new Error("Codex 运行已取消"));
    };

    const unsubscribe = client.onNotification((notification) => {
      if (notification.method !== "turn/completed") {
        return;
      }
      const params = notification.params as TurnCompletedNotification;
      if (params.threadId !== threadId) {
        return;
      }
      cleanup();
      resolve(params);
    });

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function extractText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["delta", "text", "message"]) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}
