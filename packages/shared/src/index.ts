import { z } from "zod";

export const taskStatuses = [
  "todo",
  "queued",
  "preparing",
  "running",
  "human_review",
  "done",
  "failed",
  "cancelled"
] as const;

export const activeTaskStatuses = ["queued", "preparing", "running"] as const;

export const terminalTaskStatuses = ["done", "failed", "cancelled"] as const;

export const runStatuses = [
  "queued",
  "preparing",
  "running",
  "completed",
  "failed",
  "cancelled"
] as const;

export const runEventTypes = [
  "system",
  "workspace",
  "codex",
  "stdout",
  "stderr",
  "status",
  "error"
] as const;

export const workspaceStrategies = ["auto", "sparse-worktree", "full"] as const;
export const resolvedWorkspaceStrategies = ["sparse-worktree", "full"] as const;

export const TaskStatusSchema = z.enum(taskStatuses);
export const RunStatusSchema = z.enum(runStatuses);
export const RunEventTypeSchema = z.enum(runEventTypes);
export const WorkspaceStrategySchema = z.enum(workspaceStrategies);
export const ResolvedWorkspaceStrategySchema = z.enum(resolvedWorkspaceStrategies);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type RunEventType = z.infer<typeof RunEventTypeSchema>;
export type WorkspaceStrategy = z.infer<typeof WorkspaceStrategySchema>;
export type ResolvedWorkspaceStrategy = z.infer<typeof ResolvedWorkspaceStrategySchema>;

export const RepositorySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  path: z.string().min(1),
  baseBranch: z.string().min(1),
  workspaceStrategy: WorkspaceStrategySchema,
  createdAt: z.string(),
  updatedAt: z.string()
});

export const CreateRepositoryInputSchema = z.object({
  name: z.string().trim().min(1),
  path: z.string().trim().min(1),
  baseBranch: z.string().trim().min(1).default("main"),
  workspaceStrategy: WorkspaceStrategySchema.default("auto")
});

export const UpdateRepositoryInputSchema = z.object({
  name: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).optional(),
  baseBranch: z.string().trim().min(1).optional(),
  workspaceStrategy: WorkspaceStrategySchema.optional()
});

export const RepositoryDirectorySelectionSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  baseBranch: z.string().min(1)
});

export const RepositoryPathSuggestionSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["file", "directory"]),
  matches: z.array(z.number().int().min(0))
});

export const RepositoryPathSuggestionListSchema = z.array(RepositoryPathSuggestionSchema);

export const TaskSchema = z.object({
  id: z.string().uuid(),
  key: z.string().min(1),
  repositoryId: z.string().uuid().nullable(),
  title: z.string().min(1),
  description: z.string().default(""),
  priority: z.number().int().min(0).max(5),
  labels: z.array(z.string()),
  scopePaths: z.array(z.string()),
  status: TaskStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string()
});

export const CreateTaskInputSchema = z.object({
  repositoryId: z.string().uuid(),
  title: z.string().trim().min(1),
  description: z.string().default(""),
  priority: z.number().int().min(0).max(5).default(2),
  labels: z.array(z.string().trim().min(1)).default([]),
  scopePaths: z.array(z.string().trim().min(1)).default([])
});

export const UpdateTaskInputSchema = z.object({
  repositoryId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  priority: z.number().int().min(0).max(5).optional(),
  labels: z.array(z.string().trim().min(1)).optional(),
  scopePaths: z.array(z.string().trim().min(1)).optional(),
  status: TaskStatusSchema.optional()
});

export const RunSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  status: RunStatusSchema,
  workspacePath: z.string().nullable(),
  branchName: z.string().nullable(),
  workspaceStrategy: ResolvedWorkspaceStrategySchema.nullable(),
  threadId: z.string().nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable()
});

export const RunEventSchema = z.object({
  id: z.number().int(),
  runId: z.string().uuid(),
  type: RunEventTypeSchema,
  message: z.string(),
  payload: z.unknown().nullable(),
  createdAt: z.string()
});

export const SettingsSchema = z.object({
  workspaceRoot: z.string().min(1),
  maxConcurrentAgents: z.number().int().min(1).max(8).default(2)
});

export const TaskDetailSchema = z.object({
  task: TaskSchema,
  repository: RepositorySchema.nullable(),
  runs: z.array(RunSchema)
});

export const TaskWithLatestRunSchema = TaskSchema.extend({
  repository: RepositorySchema.nullable(),
  latestRun: RunSchema.nullable()
});

export type Repository = z.infer<typeof RepositorySchema>;
export type CreateRepositoryInput = z.infer<typeof CreateRepositoryInputSchema>;
export type UpdateRepositoryInput = z.infer<typeof UpdateRepositoryInputSchema>;
export type RepositoryDirectorySelection = z.infer<typeof RepositoryDirectorySelectionSchema>;
export type RepositoryPathSuggestion = z.infer<typeof RepositoryPathSuggestionSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>;
export type Run = z.infer<typeof RunSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
export type TaskWithLatestRun = z.infer<typeof TaskWithLatestRunSchema>;

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ["queued", "cancelled"],
  queued: ["preparing", "cancelled", "todo", "failed"],
  preparing: ["running", "failed", "cancelled"],
  running: ["human_review", "failed", "cancelled"],
  human_review: ["done", "queued", "failed", "cancelled"],
  done: ["queued"],
  failed: ["queued", "todo"],
  cancelled: ["queued", "todo"]
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || transitions[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`invalid task status transition: ${from} -> ${to}`);
  }
}

export function parseListText(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
