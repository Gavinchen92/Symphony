import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPathCandidates,
  describeRepositoryDirectory,
  listRepositoryPathSuggestions,
  scorePath
} from "./repositoryDiscovery";

describe("repository discovery", () => {
  it("infers repository name and current branch from a selected git folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-repo-discovery-"));
    const repo = join(root, "my-monorepo");
    const child = join(repo, "apps", "web");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(repo, "package.json"), "{}\n");
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Symphony Test"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    git(repo, ["checkout", "-b", "feature/local-runner"]);

    await expect(describeRepositoryDirectory(child)).resolves.toEqual({
      path: realpathSync(repo),
      name: "my-monorepo",
      baseBranch: "feature/local-runner"
    });
  });

  it("lists tracked files and derived directories with fuzzy matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-path-suggestions-"));
    const repo = join(root, "repo");
    mkdirSync(join(repo, "apps", "web", "src"), { recursive: true });
    mkdirSync(join(repo, "packages", "shared", "src"), { recursive: true });
    writeFileSync(join(repo, "apps", "web", "src", "App.tsx"), "export const App = null;\n");
    writeFileSync(join(repo, "packages", "shared", "src", "index.ts"), "export {};\n");
    writeFileSync(join(repo, "untracked.ts"), "export {};\n");
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Symphony Test"]);
    git(repo, ["add", "apps", "packages"]);
    git(repo, ["commit", "-m", "init"]);

    const suggestions = await listRepositoryPathSuggestions(repo, "awsa");

    expect(suggestions[0]).toEqual({
      path: "apps/web/src/App.tsx",
      kind: "file",
      matches: [0, 5, 9, 13]
    });
    await expect(listRepositoryPathSuggestions(repo, "")).resolves.toContainEqual({
      path: "apps/web/src",
      kind: "directory",
      matches: []
    });
    expect(suggestions.some((suggestion) => suggestion.path === "untracked.ts")).toBe(false);
  });

  it("builds directory candidates and scores basename matches", () => {
    expect(buildPathCandidates(["apps/web/src/App.tsx"])).toContainEqual({
      path: "apps/web",
      kind: "directory",
      matches: []
    });

    const score = scorePath("apps/web/src/App.tsx", "apptsx");
    expect(score?.matches).toEqual([13, 14, 15, 17, 18, 19]);
  });
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}
