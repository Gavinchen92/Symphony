import type { Repository, ResolvedWorkspaceStrategy, Run, RunEventType, Settings, Task } from "@symphony/shared";
import type { AutoStrategySelector } from "./autoStrategy";
import type { SymphonyDb } from "./db";
import type { AgentRunner } from "./runnerTypes";
import type { SystemMonitor } from "./systemMonitor";
import type { PreparedWorkspace, WorkspaceProvider } from "./workspace";

type OrchestratorDeps = {
  db: SymphonyDb;
  workspaceProvider: WorkspaceProvider;
  autoStrategySelector: AutoStrategySelector;
  agentRunner: AgentRunner;
  systemMonitor?: Pick<SystemMonitor, "report">;
};

type ActiveRun = {
  runId: string;
  abortController: AbortController;
};

export class Orchestrator {
  private queue: string[] = [];
  private activeRuns = new Map<string, ActiveRun>();

  constructor(private readonly deps: OrchestratorDeps) {}

  dispatch(taskId: string): Run {
    const existingRun = this.deps.db.findActiveRunForTask(taskId);
    if (existingRun) {
      return existingRun;
    }

    const task = this.deps.db.updateTaskStatus(taskId, "queued");
    const run = this.deps.db.createRun(task.id);
    this.deps.db.addRunEvent(run.id, "status", "运行已进入队列");
    this.queue.push(run.id);
    this.pump();
    return run;
  }

  cancelTask(taskId: string): Run | null {
    const run = this.deps.db.findActiveRunForTask(taskId);
    if (!run) {
      const task = this.deps.db.getTask(taskId);
      this.deps.db.updateTaskStatus(task.id, "cancelled");
      return null;
    }

    this.queue = this.queue.filter((runId) => runId !== run.id);
    const activeRun = this.activeRuns.get(run.id);
    activeRun?.abortController.abort();
    this.deps.db.updateRun(run.id, {
      status: "cancelled",
      completedAt: new Date().toISOString(),
      error: "用户已取消"
    });
    this.deps.db.updateTaskStatus(taskId, "cancelled");
    this.deps.db.addRunEvent(run.id, "status", "运行已取消");
    return this.deps.db.getRun(run.id);
  }

  private pump(): void {
    const settings = this.deps.db.getSettings();
    while (this.activeRuns.size < settings.maxConcurrentAgents && this.queue.length > 0) {
      const runId = this.queue.shift();
      if (!runId) {
        return;
      }
      const abortController = new AbortController();
      this.activeRuns.set(runId, { runId, abortController });
      void this.executeRun(runId, abortController, settings).finally(() => {
        this.activeRuns.delete(runId);
        this.pump();
      });
    }
  }

  private async executeRun(
    runId: string,
    abortController: AbortController,
    settings: Settings
  ): Promise<void> {
    const run = this.deps.db.getRun(runId);
    const task = this.deps.db.getTask(run.taskId);
    const repository = task.repositoryId ? this.deps.db.getRepository(task.repositoryId) : null;
    let phase: "preparing" | "workspace" | "codex" = "preparing";

    try {
      if (!repository) {
        throw new Error("任务未绑定仓库，无法派发");
      }
      this.deps.db.updateTaskStatus(task.id, "preparing");
      this.deps.db.updateRun(runId, {
        status: "preparing",
        startedAt: new Date().toISOString()
      });
      this.event(runId, "status", "正在准备工作区");

      const strategySelection = await this.resolveWorkspaceStrategy(runId, task, repository);
      this.deps.db.updateRun(runId, {
        workspaceStrategy: strategySelection.strategy
      });
      phase = "workspace";
      const workspace = await this.deps.workspaceProvider.prepare(
        {
          task,
          repository,
          settings,
          strategy: strategySelection.strategy,
          suggestedSparsePaths: strategySelection.suggestedSparsePaths
        },
        (type, message, payload) => {
          this.event(runId, type, message, payload);
        }
      );

      this.deps.db.updateTaskStatus(task.id, "running");
      this.deps.db.updateRun(runId, {
        status: "running",
        workspacePath: workspace.path,
        branchName: workspace.branchName,
        workspaceStrategy: workspace.strategy
      });
      this.event(runId, "status", "Codex 运行已开始", workspace);

      phase = "codex";
      const result = await this.deps.agentRunner.run({
        cwd: workspace.path,
        prompt: buildPrompt(task, repository, workspace),
        baseInstructions: "你是 Gavin 的本地 coding agent。默认用简体中文回复，先基于真实代码和日志判断，再做最小必要修改。",
        developerInstructions: buildDeveloperInstructions(workspace),
        signal: abortController.signal,
        onEvent: (type, message, payload) => this.event(runId, type, message, payload)
      });

      this.deps.db.updateRun(runId, {
        status: "completed",
        threadId: result.threadId,
        summary: result.summary,
        completedAt: new Date().toISOString()
      });
      this.deps.db.updateTaskStatus(task.id, "human_review");
      this.event(runId, "status", "运行已完成，等待人工确认");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const wasCancelled = abortController.signal.aborted;
      if (!wasCancelled && phase !== "codex") {
        this.deps.systemMonitor?.report({
          source: "orchestrator",
          error,
          context: {
            phase,
            runId,
            taskId: task.id,
            repositoryId: task.repositoryId
          }
        });
      }
      this.deps.db.updateRun(runId, {
        status: wasCancelled ? "cancelled" : "failed",
        error: message,
        completedAt: new Date().toISOString()
      });
      this.deps.db.updateTaskStatus(task.id, wasCancelled ? "cancelled" : "failed");
      this.event(runId, wasCancelled ? "status" : "error", message);
    }
  }

  private async resolveWorkspaceStrategy(
    runId: string,
    task: Task,
    repository: Repository
  ): Promise<{ strategy: ResolvedWorkspaceStrategy; suggestedSparsePaths: string[] }> {
    if (repository.workspaceStrategy !== "auto") {
      this.event(runId, "status", `使用仓库策略：${repository.workspaceStrategy}`);
      return {
        strategy: repository.workspaceStrategy,
        suggestedSparsePaths: []
      };
    }

    const selection = await this.deps.autoStrategySelector.select({
      task,
      repository,
      onEvent: (type, message, payload) => this.event(runId, type, message, payload)
    });
    return {
      strategy: selection.strategy,
      suggestedSparsePaths: selection.suggestedSparsePaths
    };
  }

  private event(runId: string, type: RunEventType, message: string, payload: unknown = null): void {
    this.deps.db.addRunEvent(runId, type, message, payload);
  }
}

function buildPrompt(task: Task, repository: Repository, workspace: PreparedWorkspace): string {
  const scope = task.scopePaths.length > 0 ? task.scopePaths.join(", ") : "未指定，先自行判断需要读取的路径";
  return [
    `请处理本地 Symphony 任务 ${task.key}。`,
    "",
    `标题：${task.title}`,
    "",
    "描述：",
    task.description || "(无描述)",
    "",
    `优先级：${task.priority}`,
    `标签：${task.labels.join(", ") || "(无)"}`,
    `初始 sparse 范围：${scope}`,
    `目标仓库：${repository.name}`,
    `仓库路径：${repository.path}`,
    `本次 workspace 策略：${workspace.strategy}`,
    `工作区：${workspace.path}`,
    `分支：${workspace.branchName}`,
    "",
    "执行要求：",
    "- 直接在当前 workspace 完成任务，不要创建提交或推送，除非任务明确要求。",
    "- 完成后用简短中文总结改动、验证命令和残余风险。"
  ].join("\n");
}

function buildDeveloperInstructions(workspace: PreparedWorkspace): string {
  if (workspace.strategy === "sparse-worktree") {
    return "当前 workspace 使用 git sparse-checkout。如果你发现缺少 import、测试路径或上下文，先运行 `git sparse-checkout add <path>` 扩大范围，再继续执行。";
  }
  return "当前 workspace 是完整 git worktree，不使用 sparse-checkout。";
}
