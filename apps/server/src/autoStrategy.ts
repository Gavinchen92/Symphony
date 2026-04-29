import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Repository, ResolvedWorkspaceStrategy, RunEventType, Task } from "@symphony/shared";
import { CodexAppServerClient, type AppServerNotification } from "./codex/appServerClient";

const AutoStrategySelectionSchema = z.object({
  strategy: z.enum(["sparse-worktree", "full"]),
  reason: z.string().min(1),
  suggestedSparsePaths: z.array(z.string()).default([])
});

export type AutoStrategySelection = z.infer<typeof AutoStrategySelectionSchema>;

export type AutoStrategySelectorInput = {
  task: Task;
  repository: Repository;
  onEvent: (type: RunEventType, message: string, payload?: unknown) => void;
};

export type AutoStrategySelector = {
  select(input: AutoStrategySelectorInput): Promise<AutoStrategySelection>;
};

type ThreadStartResponse = {
  thread: { id: string };
};

type TurnCompletedNotification = {
  threadId: string;
  turn: { status: "completed" | "failed" | "interrupted"; error?: { message?: string } | null };
};

export class CodexAutoStrategySelector implements AutoStrategySelector {
  async select(input: AutoStrategySelectorInput): Promise<AutoStrategySelection> {
    const client = new CodexAppServerClient();
    const transcript: string[] = [];
    const repoSummary = await summarizeRepositoryRoot(input.repository.path);

    const unsubscribe = client.onNotification((notification) => {
      input.onEvent("codex", `auto 策略预判事件：${notification.method}`, notification.params ?? null);
      const text = extractText(notification);
      if (text) {
        transcript.push(text);
      }
    });

    try {
      await client.start();
      input.onEvent("status", "正在进行 auto 策略预判");

      const thread = await client.request<ThreadStartResponse>("thread/start", {
        cwd: input.repository.path,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "read-only",
        baseInstructions: "你是一个只读分析 agent。只判断 workspace 策略，不修改文件。",
        developerInstructions:
          "必须只返回 JSON，不要输出 Markdown。strategy 只能是 sparse-worktree 或 full。",
        ephemeral: true,
        experimentalRawEvents: false,
        persistExtendedHistory: false
      });

      await client.request("turn/start", {
        threadId: thread.thread.id,
        input: [{ type: "text", text: buildAutoPrompt(input, repoSummary), text_elements: [] }],
        outputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            strategy: { enum: ["sparse-worktree", "full"] },
            reason: { type: "string" },
            suggestedSparsePaths: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["strategy", "reason", "suggestedSparsePaths"]
        }
      });

      const completed = await waitForTurnCompletion(client, thread.thread.id);
      if (completed.turn.status !== "completed") {
        throw new Error(completed.turn.error?.message ?? `Codex auto 预判未完成：${completed.turn.status}`);
      }

      const selection = AutoStrategySelectionSchema.parse(parseJson(transcript.join("")));
      input.onEvent("status", `auto 选择 ${selection.strategy}：${selection.reason}`, selection);
      return selection;
    } catch (error) {
      throw new Error(`auto 策略预判失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      unsubscribe();
      await client.stop();
    }
  }
}

async function summarizeRepositoryRoot(path: string): Promise<string> {
  const entries = await readdir(path);
  const rows = await Promise.all(
    entries
      .filter((entry) => !entry.startsWith(".git"))
      .slice(0, 80)
      .map(async (entry) => {
        const entryStat = await stat(join(path, entry));
        return `${entryStat.isDirectory() ? "dir " : "file"} ${entry}`;
      })
  );
  return rows.join("\n");
}

function buildAutoPrompt(
  { task, repository }: AutoStrategySelectorInput,
  repoSummary: string
): string {
  const scope = task.scopePaths.length > 0 ? task.scopePaths.join(", ") : "未指定";
  return [
    "请为这个本地 coding agent 任务选择 workspace 策略。",
    "",
    `仓库名称：${repository.name}`,
    `仓库路径：${repository.path}`,
    `基准分支：${repository.baseBranch}`,
    "",
    `任务标题：${task.title}`,
    "任务描述：",
    task.description || "(无描述)",
    "",
    `用户提供的 scopePaths：${scope}`,
    "",
    "仓库根目录摘要：",
    repoSummary || "(空)",
    "",
    "选择规则：",
    "- 如果仓库明显是大型 monorepo，且任务范围能由描述或 scopePaths 判断，选择 sparse-worktree。",
    "- 如果仓库较小、任务明显跨全仓，或无法可靠判断需要哪些路径，选择 full。",
    "- 如果选择 sparse-worktree，suggestedSparsePaths 填入你建议额外检出的路径；否则填空数组。",
    "",
    "只返回 JSON。"
  ].join("\n");
}

function waitForTurnCompletion(
  client: CodexAppServerClient,
  threadId: string
): Promise<TurnCompletedNotification> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Codex auto 预判超时"));
    }, 120_000);

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
      clearTimeout(timer);
      unsubscribe();
    };
  });
}

function extractText(notification: AppServerNotification): string | null {
  if (notification.method !== "item/agentMessage/delta") {
    return null;
  }
  const payload = notification.params;
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

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("Codex 未返回 JSON");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}
