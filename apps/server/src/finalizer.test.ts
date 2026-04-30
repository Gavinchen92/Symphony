import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AiAdvisor } from "./aiAdvisor";
import { SymphonyDb } from "./db";
import { EventBus } from "./events";
import { TaskFinalizer, type CommandRunner } from "./finalizer";

describe("TaskFinalizer", () => {
  it("runs checks, commits, pushes, creates PR, and marks task done", async () => {
    const fixture = createFixture();
    const calls: string[] = [];
    let staged = false;
    const runner: CommandRunner = async (_cwd, file, args) => {
      const command = [file, ...args].join(" ");
      calls.push(command);
      if (command === "pnpm run typecheck" || command === "pnpm run test" || command === "pnpm run build") {
        return ok();
      }
      if (command === "git status --porcelain") {
        return ok(" M src/app.ts\n");
      }
      if (command === "git add -A") {
        staged = true;
        return ok();
      }
      if (command === "git diff --cached --name-only") {
        return ok(staged ? "src/app.ts\n" : "");
      }
      if (command.startsWith("git commit ")) {
        return ok();
      }
      if (command === "git rev-parse HEAD") {
        return ok("0123456789abcdef\n");
      }
      if (command === `git push -u origin ${fixture.branchName}`) {
        return ok();
      }
      if (command === `gh pr list --head ${fixture.branchName} --json url --limit 1`) {
        return ok("[]");
      }
      if (command.startsWith("gh pr create ")) {
        return ok("https://github.com/example/repo/pull/1\n");
      }
      if (command === `git worktree remove ${fixture.workspacePath}`) {
        return ok();
      }
      throw new Error(`unexpected command: ${command}`);
    };
    const advisor: AiAdvisor = {
      async generateTaskTitle() {
        return null;
      },
      async selectWorkspaceStrategy() {
        return null;
      },
      async draftCompletion() {
        return {
          commitType: "feat",
          scope: "ui",
          subject: "完成自动交付流程",
          body: "自动交付 body",
          prTitle: "完成自动交付流程",
          prBody: "自动交付 PR body"
        };
      }
    };
    const finalizer = new TaskFinalizer({ db: fixture.db, advisor, commandRunner: runner });

    const task = finalizer.finalize(fixture.taskId);
    expect(task.status).toBe("finalizing");

    await waitFor(() => fixture.db.getTask(fixture.taskId).status === "done");

    const completed = fixture.db.getTask(fixture.taskId);
    expect(completed.completionCommitSha).toBe("0123456789abcdef");
    expect(completed.completionPrUrl).toBe("https://github.com/example/repo/pull/1");
    expect(completed.completionError).toBeNull();
    expect(calls).toContain("pnpm run typecheck");
    expect(calls.some((command) => command.startsWith("git commit -m feat(ui): 完成自动交付流程"))).toBe(true);
    expect(calls).toContain(`git worktree remove ${fixture.workspacePath}`);
  });

  it("blocks commit when verification fails", async () => {
    const fixture = createFixture();
    const calls: string[] = [];
    const runner: CommandRunner = async (_cwd, file, args) => {
      const command = [file, ...args].join(" ");
      calls.push(command);
      if (command === "pnpm run test") {
        throw Object.assign(new Error("test failed"), { stderr: "tests failed" });
      }
      return ok();
    };
    const finalizer = new TaskFinalizer({
      db: fixture.db,
      advisor: nullAdvisor,
      commandRunner: runner
    });

    finalizer.finalize(fixture.taskId);
    await waitFor(() => fixture.db.getTask(fixture.taskId).status === "human_review");

    const task = fixture.db.getTask(fixture.taskId);
    expect(task.completionError).toContain("校验：pnpm run test失败");
    expect(calls.some((command) => command.startsWith("git commit"))).toBe(false);
  });

  it("blocks finalization when there are no changed files", async () => {
    const fixture = createFixture({ scripts: { typecheck: "echo ok" } });
    const calls: string[] = [];
    const runner: CommandRunner = async (_cwd, file, args) => {
      const command = [file, ...args].join(" ");
      calls.push(command);
      if (command === "git status --porcelain") {
        return ok("");
      }
      return ok();
    };
    const finalizer = new TaskFinalizer({
      db: fixture.db,
      advisor: nullAdvisor,
      commandRunner: runner
    });

    finalizer.finalize(fixture.taskId);
    await waitFor(() => fixture.db.getTask(fixture.taskId).status === "human_review");

    const task = fixture.db.getTask(fixture.taskId);
    expect(task.completionError).toBe("没有可提交改动");
    expect(calls.some((command) => command.startsWith("git commit"))).toBe(false);
  });
});

const nullAdvisor: AiAdvisor = {
  async generateTaskTitle() {
    return null;
  },
  async selectWorkspaceStrategy() {
    return null;
  },
  async draftCompletion() {
    return null;
  }
};

function createFixture(input?: { scripts?: Record<string, string> }) {
  const root = mkdtempSyncCompat("symphony-finalizer-");
  const eventBus = new EventBus();
  const db = new SymphonyDb(join(root, "db.sqlite"), eventBus, root);
  const repositoryPath = join(root, "repo");
  const workspacePath = join(root, "workspace");
  mkdirSync(repositoryPath, { recursive: true });
  mkdirSync(join(workspacePath, "src"), { recursive: true });
  writeFileSync(
    join(workspacePath, "package.json"),
    JSON.stringify({
      packageManager: "pnpm@10.33.0",
      scripts: input?.scripts ?? {
        typecheck: "echo typecheck",
        test: "echo test",
        build: "echo build"
      }
    })
  );

  const repository = db.createRepository({
    name: "Repo",
    path: repositoryPath,
    baseBranch: "main",
    workspaceStrategy: "full"
  });
  const task = db.createTask({
    repositoryId: repository.id,
    title: "完成自动交付流程",
    description: "需要自动创建 PR",
    priority: 2,
    labels: [],
    scopePaths: ["apps/web"]
  });
  const run = db.createRun(task.id);
  db.updateRun(run.id, {
    status: "completed",
    workspacePath,
    branchName: "symphony/repo/sym-test",
    summary: "改动已完成",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });
  for (const status of ["queued", "preparing", "running", "human_review"] as const) {
    db.updateTaskStatus(task.id, status);
  }

  return {
    db,
    taskId: task.id,
    workspacePath,
    branchName: "symphony/repo/sym-test"
  };
}

function mkdtempSyncCompat(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ok(stdout = "") {
  return { stdout, stderr: "" };
}

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
