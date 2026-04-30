import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Repository, Run, Task } from "@symphony/shared";
import type { AiAdvisor, CompletionDraft } from "./aiAdvisor";
import type { SymphonyDb } from "./db";

const execFileAsync = promisify(execFile);

type FinalizerDeps = {
  db: SymphonyDb;
  advisor: AiAdvisor;
  commandRunner?: CommandRunner;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export type CommandRunner = (
  cwd: string,
  file: string,
  args: readonly string[]
) => Promise<CommandResult>;

type VerificationCommand = {
  file: string;
  args: string[];
  label: string;
};

type PackageJson = {
  scripts?: Record<string, string>;
  packageManager?: string;
};

const verificationScriptOrder = ["typecheck", "test", "build"] as const;
const conventionalTypes = ["feat", "fix", "docs", "style", "refactor", "test", "chore"] as const;

export class TaskFinalizer {
  private readonly activeTaskIds = new Set<string>();
  private readonly runCommand: CommandRunner;

  constructor(private readonly deps: FinalizerDeps) {
    this.runCommand = deps.commandRunner ?? defaultCommandRunner;
  }

  finalize(taskId: string): Task {
    const detail = this.deps.db.getTaskDetail(taskId);
    const task = detail.task;
    const latestRun = detail.runs[0];

    if (this.activeTaskIds.has(taskId)) {
      return task;
    }
    if (task.status !== "human_review") {
      throw new Error(`只有待人工确认的任务可以交付：${task.status}`);
    }
    if (!detail.repository) {
      throw new Error("任务未绑定仓库，无法交付");
    }
    if (!latestRun || latestRun.status !== "completed") {
      throw new Error("最新运行未完成，无法交付");
    }
    if (!latestRun.workspacePath || !latestRun.branchName) {
      throw new Error("最新运行缺少 worktree 或分支信息，无法交付");
    }

    this.deps.db.updateTaskCompletion(task.id, {
      completedAt: null,
      completionCommitSha: null,
      completionPrUrl: null,
      completionError: null,
      completionCleanupError: null
    });
    const finalizingTask = this.deps.db.updateTaskStatus(task.id, "finalizing");
    this.event(latestRun.id, "开始自动交付收尾");

    this.activeTaskIds.add(task.id);
    void this.execute({
      task: finalizingTask,
      repository: detail.repository,
      run: latestRun,
      workspacePath: latestRun.workspacePath,
      branchName: latestRun.branchName
    }).finally(() => {
      this.activeTaskIds.delete(task.id);
    });

    return finalizingTask;
  }

  private async execute(input: {
    task: Task;
    repository: Repository;
    run: Run;
    workspacePath: string;
    branchName: string;
  }): Promise<void> {
    try {
      const verificationCommands = await inferVerificationCommands(input.workspacePath);
      await this.runVerificationCommands(input.run.id, input.workspacePath, verificationCommands);

      const changedFiles = await this.listChangedFiles(input.workspacePath);
      if (changedFiles.length === 0) {
        throw new Error("没有可提交改动");
      }
      this.event(input.run.id, `检测到 ${changedFiles.length} 个变更文件`, { changedFiles });

      const draft =
        (await this.deps.advisor.draftCompletion({
          task: input.task,
          repository: input.repository,
          run: input.run,
          changedFiles,
          verificationCommands: verificationCommands.map((command) => command.label)
        })) ?? buildFallbackDraft(input.task, input.repository, input.run, changedFiles, verificationCommands);

      const commitHeader = buildCommitHeader(draft);
      this.event(input.run.id, `准备提交：${commitHeader}`);
      await this.requiredCommand(input.run.id, input.workspacePath, "git", ["add", "-A"], "暂存变更");

      const stagedFiles = await this.listStagedFiles(input.workspacePath);
      if (stagedFiles.length === 0) {
        throw new Error("没有已暂存改动");
      }

      await this.requiredCommand(
        input.run.id,
        input.workspacePath,
        "git",
        ["commit", "-m", commitHeader, "-m", normalizeBody(draft.body)],
        "创建提交"
      );
      const commitSha = await this.gitOutput(input.workspacePath, ["rev-parse", "HEAD"]);
      this.event(input.run.id, `提交已创建：${commitSha.slice(0, 12)}`, { commitSha });

      await this.requiredCommand(
        input.run.id,
        input.workspacePath,
        "git",
        ["push", "-u", "origin", input.branchName],
        "推送任务分支"
      );

      const prUrl = await this.createOrReusePullRequest(input, draft);
      const cleanupError = await this.cleanupWorktree(input);
      this.deps.db.updateTaskCompletion(input.task.id, {
        completedAt: new Date().toISOString(),
        completionCommitSha: commitSha,
        completionPrUrl: prUrl,
        completionError: null,
        completionCleanupError: cleanupError
      });
      this.deps.db.updateTaskStatus(input.task.id, "done");
      this.event(input.run.id, "自动交付完成", { commitSha, prUrl, cleanupError });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.db.updateTaskCompletion(input.task.id, {
        completionError: message
      });
      this.deps.db.updateTaskStatus(input.task.id, "human_review");
      this.deps.db.addRunEvent(input.run.id, "error", `自动交付失败：${message}`);
    }
  }

  private async runVerificationCommands(
    runId: string,
    workspacePath: string,
    commands: VerificationCommand[]
  ): Promise<void> {
    if (commands.length === 0) {
      this.event(runId, "未检测到 typecheck/test/build 脚本，跳过自动校验");
      return;
    }

    for (const command of commands) {
      await this.requiredCommand(runId, workspacePath, command.file, command.args, `校验：${command.label}`);
    }
  }

  private async listChangedFiles(workspacePath: string): Promise<string[]> {
    const result = await this.runCommand(workspacePath, "git", ["status", "--porcelain"]);
    return parsePorcelainFiles(result.stdout);
  }

  private async listStagedFiles(workspacePath: string): Promise<string[]> {
    const result = await this.runCommand(workspacePath, "git", ["diff", "--cached", "--name-only"]);
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private async gitOutput(workspacePath: string, args: readonly string[]): Promise<string> {
    const result = await this.runCommand(workspacePath, "git", args);
    return result.stdout.trim();
  }

  private async createOrReusePullRequest(
    input: {
      run: Run;
      repository: Repository;
      workspacePath: string;
      branchName: string;
    },
    draft: CompletionDraft
  ): Promise<string> {
    const existing = await this.findExistingPullRequest(input.workspacePath, input.branchName);
    if (existing) {
      this.event(input.run.id, `复用已有 PR：${existing}`, { prUrl: existing });
      return existing;
    }

    const result = await this.requiredCommand(
      input.run.id,
      input.workspacePath,
      "gh",
      [
        "pr",
        "create",
        "--base",
        input.repository.baseBranch,
        "--head",
        input.branchName,
        "--title",
        limitText(draft.prTitle, 96),
        "--body",
        normalizeBody(draft.prBody)
      ],
      "创建 GitHub PR"
    );
    const prUrl = extractFirstUrl(result.stdout) ?? result.stdout.trim();
    if (!prUrl) {
      throw new Error("gh pr create 未返回 PR URL");
    }
    this.event(input.run.id, `PR 已创建：${prUrl}`, { prUrl });
    return prUrl;
  }

  private async findExistingPullRequest(workspacePath: string, branchName: string): Promise<string | null> {
    try {
      const result = await this.runCommand(workspacePath, "gh", [
        "pr",
        "list",
        "--head",
        branchName,
        "--json",
        "url",
        "--limit",
        "1"
      ]);
      const parsed = z.array(z.object({ url: z.string().url() })).safeParse(JSON.parse(result.stdout || "[]"));
      return parsed.success ? parsed.data[0]?.url ?? null : null;
    } catch {
      return null;
    }
  }

  private async cleanupWorktree(input: {
    run: Run;
    repository: Repository;
    workspacePath: string;
  }): Promise<string | null> {
    try {
      await this.requiredCommand(
        input.run.id,
        input.repository.path,
        "git",
        ["worktree", "remove", input.workspacePath],
        "清理任务 worktree"
      );
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.event(input.run.id, `工作区清理失败：${message}`, { workspacePath: input.workspacePath });
      return message;
    }
  }

  private async requiredCommand(
    runId: string,
    cwd: string,
    file: string,
    args: readonly string[],
    label: string
  ): Promise<CommandResult> {
    this.event(runId, `${label}：${formatCommand(file, args)}`, { cwd, file, args });
    try {
      const result = await this.runCommand(cwd, file, args);
      this.event(runId, `${label}完成`, {
        stdout: truncateOutput(result.stdout),
        stderr: truncateOutput(result.stderr)
      });
      return result;
    } catch (error) {
      throw new Error(`${label}失败：${formatCommandError(error)}`);
    }
  }

  private event(runId: string, message: string, payload: unknown = null): void {
    this.deps.db.addRunEvent(runId, "status", message, payload);
  }
}

async function inferVerificationCommands(workspacePath: string): Promise<VerificationCommand[]> {
  const packageJson = await readPackageJson(workspacePath);
  const scripts = packageJson?.scripts ?? {};
  const packageManager = await inferPackageManager(workspacePath, packageJson);
  return verificationScriptOrder
    .filter((scriptName) => typeof scripts[scriptName] === "string")
    .map((scriptName) => ({
      file: packageManager,
      args: packageManager === "npm" ? ["run", scriptName] : ["run", scriptName],
      label: `${packageManager} run ${scriptName}`
    }));
}

async function readPackageJson(workspacePath: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await readFile(`${workspacePath}/package.json`, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

async function inferPackageManager(
  workspacePath: string,
  packageJson: PackageJson | null
): Promise<"pnpm" | "yarn" | "npm" | "bun"> {
  const packageManager = packageJson?.packageManager?.split("@")[0];
  if (packageManager === "pnpm" || packageManager === "yarn" || packageManager === "npm" || packageManager === "bun") {
    return packageManager;
  }
  if (await pathExists(`${workspacePath}/pnpm-lock.yaml`)) {
    return "pnpm";
  }
  if (await pathExists(`${workspacePath}/yarn.lock`)) {
    return "yarn";
  }
  if (await pathExists(`${workspacePath}/bun.lockb`) || (await pathExists(`${workspacePath}/bun.lock`))) {
    return "bun";
  }
  return "npm";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function buildFallbackDraft(
  task: Task,
  repository: Repository,
  run: Run,
  changedFiles: string[],
  verificationCommands: VerificationCommand[]
): CompletionDraft {
  const scope = inferCommitScope(task, repository);
  const verificationText =
    verificationCommands.length > 0
      ? verificationCommands.map((command) => `- ${command.label}`).join("\n")
      : "- 未配置自动校验脚本";
  const changedFileText = changedFiles.map((file) => `- ${file}`).join("\n");
  const summary = run.summary ?? "Codex 运行已完成。";
  return {
    commitType: inferCommitType(task),
    scope,
    subject: task.title,
    body: [
      `任务：${task.key}`,
      "",
      "运行摘要：",
      summary,
      "",
      "验证：",
      verificationText,
      "",
      "变更文件：",
      changedFileText
    ].join("\n"),
    prTitle: task.title,
    prBody: [
      "## 摘要",
      summary,
      "",
      "## 验证",
      verificationText,
      "",
      "## 变更文件",
      changedFileText,
      "",
      `任务：${task.key}`
    ].join("\n")
  };
}

function inferCommitType(task: Task): (typeof conventionalTypes)[number] {
  const text = `${task.title} ${task.description} ${task.labels.join(" ")}`.toLowerCase();
  if (text.includes("test") || text.includes("测试")) {
    return "test";
  }
  if (text.includes("doc") || text.includes("文档")) {
    return "docs";
  }
  if (text.includes("refactor") || text.includes("重构")) {
    return "refactor";
  }
  if (text.includes("feat") || text.includes("新增") || text.includes("功能")) {
    return "feat";
  }
  return "fix";
}

function inferCommitScope(task: Task, repository: Repository): string | null {
  const raw = task.scopePaths[0]?.split("/")[0] ?? repository.name;
  const scope = sanitizeCommitScope(raw);
  return scope || null;
}

function buildCommitHeader(draft: CompletionDraft): string {
  const type = conventionalTypes.includes(draft.commitType) ? draft.commitType : "fix";
  const scope = draft.scope ? sanitizeCommitScope(draft.scope) : null;
  const prefix = scope ? `${type}(${scope}): ` : `${type}: `;
  const maxSubjectLength = Math.max(8, 50 - Array.from(prefix).length);
  return `${prefix}${limitText(draft.subject, maxSubjectLength)}`;
}

function sanitizeCommitScope(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

function limitText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= maxLength) {
    return normalized;
  }
  return characters.slice(0, Math.max(1, maxLength - 3)).join("") + "...";
}

function normalizeBody(value: string): string {
  return value.trim() || "无补充说明。";
}

function parsePorcelainFiles(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const path = line.slice(3);
      return path.includes(" -> ") ? path.split(" -> ").at(-1) ?? path : path;
    });
}

function extractFirstUrl(output: string): string | null {
  return output.match(/https?:\/\/\S+/)?.[0] ?? null;
}

function formatCommand(file: string, args: readonly string[]): string {
  return [file, ...args].join(" ");
}

function truncateOutput(value: string): string {
  if (value.length <= 8000) {
    return value;
  }
  return `${value.slice(0, 8000)}\n...输出已截断`;
}

function formatCommandError(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { stdout?: string; stderr?: string; message?: string };
    const stderr = record.stderr ? truncateOutput(record.stderr.trim()) : "";
    const stdout = record.stdout ? truncateOutput(record.stdout.trim()) : "";
    return stderr || stdout || record.message || String(error);
  }
  return String(error);
}

async function defaultCommandRunner(
  cwd: string,
  file: string,
  args: readonly string[]
): Promise<CommandResult> {
  const { stdout, stderr } = await execFileAsync(file, [...args], {
    cwd,
    maxBuffer: 20 * 1024 * 1024
  });
  return { stdout, stderr };
}
