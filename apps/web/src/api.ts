import {
  CreateRepositoryInputSchema,
  CreateTaskInputSchema,
  RepositoryDirectorySelectionSchema,
  RepositoryPathSuggestionListSchema,
  RepositorySchema,
  RunSchema,
  SettingsSchema,
  TaskDetailSchema,
  TaskWithLatestRunSchema,
  UpdateRepositoryInputSchema,
  type CreateRepositoryInput,
  type CreateTaskInput,
  type Repository,
  type RepositoryDirectorySelection,
  type RepositoryPathSuggestion,
  type Run,
  type RunEvent,
  type Settings,
  type TaskDetail,
  type TaskWithLatestRun,
  type UpdateRepositoryInput,
  type UpdateTaskInput
} from "@symphony/shared";
import { z } from "zod";

const TaskListSchema = z.array(TaskWithLatestRunSchema);
const RepositoryListSchema = z.array(RepositorySchema);

export async function fetchTasks(): Promise<TaskWithLatestRun[]> {
  return TaskListSchema.parse(await request("/api/tasks"));
}

export async function fetchTaskDetail(id: string): Promise<TaskDetail> {
  return TaskDetailSchema.parse(await request(`/api/tasks/${id}`));
}

export async function createTask(input: CreateTaskInput): Promise<TaskWithLatestRun> {
  return TaskWithLatestRunSchema.parse(
    await request("/api/tasks", {
      method: "POST",
      body: CreateTaskInputSchema.parse(input)
    })
  );
}

export async function fetchRepositories(): Promise<Repository[]> {
  return RepositoryListSchema.parse(await request("/api/repositories"));
}

export async function createRepository(input: CreateRepositoryInput): Promise<Repository> {
  return RepositorySchema.parse(
    await request("/api/repositories", {
      method: "POST",
      body: CreateRepositoryInputSchema.parse(input)
    })
  );
}

export async function selectRepositoryDirectory(): Promise<RepositoryDirectorySelection> {
  return RepositoryDirectorySelectionSchema.parse(
    await request("/api/system/select-repository-directory", { method: "POST" })
  );
}

export async function fetchRepositoryPathSuggestions(
  repositoryId: string,
  query: string
): Promise<RepositoryPathSuggestion[]> {
  const encodedQuery = encodeURIComponent(query);
  return RepositoryPathSuggestionListSchema.parse(
    await request(`/api/repositories/${repositoryId}/path-suggestions?q=${encodedQuery}`)
  );
}

export async function updateRepository(id: string, input: UpdateRepositoryInput): Promise<Repository> {
  return RepositorySchema.parse(
    await request(`/api/repositories/${id}`, {
      method: "PATCH",
      body: UpdateRepositoryInputSchema.parse(input)
    })
  );
}

export async function deleteRepository(id: string): Promise<void> {
  await request(`/api/repositories/${id}`, { method: "DELETE" });
}

export async function updateTask(id: string, input: UpdateTaskInput): Promise<void> {
  await request(`/api/tasks/${id}`, {
    method: "PATCH",
    body: input
  });
}

export async function dispatchTask(id: string): Promise<Run> {
  return RunSchema.parse(await request(`/api/tasks/${id}/dispatch`, { method: "POST" }));
}

export async function cancelTask(id: string): Promise<void> {
  await request(`/api/tasks/${id}/cancel`, { method: "POST" });
}

export async function markTaskDone(id: string): Promise<void> {
  await request(`/api/tasks/${id}/mark-done`, { method: "POST" });
}

export async function finalizeTask(id: string): Promise<void> {
  await request(`/api/tasks/${id}/finalize`, { method: "POST" });
}

export async function fetchSettings(): Promise<Settings> {
  return SettingsSchema.parse(await request("/api/settings"));
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  return SettingsSchema.parse(
    await request("/api/settings", {
      method: "PUT",
      body: settings
    })
  );
}

async function request(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const requestInit: RequestInit = { method: init?.method ?? "GET" };
  if (init?.body !== undefined) {
    requestInit.headers = { "content-type": "application/json" };
    requestInit.body = JSON.stringify(init.body);
  }

  const response = await fetch(path, requestInit);

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((data as { error?: string } | null)?.error ?? `请求失败：${response.status}`);
  }
  return data;
}

export type { RunEvent };
