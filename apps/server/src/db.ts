import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  assertTaskTransition,
  SettingsSchema,
  terminalTaskStatuses,
  type CreateRepositoryInput,
  type CreateTaskInput,
  type Repository,
  type ResolvedWorkspaceStrategy,
  type Run,
  type RunEvent,
  type RunEventType,
  type RunStatus,
  type Settings,
  type Task,
  type TaskDetail,
  type TaskStatus,
  type TaskWithLatestRun,
  type UpdateRepositoryInput,
  type UpdateTaskInput
} from "@symphony/shared";
import type { EventBus } from "./events";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

type RepositoryRow = {
  id: string;
  name: string;
  path: string;
  base_branch: string;
  workspace_strategy: Repository["workspaceStrategy"];
  created_at: string;
  updated_at: string;
};

type TaskRow = {
  id: string;
  key: string;
  repository_id: string | null;
  title: string;
  description: string;
  priority: number;
  labels_json: string;
  scope_paths_json: string;
  status: TaskStatus;
  completed_at: string | null;
  completion_commit_sha: string | null;
  completion_pr_url: string | null;
  completion_error: string | null;
  completion_cleanup_error: string | null;
  created_at: string;
  updated_at: string;
};

type RunRow = {
  id: string;
  task_id: string;
  status: RunStatus;
  workspace_path: string | null;
  branch_name: string | null;
  workspace_strategy: ResolvedWorkspaceStrategy | null;
  thread_id: string | null;
  summary: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type RunEventRow = {
  id: number;
  run_id: string;
  type: RunEventType;
  message: string;
  payload_json: string | null;
  created_at: string;
};

type SystemErrorIncidentRow = {
  fingerprint: string;
  task_id: string | null;
  source: string;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  last_summary: string;
};

const settingsKey = "settings";
const terminalTaskStatusSet = new Set<TaskStatus>(terminalTaskStatuses);

type TaskCompletionPatch = Partial<
  Pick<
    Task,
    | "completedAt"
    | "completionCommitSha"
    | "completionPrUrl"
    | "completionError"
    | "completionCleanupError"
  >
>;

export type EnsureRepositoryInput = {
  name: string;
  path: string;
  baseBranch: string;
  workspaceStrategy: Repository["workspaceStrategy"];
};

export type CreateSystemErrorIncidentInput = {
  fingerprint: string;
  source: string;
  title: string;
  description: string;
  summary: string;
  repository: EnsureRepositoryInput;
  cooldownMinutes: number;
  now?: Date;
};

export type SystemErrorIncident = {
  fingerprint: string;
  taskId: string | null;
  source: string;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  lastSummary: string;
};

export type SystemErrorRecordResult = {
  incident: SystemErrorIncident;
  task: Task | null;
  createdTask: boolean;
};

export class SymphonyDb {
  private db: DatabaseSyncType;
  private closed = false;

  constructor(
    dbPath: string,
    private readonly eventBus: EventBus,
    private readonly projectRoot: string
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }

  getSettings(): Settings {
    const row = this.db
      .prepare("SELECT value_json FROM app_settings WHERE key = ?")
      .get(settingsKey) as { value_json: string } | undefined;
    if (!row) {
      return this.defaultSettings();
    }
    const raw = JSON.parse(row.value_json) as Partial<Settings>;
    const defaults = this.defaultSettings();
    return SettingsSchema.parse({
      workspaceRoot: raw.workspaceRoot ?? defaults.workspaceRoot,
      maxConcurrentAgents: raw.maxConcurrentAgents ?? defaults.maxConcurrentAgents,
      selfMonitor: {
        enabled: raw.selfMonitor?.enabled ?? defaults.selfMonitor.enabled,
        cooldownMinutes:
          raw.selfMonitor?.cooldownMinutes ?? defaults.selfMonitor.cooldownMinutes
      }
    });
  }

  saveSettings(settings: Settings): Settings {
    const normalized = SettingsSchema.parse(settings);
    this.db
      .prepare(
        "INSERT INTO app_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"
      )
      .run(settingsKey, JSON.stringify(normalized));
    return this.getSettings();
  }

  listRepositories(): Repository[] {
    const rows = this.db
      .prepare("SELECT * FROM repositories ORDER BY name COLLATE NOCASE ASC")
      .all() as RepositoryRow[];
    return rows.map(mapRepository);
  }

  createRepository(input: CreateRepositoryInput): Repository {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO repositories
          (id, name, path, base_branch, workspace_strategy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.name, input.path, input.baseBranch, input.workspaceStrategy, now, now);
    return this.getRepository(id);
  }

  getRepository(id: string): Repository {
    const row = this.db.prepare("SELECT * FROM repositories WHERE id = ?").get(id) as
      | RepositoryRow
      | undefined;
    if (!row) {
      throw new Error(`未找到仓库：${id}`);
    }
    return mapRepository(row);
  }

  findRepositoryByPath(path: string): Repository | null {
    const row = this.db
      .prepare("SELECT * FROM repositories WHERE path = ? ORDER BY created_at ASC LIMIT 1")
      .get(path) as RepositoryRow | undefined;
    return row ? mapRepository(row) : null;
  }

  ensureRepository(input: EnsureRepositoryInput): Repository {
    const existing = this.findRepositoryByPath(input.path);
    if (existing) {
      return existing;
    }
    return this.createRepository(input);
  }

  updateRepository(id: string, input: UpdateRepositoryInput): Repository {
    const current = this.getRepository(id);
    const next = {
      name: input.name ?? current.name,
      path: input.path ?? current.path,
      baseBranch: input.baseBranch ?? current.baseBranch,
      workspaceStrategy: input.workspaceStrategy ?? current.workspaceStrategy,
      updatedAt: new Date().toISOString()
    };
    this.db
      .prepare(
        `UPDATE repositories
         SET name = ?, path = ?, base_branch = ?, workspace_strategy = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(next.name, next.path, next.baseBranch, next.workspaceStrategy, next.updatedAt, id);
    return this.getRepository(id);
  }

  deleteRepository(id: string): void {
    this.getRepository(id);
    this.db.prepare("UPDATE tasks SET repository_id = NULL WHERE repository_id = ?").run(id);
    this.db.prepare("DELETE FROM repositories WHERE id = ?").run(id);
  }

  createTask(input: CreateTaskInput): Task {
    this.getRepository(input.repositoryId);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const key = `SYM-${Date.now().toString(36).toUpperCase()}`;
    const title = input.title ?? buildInitialTaskTitle(input.description);
    this.db
      .prepare(
        `INSERT INTO tasks
          (id, key, repository_id, title, description, priority, labels_json, scope_paths_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?)`
      )
      .run(
        id,
        key,
        input.repositoryId,
        title,
        input.description,
        input.priority,
        JSON.stringify(input.labels),
        JSON.stringify(input.scopePaths),
        now,
        now
      );
    return this.getTask(id);
  }

  getTaskWithLatestRun(id: string): TaskWithLatestRun {
    const task = this.getTask(id);
    return {
      ...task,
      repository: task.repositoryId ? this.getRepository(task.repositoryId) : null,
      latestRun: this.getLatestRun(id)
    };
  }

  listTasksWithLatestRun(): TaskWithLatestRun[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks ORDER BY updated_at DESC")
      .all() as TaskRow[];
    return rows.map((row) => ({
      ...mapTask(row),
      repository: row.repository_id ? this.getRepository(row.repository_id) : null,
      latestRun: this.getLatestRun(row.id)
    }));
  }

  getTask(id: string): Task {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    if (!row) {
      throw new Error(`未找到任务：${id}`);
    }
    return mapTask(row);
  }

  private getTaskIfExists(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  getTaskDetail(id: string): TaskDetail {
    const task = this.getTask(id);
    return {
      task,
      repository: task.repositoryId ? this.getRepository(task.repositoryId) : null,
      runs: this.listRunsForTask(id)
    };
  }

  updateTask(id: string, input: UpdateTaskInput): Task {
    const current = this.getTask(id);
    if (input.status) {
      assertTaskTransition(current.status, input.status);
    }
    if (input.repositoryId !== undefined && input.repositoryId !== null) {
      this.getRepository(input.repositoryId);
    }

    const next = {
      repositoryId: input.repositoryId === undefined ? current.repositoryId : input.repositoryId,
      title: input.title ?? current.title,
      description: input.description ?? current.description,
      priority: input.priority ?? current.priority,
      labels: input.labels ?? current.labels,
      scopePaths: input.scopePaths ?? current.scopePaths,
      status: input.status ?? current.status,
      updatedAt: new Date().toISOString()
    };

    this.db
      .prepare(
        `UPDATE tasks
         SET repository_id = ?, title = ?, description = ?, priority = ?, labels_json = ?, scope_paths_json = ?, status = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        next.repositoryId,
        next.title,
        next.description,
        next.priority,
        JSON.stringify(next.labels),
        JSON.stringify(next.scopePaths),
        next.status,
        next.updatedAt,
        id
      );

    return this.getTask(id);
  }

  updateTaskStatus(id: string, status: TaskStatus): Task {
    return this.updateTask(id, { status });
  }

  updateTaskCompletion(id: string, patch: TaskCompletionPatch): Task {
    const current = this.getTask(id);
    const next = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };

    this.db
      .prepare(
        `UPDATE tasks
         SET completed_at = ?, completion_commit_sha = ?, completion_pr_url = ?, completion_error = ?, completion_cleanup_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        next.completedAt,
        next.completionCommitSha,
        next.completionPrUrl,
        next.completionError,
        next.completionCleanupError,
        next.updatedAt,
        id
      );

    return this.getTask(id);
  }

  createRun(taskId: string): Run {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO runs
          (id, task_id, status, workspace_path, branch_name, workspace_strategy, thread_id, summary, error, created_at, started_at, completed_at)
         VALUES (?, ?, 'queued', NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL)`
      )
      .run(id, taskId, now);
    return this.getRun(id);
  }

  getRun(id: string): Run {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    if (!row) {
      throw new Error(`未找到运行记录：${id}`);
    }
    return mapRun(row);
  }

  listRunsForTask(taskId: string): Run[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY created_at DESC")
      .all(taskId) as RunRow[];
    return rows.map(mapRun);
  }

  getLatestRun(taskId: string): Run | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(taskId) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  findActiveRunForTask(taskId: string): Run | null {
    const row = this.db
      .prepare(
        "SELECT * FROM runs WHERE task_id = ? AND status IN ('queued', 'preparing', 'running') ORDER BY created_at DESC LIMIT 1"
      )
      .get(taskId) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  updateRun(
    id: string,
    patch: Partial<Pick<Run, "status" | "workspacePath" | "branchName" | "workspaceStrategy" | "threadId" | "summary" | "error" | "startedAt" | "completedAt">>
  ): Run {
    const current = this.getRun(id);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE runs
         SET status = ?, workspace_path = ?, branch_name = ?, workspace_strategy = ?, thread_id = ?, summary = ?, error = ?, started_at = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(
        next.status,
        next.workspacePath,
        next.branchName,
        next.workspaceStrategy,
        next.threadId,
        next.summary,
        next.error,
        next.startedAt,
        next.completedAt,
        id
      );
    return this.getRun(id);
  }

  addRunEvent(
    runId: string,
    type: RunEventType,
    message: string,
    payload: unknown = null
  ): RunEvent {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("INSERT INTO run_events (run_id, type, message, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, type, message, payload === null ? null : JSON.stringify(payload), now);
    const event = this.getRunEvent(Number(result.lastInsertRowid));
    this.eventBus.emitRunEvent(event);
    return event;
  }

  getRunEvent(id: number): RunEvent {
    const row = this.db.prepare("SELECT * FROM run_events WHERE id = ?").get(id) as
      | RunEventRow
      | undefined;
    if (!row) {
      throw new Error(`未找到运行事件：${id}`);
    }
    return mapRunEvent(row);
  }

  listRunEvents(runId: string): RunEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY id ASC")
      .all(runId) as RunEventRow[];
    return rows.map(mapRunEvent);
  }

  getSystemErrorIncident(fingerprint: string): SystemErrorIncident | null {
    const row = this.db
      .prepare("SELECT * FROM system_error_incidents WHERE fingerprint = ?")
      .get(fingerprint) as SystemErrorIncidentRow | undefined;
    return row ? mapSystemErrorIncident(row) : null;
  }

  recordSystemErrorIncident(input: CreateSystemErrorIncidentInput): SystemErrorRecordResult {
    const now = (input.now ?? new Date()).toISOString();
    const repository = this.ensureRepository(input.repository);
    const current = this.getSystemErrorIncident(input.fingerprint);
    const currentTask = current?.taskId ? this.getTaskIfExists(current.taskId) : null;
    const shouldCreateTask =
      !current ||
      !currentTask ||
      (terminalTaskStatusSet.has(currentTask.status) &&
        isCooldownElapsed(current.lastSeen, now, input.cooldownMinutes));

    const task = shouldCreateTask
      ? this.createTask({
          repositoryId: repository.id,
          title: input.title,
          description: input.description,
          priority: 4,
          labels: ["system-monitor", "auto-created"],
          scopePaths: []
        })
      : currentTask;

    if (!current) {
      this.db
        .prepare(
          `INSERT INTO system_error_incidents
            (fingerprint, task_id, source, occurrences, first_seen, last_seen, last_summary)
           VALUES (?, ?, ?, 1, ?, ?, ?)`
        )
        .run(input.fingerprint, task?.id ?? null, input.source, now, now, input.summary);
    } else {
      this.db
        .prepare(
          `UPDATE system_error_incidents
           SET task_id = ?, source = ?, occurrences = occurrences + 1, last_seen = ?, last_summary = ?
           WHERE fingerprint = ?`
        )
        .run(task?.id ?? current.taskId, input.source, now, input.summary, input.fingerprint);
    }

    return {
      incident: this.getSystemErrorIncident(input.fingerprint) ?? missingIncident(input.fingerprint),
      task,
      createdTask: shouldCreateTask
    };
  }

  recoverInterruptedRuns(): void {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE status IN ('queued', 'preparing', 'running')")
      .all() as RunRow[];
    for (const row of rows) {
      this.updateRun(row.id, {
        status: "failed",
        error: "服务重启导致本次运行未完成",
        completedAt: new Date().toISOString()
      });
      this.updateTaskStatus(row.task_id, "failed");
      this.addRunEvent(row.id, "error", "服务重启导致本次运行未完成");
    }
  }

  private defaultSettings(): Settings {
    return {
      workspaceRoot: resolve(this.projectRoot, ".workspaces"),
      maxConcurrentAgents: 2,
      selfMonitor: {
        enabled: true,
        cooldownMinutes: 30
      }
    };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        workspace_strategy TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        priority INTEGER NOT NULL,
        labels_json TEXT NOT NULL,
        scope_paths_json TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TEXT,
        completion_commit_sha TEXT,
        completion_pr_url TEXT,
        completion_error TEXT,
        completion_cleanup_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        workspace_path TEXT,
        branch_name TEXT,
        workspace_strategy TEXT,
        thread_id TEXT,
        summary TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS system_error_incidents (
        fingerprint TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        source TEXT NOT NULL,
        occurrences INTEGER NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        last_summary TEXT NOT NULL
      );
    `);
    this.addColumnIfMissing("tasks", "repository_id", "TEXT");
    this.addColumnIfMissing("tasks", "completed_at", "TEXT");
    this.addColumnIfMissing("tasks", "completion_commit_sha", "TEXT");
    this.addColumnIfMissing("tasks", "completion_pr_url", "TEXT");
    this.addColumnIfMissing("tasks", "completion_error", "TEXT");
    this.addColumnIfMissing("tasks", "completion_cleanup_error", "TEXT");
    this.addColumnIfMissing("runs", "workspace_strategy", "TEXT");
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.some((row) => row.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

function mapRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    baseBranch: row.base_branch,
    workspaceStrategy: row.workspace_strategy,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    key: row.key,
    repositoryId: row.repository_id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    labels: JSON.parse(row.labels_json) as string[],
    scopePaths: JSON.parse(row.scope_paths_json) as string[],
    status: row.status,
    completedAt: row.completed_at,
    completionCommitSha: row.completion_commit_sha,
    completionPrUrl: row.completion_pr_url,
    completionError: row.completion_error,
    completionCleanupError: row.completion_cleanup_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    workspacePath: row.workspace_path,
    branchName: row.branch_name,
    workspaceStrategy: row.workspace_strategy,
    threadId: row.thread_id,
    summary: row.summary,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

function mapRunEvent(row: RunEventRow): RunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    message: row.message,
    payload: row.payload_json ? JSON.parse(row.payload_json) : null,
    createdAt: row.created_at
  };
}

function mapSystemErrorIncident(row: SystemErrorIncidentRow): SystemErrorIncident {
  return {
    fingerprint: row.fingerprint,
    taskId: row.task_id,
    source: row.source,
    occurrences: row.occurrences,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    lastSummary: row.last_summary
  };
}

function buildInitialTaskTitle(description: string): string {
  const normalized = description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!normalized) {
    return "新任务";
  }
  return normalized.length > 36 ? `${normalized.slice(0, 36)}...` : normalized;
}

function isCooldownElapsed(lastSeen: string, now: string, cooldownMinutes: number): boolean {
  return Date.parse(now) - Date.parse(lastSeen) >= cooldownMinutes * 60 * 1000;
}

function missingIncident(fingerprint: string): never {
  throw new Error(`系统错误记录写入失败：${fingerprint}`);
}
