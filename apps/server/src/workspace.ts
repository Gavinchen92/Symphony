import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  Repository,
  ResolvedWorkspaceStrategy,
  RunEventType,
  Settings,
  Task
} from "@symphony/shared";

const execFileAsync = promisify(execFile);

export type WorkspaceEvent = (type: RunEventType, message: string, payload?: unknown) => void;

export type PreparedWorkspace = {
  path: string;
  branchName: string;
  strategy: ResolvedWorkspaceStrategy;
  sparsePatterns: string[];
};

export type WorkspacePrepareInput = {
  task: Task;
  repository: Repository;
  settings: Settings;
  strategy: ResolvedWorkspaceStrategy;
  suggestedSparsePaths?: string[];
};

export type WorkspaceProvider = {
  prepare(input: WorkspacePrepareInput, onEvent: WorkspaceEvent): Promise<PreparedWorkspace>;
};

export const defaultSparsePaths = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "AGENTS.md",
  "WORKFLOW.md",
  ".agents",
  ".github"
] as const;

export class GitWorktreeProvider implements WorkspaceProvider {
  async prepare(input: WorkspacePrepareInput, onEvent: WorkspaceEvent): Promise<PreparedWorkspace> {
    const { repository, settings, task } = input;
    const repoRoot = await gitOutput(repository.path, ["rev-parse", "--show-toplevel"]);
    const workspaceRoot = resolve(settings.workspaceRoot);
    const repoKey = sanitizeWorkspaceName(`${repository.name}-${repository.id.slice(0, 8)}`);
    const taskKey = sanitizeWorkspaceName(task.key);
    const workspacePath = join(workspaceRoot, repoKey, taskKey);
    const branchName = `symphony/${repoKey}/${taskKey}`;

    await mkdir(join(workspaceRoot, repoKey), { recursive: true });

    if (!(await isGitWorktree(workspacePath))) {
      onEvent("workspace", "正在创建 git worktree", { workspacePath, branchName });
      const branchExists = await gitSucceeds(repoRoot, ["rev-parse", "--verify", branchName]);
      const args = branchExists
        ? ["worktree", "add", workspacePath, branchName]
        : ["worktree", "add", "-b", branchName, workspacePath, repository.baseBranch];
      await git(repoRoot, args);
    } else {
      onEvent("workspace", "正在复用已有 git worktree", { workspacePath, branchName });
    }

    if (input.strategy === "full") {
      onEvent("workspace", "正在使用完整 worktree", { workspacePath });
      await disableSparseCheckout(workspacePath);
      return {
        path: workspacePath,
        branchName,
        strategy: "full",
        sparsePatterns: []
      };
    }

    const sparsePatterns = buildSparsePatterns([
      ...defaultSparsePaths,
      ...task.scopePaths,
      ...(input.suggestedSparsePaths ?? [])
    ]);
    onEvent("workspace", "正在初始化 sparse-checkout", { sparsePatterns });
    await git(workspacePath, ["sparse-checkout", "init", "--no-cone"]);
    await git(workspacePath, ["sparse-checkout", "set", "--no-cone", ...sparsePatterns]);

    return {
      path: workspacePath,
      branchName,
      strategy: "sparse-worktree",
      sparsePatterns
    };
  }
}

export function sanitizeWorkspaceName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function buildSparsePatterns(paths: readonly string[]): string[] {
  const normalized = paths
    .map(normalizeSparsePath)
    .filter((path): path is string => Boolean(path));
  return Array.from(new Set(normalized.map(toSparsePattern)));
}

export function normalizeSparsePath(input: string): string | null {
  const value = input.trim().replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!value || value === "." || value.includes("..") || value.startsWith(".git")) {
    return null;
  }
  return value;
}

export function toSparsePattern(path: string): string {
  const last = path.split("/").at(-1) ?? path;
  const looksLikeFile = last.includes(".");
  return looksLikeFile ? `/${path}` : `/${path}/**`;
}

async function isGitWorktree(path: string): Promise<boolean> {
  return gitSucceeds(path, ["rev-parse", "--is-inside-work-tree"]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  try {
    await execFileAsync("git", args, { cwd });
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${formatExecError(error)}`);
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${formatExecError(error)}`);
  }
}

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync("git", args, { cwd });
    return true;
  } catch {
    return false;
  }
}

async function disableSparseCheckout(workspacePath: string): Promise<void> {
  if (await gitSucceeds(workspacePath, ["sparse-checkout", "list"])) {
    await git(workspacePath, ["sparse-checkout", "disable"]);
  }
}

function formatExecError(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { stderr?: string; message?: string };
    return record.stderr?.trim() || record.message || String(error);
  }
  return String(error);
}

export function parentDirectory(path: string): string {
  return dirname(path);
}
