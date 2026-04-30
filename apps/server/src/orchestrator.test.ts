import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SymphonyDb } from "./db";
import { EventBus } from "./events";
import { Orchestrator } from "./orchestrator";
import type { AgentRunner } from "./runnerTypes";
import type { AutoStrategySelector } from "./autoStrategy";
import type { WorkspaceProvider } from "./workspace";

describe("Orchestrator", () => {
  it("moves completed runs into human_review", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-orchestrator-"));
    const eventBus = new EventBus();
    const db = new SymphonyDb(join(root, "db.sqlite"), eventBus, root);
    db.saveSettings({
      workspaceRoot: join(root, ".workspaces"),
      maxConcurrentAgents: 1,
      selfMonitor: { enabled: true, cooldownMinutes: 30 }
    });
    const repository = db.createRepository({
      name: "Test Repo",
      path: root,
      baseBranch: "main",
      workspaceStrategy: "sparse-worktree"
    });
    const task = db.createTask({
      repositoryId: repository.id,
      title: "Test task",
      description: "Do the thing",
      priority: 2,
      labels: [],
      scopePaths: []
    });

    const workspaceProvider: WorkspaceProvider = {
      async prepare() {
        return { path: root, branchName: "symphony/test", strategy: "sparse-worktree", sparsePatterns: [] };
      }
    };
    const autoStrategySelector: AutoStrategySelector = {
      async select() {
        return { strategy: "full", reason: "unused", suggestedSparsePaths: [] };
      }
    };
    const agentRunner: AgentRunner = {
      async run() {
        return { threadId: "thread-1", summary: "done" };
      }
    };

    const orchestrator = new Orchestrator({ db, workspaceProvider, autoStrategySelector, agentRunner });
    const run = orchestrator.dispatch(task.id);

    await waitFor(() => db.getRun(run.id).status === "completed");

    expect(db.getTask(task.id).status).toBe("human_review");
    expect(db.getRun(run.id).workspaceStrategy).toBe("sparse-worktree");
    expect(db.listRunEvents(run.id).map((event) => event.message)).toContain(
      "运行已完成，等待人工确认"
    );
  });

  it("resolves auto strategy before preparing the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-auto-orchestrator-"));
    const eventBus = new EventBus();
    const db = new SymphonyDb(join(root, "db.sqlite"), eventBus, root);
    db.saveSettings({
      workspaceRoot: join(root, ".workspaces"),
      maxConcurrentAgents: 1,
      selfMonitor: { enabled: true, cooldownMinutes: 30 }
    });
    const repository = db.createRepository({
      name: "Auto Repo",
      path: root,
      baseBranch: "main",
      workspaceStrategy: "auto"
    });
    const task = db.createTask({
      repositoryId: repository.id,
      title: "Test task",
      description: "Do the thing",
      priority: 2,
      labels: [],
      scopePaths: []
    });

    const workspaceProvider: WorkspaceProvider = {
      async prepare(input) {
        return {
          path: root,
          branchName: "symphony/test",
          strategy: input.strategy,
          sparsePatterns: input.suggestedSparsePaths ?? []
        };
      }
    };
    const autoStrategySelector: AutoStrategySelector = {
      async select(input) {
        input.onEvent("status", "auto 选择 full：小仓库", {
          strategy: "full",
          reason: "小仓库",
          suggestedSparsePaths: []
        });
        return { strategy: "full", reason: "小仓库", suggestedSparsePaths: [] };
      }
    };
    const agentRunner: AgentRunner = {
      async run() {
        return { threadId: "thread-1", summary: "done" };
      }
    };

    const orchestrator = new Orchestrator({ db, workspaceProvider, autoStrategySelector, agentRunner });
    const run = orchestrator.dispatch(task.id);

    await waitFor(() => db.getRun(run.id).status === "completed");

    expect(db.getRun(run.id).workspaceStrategy).toBe("full");
    expect(db.listRunEvents(run.id).map((event) => event.message)).toContain("auto 选择 full：小仓库");
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout");
}
