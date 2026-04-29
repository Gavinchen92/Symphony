import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildSparsePatterns,
  GitWorktreeProvider,
  normalizeSparsePath,
  sanitizeWorkspaceName
} from "./workspace";
import type { Repository, Settings, Task } from "@symphony/shared";

describe("workspace helpers", () => {
  it("sanitizes task keys for worktree paths", () => {
    expect(sanitizeWorkspaceName("SYM 123 / Fix UI")).toBe("sym-123-fix-ui");
  });

  it("normalizes sparse paths and drops unsafe values", () => {
    expect(normalizeSparsePath("/apps/web/")).toBe("apps/web");
    expect(normalizeSparsePath("../secret")).toBeNull();
    expect(buildSparsePatterns(["apps/web", "package.json", "apps/web"])).toEqual([
      "/apps/web/**",
      "/package.json"
    ]);
  });
});

describe("SparseWorktreeProvider", () => {
  it("creates a worktree with sparse-checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-worktree-"));
    const repo = join(root, "repo");
    const workspaceRoot = join(root, "workspaces");
    mkdirSync(join(repo, "apps/web"), { recursive: true });
    mkdirSync(join(repo, "packages/ui"), { recursive: true });
    writeFileSync(join(repo, "package.json"), "{}\n");
    writeFileSync(join(repo, "apps/web/index.ts"), "export const app = true;\n");
    writeFileSync(join(repo, "packages/ui/index.ts"), "export const ui = true;\n");
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Symphony Test"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);

    const task: Task = {
      id: crypto.randomUUID(),
      key: "SYM-TEST",
      repositoryId: "00000000-0000-4000-8000-000000000001",
      title: "Test",
      description: "",
      priority: 2,
      labels: [],
      scopePaths: ["apps/web"],
      status: "todo",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const settings: Settings = {
      workspaceRoot,
      maxConcurrentAgents: 1
    };
    const repository: Repository = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Test Repo",
      path: repo,
      baseBranch: "main",
      workspaceStrategy: "sparse-worktree",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const provider = new GitWorktreeProvider();
    const prepared = await provider.prepare(
      { task, repository, settings, strategy: "sparse-worktree" },
      () => {}
    );

    expect(prepared.branchName).toBe("symphony/test-repo-00000000/sym-test");
    expect(prepared.strategy).toBe("sparse-worktree");
    expect(prepared.sparsePatterns).toContain("/apps/web/**");
    expect(execFileSync("git", ["-C", prepared.path, "rev-parse", "--is-inside-work-tree"]).toString().trim()).toBe("true");
  });

  it("creates a full worktree without sparse-checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-full-worktree-"));
    const repo = join(root, "repo");
    const workspaceRoot = join(root, "workspaces");
    mkdirSync(join(repo, "apps/web"), { recursive: true });
    writeFileSync(join(repo, "package.json"), "{}\n");
    writeFileSync(join(repo, "apps/web/index.ts"), "export const app = true;\n");
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Symphony Test"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);

    const task: Task = {
      id: crypto.randomUUID(),
      key: "SYM-FULL",
      repositoryId: "00000000-0000-4000-8000-000000000002",
      title: "Test",
      description: "",
      priority: 2,
      labels: [],
      scopePaths: ["apps/web"],
      status: "todo",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const settings: Settings = {
      workspaceRoot,
      maxConcurrentAgents: 1
    };
    const repository: Repository = {
      id: "00000000-0000-4000-8000-000000000002",
      name: "Full Repo",
      path: repo,
      baseBranch: "main",
      workspaceStrategy: "full",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const provider = new GitWorktreeProvider();
    const prepared = await provider.prepare({ task, repository, settings, strategy: "full" }, () => {});

    expect(prepared.strategy).toBe("full");
    expect(prepared.sparsePatterns).toEqual([]);
    expect(gitOptionalOutput(prepared.path, ["sparse-checkout", "list"])).toBe("");
  });
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function gitOptionalOutput(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  } catch {
    return "";
  }
}
