import { describe, expect, it } from "vitest";
import {
  CreateRepositoryInputSchema,
  CreateTaskInputSchema,
  RepositoryPathSuggestionSchema,
  UpdateRepositoryInputSchema,
  WorkspaceStrategySchema,
  assertTaskTransition,
  canTransitionTask,
  parseListText
} from "./index";

describe("task status transitions", () => {
  it("allows the expected happy path", () => {
    expect(canTransitionTask("todo", "queued")).toBe(true);
    expect(canTransitionTask("queued", "preparing")).toBe(true);
    expect(canTransitionTask("preparing", "running")).toBe(true);
    expect(canTransitionTask("running", "human_review")).toBe(true);
    expect(canTransitionTask("human_review", "done")).toBe(true);
  });

  it("rejects impossible jumps", () => {
    expect(canTransitionTask("todo", "done")).toBe(false);
    expect(() => assertTaskTransition("done", "running")).toThrow(
      "invalid task status transition"
    );
  });
});

describe("parseListText", () => {
  it("normalizes comma and newline separated values", () => {
    expect(parseListText("apps/web, packages/ui\n docs")).toEqual([
      "apps/web",
      "packages/ui",
      "docs"
    ]);
  });
});

describe("repository and workspace schemas", () => {
  it("requires repositoryId when creating a task", () => {
    expect(() => CreateTaskInputSchema.parse({ title: "Missing repo" })).toThrow();
  });

  it("accepts all workspace strategies", () => {
    expect(WorkspaceStrategySchema.options).toEqual(["auto", "sparse-worktree", "full"]);
  });

  it("does not apply create defaults during partial repository updates", () => {
    expect(CreateRepositoryInputSchema.parse({ name: "Repo", path: "/tmp/repo" }).workspaceStrategy).toBe("auto");
    expect(UpdateRepositoryInputSchema.parse({ name: "Repo 2" })).toEqual({ name: "Repo 2" });
  });

  it("validates repository path suggestions", () => {
    expect(
      RepositoryPathSuggestionSchema.parse({
        path: "apps/web/src/App.tsx",
        kind: "file",
        matches: [0, 5, 13]
      })
    ).toEqual({
      path: "apps/web/src/App.tsx",
      kind: "file",
      matches: [0, 5, 13]
    });
  });
});
