import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiAdvisor, OpenAiCompatibleAdvisor } from "./aiAdvisor";
import type { LlmRuntimeConfig } from "./config";
import type { Repository, Task } from "@symphony/shared";

const enabledConfig: LlmRuntimeConfig = {
  provider: "openai-compatible",
  apiKey: "test-key",
  model: "test-model",
  baseUrl: "https://llm.example.test/v1",
  enabled: true
};

describe("AiAdvisor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays disabled when key or model is missing", async () => {
    const advisor = createAiAdvisor({
      ...enabledConfig,
      apiKey: null,
      enabled: false
    });

    await expect(advisor.generateTaskTitle({ task: taskFixture(), repository: repositoryFixture() })).resolves.toBeNull();
    await expect(advisor.selectWorkspaceStrategy({ task: taskFixture(), repository: repositoryFixture() })).resolves.toBeNull();
  });

  it("parses and normalizes generated task titles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: "《修复交付流程异常。》"
                  })
                }
              }
            ]
          }),
          { status: 200 }
        )
      )
    );

    const advisor = new OpenAiCompatibleAdvisor(enabledConfig);
    await expect(advisor.generateTaskTitle({ task: taskFixture(), repository: repositoryFixture() })).resolves.toBe("修复交付流程异常");
  });

  it("parses structured workspace strategy advice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    strategy: "sparse-worktree",
                    reason: "范围明确",
                    suggestedSparsePaths: ["apps/web"]
                  })
                }
              }
            ]
          }),
          { status: 200 }
        )
      )
    );

    const advisor = new OpenAiCompatibleAdvisor(enabledConfig);
    await expect(advisor.selectWorkspaceStrategy({ task: taskFixture(), repository: repositoryFixture() })).resolves.toEqual({
      strategy: "sparse-worktree",
      reason: "范围明确",
      suggestedSparsePaths: ["apps/web"]
    });
  });

  it("falls back to null on malformed model output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"strategy":"unsafe"}' } }]
          }),
          { status: 200 }
        )
      )
    );

    const advisor = new OpenAiCompatibleAdvisor(enabledConfig);
    await expect(advisor.selectWorkspaceStrategy({ task: taskFixture(), repository: repositoryFixture() })).resolves.toBeNull();
  });
});

function taskFixture(): Task {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    key: "SYM-TEST",
    repositoryId: "00000000-0000-4000-8000-000000000002",
    title: "修复交付流程",
    description: "需要自动创建 PR",
    priority: 2,
    labels: [],
    scopePaths: ["apps/web"],
    status: "todo",
    completedAt: null,
    completionCommitSha: null,
    completionPrUrl: null,
    completionError: null,
    completionCleanupError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function repositoryFixture(): Repository {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    name: "Repo",
    path: "/tmp/repo",
    baseBranch: "main",
    workspaceStrategy: "auto",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}
