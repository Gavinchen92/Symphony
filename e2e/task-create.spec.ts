import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("新建任务不需要填写标题", async ({ page, request }) => {
  const repositoryResponse = await request.post("/api/repositories", {
    data: {
      name: "E2E Repo",
      path: mkdtempSync(join(tmpdir(), "symphony-e2e-repo-")),
      baseBranch: "main",
      workspaceStrategy: "full"
    }
  });
  expect(repositoryResponse.ok()).toBe(true);
  const repository = (await repositoryResponse.json()) as {
    id: string;
    name: string;
    path: string;
    baseBranch: string;
    workspaceStrategy: string;
    createdAt: string;
    updatedAt: string;
  };

  let createTaskPayload: unknown = null;
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    createTaskPayload = route.request().postDataJSON();
    const now = new Date().toISOString();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: "00000000-0000-4000-8000-000000000101",
        key: "SYM-E2E",
        repositoryId: repository.id,
        title: "修复登录页加载状态",
        description: "修复登录页 loading 状态，并补齐验收测试",
        priority: 2,
        labels: [],
        scopePaths: [],
        status: "todo",
        completedAt: null,
        completionCommitSha: null,
        completionPrUrl: null,
        completionError: null,
        completionCleanupError: null,
        createdAt: now,
        updatedAt: now,
        repository,
        latestRun: null
      })
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "新建任务" }).click();

  await expect(page.getByText("标题 *")).toHaveCount(0);
  await expect(page.getByText("只填写任务内容，创建后由 AI 自动生成标题。")).toBeVisible();

  await page.getByLabel("任务内容 *").fill("修复登录页 loading 状态，并补齐验收测试");
  const createButton = page.getByRole("button", { name: "创建任务" });
  await expect(createButton).toBeEnabled();
  await createButton.click();

  await expect.poll(() => createTaskPayload).not.toBeNull();
  expect(createTaskPayload).toEqual({
    repositoryId: repository.id,
    description: "修复登录页 loading 状态，并补齐验收测试",
    priority: 2,
    labels: [],
    scopePaths: []
  });
});
