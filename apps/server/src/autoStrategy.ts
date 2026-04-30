import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Repository, RunEventType, Task } from "@symphony/shared";
import type { AiAdvisor } from "./aiAdvisor";

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

export class AiAutoStrategySelector implements AutoStrategySelector {
  constructor(private readonly advisor: AiAdvisor) {}

  async select(input: AutoStrategySelectorInput): Promise<AutoStrategySelection> {
    input.onEvent("status", "正在进行 auto 策略预判");

    try {
      const advice = await this.advisor.selectWorkspaceStrategy({
        task: input.task,
        repository: input.repository
      });
      const parsedAdvice = AutoStrategySelectionSchema.safeParse(advice);
      if (parsedAdvice.success) {
        input.onEvent(
          "status",
          `auto 选择 ${parsedAdvice.data.strategy}：${parsedAdvice.data.reason}`,
          parsedAdvice.data
        );
        return parsedAdvice.data;
      }
    } catch {
      // advisor 只是轻量建议源，失败不阻塞任务派发。
    }

    const fallback = await selectFallbackStrategy(input);
    input.onEvent("status", `auto fallback 选择 ${fallback.strategy}：${fallback.reason}`, fallback);
    return fallback;
  }
}

async function selectFallbackStrategy({
  task,
  repository
}: AutoStrategySelectorInput): Promise<AutoStrategySelection> {
  if (task.scopePaths.length > 0) {
    return {
      strategy: "sparse-worktree",
      reason: "任务已显式指定 scopePaths",
      suggestedSparsePaths: []
    };
  }

  const repoSummary = await summarizeRepositoryRoot(repository.path);
  if (repoSummary.entries <= 30 && !repoSummary.hasMonorepoMarkers) {
    return {
      strategy: "full",
      reason: "仓库根目录较小，使用完整 worktree 更稳妥",
      suggestedSparsePaths: []
    };
  }

  return {
    strategy: "full",
    reason: "未配置 AI advisor 或策略建议不可用，无法可靠判断范围，使用完整 worktree",
    suggestedSparsePaths: []
  };
}

async function summarizeRepositoryRoot(path: string): Promise<{
  entries: number;
  hasMonorepoMarkers: boolean;
}> {
  const entries = await readdir(path);
  const visibleEntries = entries.filter((entry) => !entry.startsWith(".git"));
  const rows = await Promise.all(
    visibleEntries.slice(0, 80).map(async (entry) => {
      const entryStat = await stat(join(path, entry));
      return {
        name: entry,
        isDirectory: entryStat.isDirectory()
      };
    })
  );
  const hasMonorepoMarkers = rows.some((entry) =>
    ["apps", "packages", "pnpm-workspace.yaml", "turbo.json", "rush.json", "nx.json"].includes(
      entry.name
    )
  );
  return { entries: visibleEntries.length, hasMonorepoMarkers };
}
