import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleStop,
  CircleX,
  Clock3,
  ExternalLink,
  File,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Inbox,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Trash2,
  X
} from "lucide-react";
import {
  parseListText,
  type Repository,
  type RepositoryPathSuggestion,
  type RunEvent,
  type RunEventType,
  type RunStatus,
  type Settings,
  type TaskDetail,
  type TaskStatus,
  type TaskWithLatestRun,
  type WorkspaceStrategy
} from "@symphony/shared";
import {
  cancelTask,
  createRepository,
  createTask,
  deleteRepository,
  dispatchTask,
  fetchRepositoryPathSuggestions,
  fetchRepositories,
  fetchSettings,
  fetchTaskDetail,
  fetchTasks,
  finalizeTask,
  saveSettings,
  selectRepositoryDirectory,
  updateRepository,
  updateTask
} from "./api";

type StatusFilter = TaskStatus | "all";
type RepositoryFilter = string | "all";
type ActiveModal = "task" | "repositories" | "settings" | null;

const taskStatusLabels: Record<TaskStatus, string> = {
  todo: "待处理",
  queued: "排队中",
  preparing: "准备中",
  running: "运行中",
  human_review: "待人工确认",
  finalizing: "交付中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

const runStatusLabels: Record<RunStatus, string> = {
  queued: "排队中",
  preparing: "准备中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

const eventTypeLabels: Record<RunEventType, string> = {
  system: "系统",
  workspace: "工作区",
  codex: "Codex",
  stdout: "标准输出",
  stderr: "错误输出",
  status: "状态",
  error: "错误"
};

const workspaceStrategyLabels: Record<WorkspaceStrategy, string> = {
  auto: "自动判断",
  "sparse-worktree": "稀疏 worktree",
  full: "完整 worktree"
};

const defaultSettings: Settings = {
  workspaceRoot: "",
  maxConcurrentAgents: 2
};

type TaskForm = {
  repositoryId: string;
  title: string;
  description: string;
  priority: number;
  labels: string;
  scopePaths: string;
};

type PathMentionState =
  | { status: "closed" }
  | {
      status: "open";
      query: string;
      start: number;
      end: number;
      loading: boolean;
      suggestions: RepositoryPathSuggestion[];
      selectedIndex: number;
      message: string | null;
    };

type RepositoryForm = {
  name: string;
  path: string;
  baseBranch: string;
  workspaceStrategy: WorkspaceStrategy;
};

const defaultRepositoryForm: RepositoryForm = {
  name: "",
  path: "",
  baseBranch: "main",
  workspaceStrategy: "auto"
};

const statusFilters: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "全部任务" },
  { value: "todo", label: "待处理" },
  { value: "queued", label: "排队中" },
  { value: "preparing", label: "准备中" },
  { value: "running", label: "运行中" },
  { value: "human_review", label: "待人工确认" },
  { value: "finalizing", label: "交付中" },
  { value: "done", label: "已完成" },
  { value: "failed", label: "失败" }
];

const taskGroups: Array<{ id: string; title: string; hint: string; statuses: TaskStatus[] }> = [
  {
    id: "needs",
    title: "需要处理",
    hint: "待创建工作区或等待派发的任务",
    statuses: ["todo", "queued"]
  },
  {
    id: "running",
    title: "正在执行",
    hint: "准备中和运行中的 agent 会话",
    statuses: ["preparing", "running"]
  },
  {
    id: "review",
    title: "等待人工审核",
    hint: "Codex 已完成，等待你确认关闭",
    statuses: ["human_review"]
  },
  {
    id: "finalizing",
    title: "正在交付",
    hint: "校验、提交、推送和 PR 创建正在执行",
    statuses: ["finalizing"]
  },
  {
    id: "finished",
    title: "最近结束",
    hint: "完成、失败或取消的任务",
    statuses: ["done", "failed", "cancelled"]
  }
];

export function App() {
  const [tasks, setTasks] = useState<TaskWithLatestRun[]>([]);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [form, setForm] = useState<TaskForm>({
    repositoryId: "",
    title: "",
    description: "",
    priority: 2,
    labels: "",
    scopePaths: ""
  });
  const [repositoryForm, setRepositoryForm] = useState<RepositoryForm>(defaultRepositoryForm);
  const [error, setError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [selectingRepositoryDirectory, setSelectingRepositoryDirectory] = useState(false);
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [advancedScopeOpen, setAdvancedScopeOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [repositoryFilterId, setRepositoryFilterId] = useState<RepositoryFilter>("all");
  const [pathMention, setPathMention] = useState<PathMentionState>({ status: "closed" });
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? null,
    [selectedId, tasks]
  );

  const formRepository = useMemo(
    () => repositories.find((repository) => repository.id === form.repositoryId) ?? null,
    [form.repositoryId, repositories]
  );

  const visibleTasks = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return tasks.filter((task) => {
      const matchesStatus = statusFilter === "all" || task.status === statusFilter;
      const matchesRepository =
        repositoryFilterId === "all" || task.repositoryId === repositoryFilterId;
      const searchable = [
        task.key,
        task.title,
        task.description,
        task.repository?.name ?? "未绑定仓库",
        ...task.labels
      ]
        .join(" ")
        .toLowerCase();
      const matchesQuery = !normalizedQuery || searchable.includes(normalizedQuery);
      return matchesStatus && matchesRepository && matchesQuery;
    });
  }, [repositoryFilterId, searchQuery, statusFilter, tasks]);

  const groupedTasks = useMemo(() => {
    return taskGroups
      .map((group) => ({
        ...group,
        tasks: visibleTasks.filter((task) => group.statuses.includes(task.status))
      }))
      .filter((group) => {
        if (group.tasks.length > 0) {
          return true;
        }
        return statusFilter === "all" && repositoryFilterId === "all" && !searchQuery.trim() && group.id !== "finished";
      });
  }, [repositoryFilterId, searchQuery, statusFilter, visibleTasks]);

  async function reload() {
    const [nextTasks, nextSettings, nextRepositories] = await Promise.all([
      fetchTasks(),
      fetchSettings(),
      fetchRepositories()
    ]);
    setTasks(nextTasks);
    setSettings(nextSettings);
    setRepositories(nextRepositories);
    setForm((current) => ({
      ...current,
      repositoryId: nextRepositories.some((repository) => repository.id === current.repositoryId)
        ? current.repositoryId
        : nextRepositories[0]?.id ?? ""
    }));
    setSelectedId((current) => {
      if (current && nextTasks.some((task) => task.id === current)) {
        return current;
      }
      return nextTasks[0]?.id ?? null;
    });
    setRepositoryFilterId((current) => {
      if (current === "all" || nextRepositories.some((repository) => repository.id === current)) {
        return current;
      }
      return "all";
    });
  }

  useEffect(() => {
    void reload().catch((caught) => setError(errorMessage(caught)));
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void fetchTaskDetail(selectedId)
      .then(setDetail)
      .catch((caught) => setError(errorMessage(caught)));
  }, [selectedId, tasks]);

  useEffect(() => {
    const latestRun = detail?.runs[0];
    if (!latestRun) {
      setEvents([]);
      return;
    }

    const source = new EventSource(`/api/runs/${latestRun.id}/events/stream`);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as RunEvent;
      setEvents((current) => {
        if (current.some((item) => item.id === event.id)) {
          return current;
        }
        return [...current, event];
      });
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, [detail?.runs[0]?.id]);

  const pathMentionQuery = pathMention.status === "open" ? pathMention.query : null;
  useEffect(() => {
    if (pathMentionQuery === null) {
      return;
    }

    if (!form.repositoryId) {
      setPathMention((current) =>
        current.status === "open"
          ? {
              ...current,
              loading: false,
              suggestions: [],
              selectedIndex: 0,
              message: "请先选择目标仓库"
            }
          : current
      );
      return;
    }

    let ignore = false;
    setPathMention((current) =>
      current.status === "open" && current.query === pathMentionQuery
        ? { ...current, loading: true, message: null }
        : current
    );

    void fetchRepositoryPathSuggestions(form.repositoryId, pathMentionQuery)
      .then((suggestions) => {
        if (ignore) {
          return;
        }
        setPathMention((current) =>
          current.status === "open" && current.query === pathMentionQuery
            ? {
                ...current,
                loading: false,
                suggestions,
                selectedIndex: 0,
                message: suggestions.length > 0 ? null : "没有匹配路径"
              }
            : current
        );
      })
      .catch((caught) => {
        if (ignore) {
          return;
        }
        setPathMention((current) =>
          current.status === "open" && current.query === pathMentionQuery
            ? {
                ...current,
                loading: false,
                suggestions: [],
                selectedIndex: 0,
                message: errorMessage(caught)
              }
            : current
        );
      });

    return () => {
      ignore = true;
    };
  }, [form.repositoryId, pathMentionQuery]);

  function openTaskModal() {
    setForm((current) => ({
      ...current,
      repositoryId: current.repositoryId || repositories[0]?.id || ""
    }));
    setAdvancedScopeOpen(false);
    setPathMention({ status: "closed" });
    setActiveModal("task");
  }

  async function submitTask() {
    try {
      setError(null);
      const created = await createTask({
        repositoryId: form.repositoryId,
        title: form.title,
        description: form.description,
        priority: form.priority,
        labels: parseListText(form.labels),
        scopePaths: parseListText(form.scopePaths)
      });
      setForm({
        repositoryId: form.repositoryId,
        title: "",
        description: "",
        priority: 2,
        labels: "",
        scopePaths: ""
      });
      setPathMention({ status: "closed" });
      setActiveModal(null);
      setAdvancedScopeOpen(false);
      await reload();
      setSelectedId(created.id);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function runAction(action: () => Promise<unknown>) {
    try {
      setError(null);
      await action();
      await reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function persistSettings() {
    setSavingSettings(true);
    try {
      setError(null);
      setSettings(await saveSettings(settings));
      setActiveModal(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSavingSettings(false);
    }
  }

  async function submitRepository() {
    await createRepository(repositoryForm);
    setRepositoryForm(defaultRepositoryForm);
  }

  async function pickRepositoryDirectory() {
    setSelectingRepositoryDirectory(true);
    try {
      setError(null);
      const selection = await selectRepositoryDirectory();
      setRepositoryForm((current) => ({
        ...current,
        name: selection.name,
        path: selection.path,
        baseBranch: selection.baseBranch
      }));
    } catch (caught) {
      const message = errorMessage(caught);
      if (message !== "已取消选择文件夹") {
        setError(message);
      }
    } finally {
      setSelectingRepositoryDirectory(false);
    }
  }

  function updateTaskDescription(value: string, selectionStart: number | null) {
    setForm((current) => ({ ...current, description: value }));
    const mention = findPathMention(value, selectionStart ?? value.length);
    if (!mention) {
      setPathMention({ status: "closed" });
      return;
    }
    setPathMention({
      status: "open",
      query: mention.query,
      start: mention.start,
      end: mention.end,
      loading: Boolean(form.repositoryId),
      suggestions: [],
      selectedIndex: 0,
      message: form.repositoryId ? null : "请先选择目标仓库"
    });
  }

  function insertPathSuggestion(suggestion: RepositoryPathSuggestion) {
    if (pathMention.status !== "open") {
      return;
    }

    const token = suggestion.path.includes(" ") ? `@"${suggestion.path}"` : `@${suggestion.path}`;
    const nextDescription = `${form.description.slice(0, pathMention.start)}${token} ${form.description.slice(pathMention.end)}`;
    const nextCaret = pathMention.start + token.length + 1;
    setForm((current) => ({ ...current, description: nextDescription }));
    setPathMention({ status: "closed" });
    window.setTimeout(() => {
      descriptionRef.current?.focus();
      descriptionRef.current?.setSelectionRange(nextCaret, nextCaret);
    }, 0);
  }

  function handleDescriptionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (pathMention.status !== "open") {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setPathMention({ status: "closed" });
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setPathMention((current) => {
        if (current.status !== "open" || current.suggestions.length === 0) {
          return current;
        }
        return {
          ...current,
          selectedIndex:
            (current.selectedIndex + direction + current.suggestions.length) %
            current.suggestions.length
        };
      });
      return;
    }

    const selectedSuggestion = pathMention.suggestions[pathMention.selectedIndex];
    if (event.key === "Enter" && selectedSuggestion) {
      event.preventDefault();
      insertPathSuggestion(selectedSuggestion);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <h1>Symphony</h1>
        </div>

        <label className="search-box" aria-label="搜索任务">
          <Search size={18} />
          <input
            value={searchQuery}
            placeholder="搜索任务、仓库、标签..."
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </label>

        <div className="topbar-actions">
          <button className="pill-button subtle" type="button" onClick={() => void runAction(reload)} title="刷新">
            <RefreshCw size={17} />
          </button>
          <button className="pill-button" type="button" onClick={() => setActiveModal("repositories")}>
            <FolderGit2 size={17} />
            仓库
          </button>
          <button className="pill-button" type="button" onClick={() => setActiveModal("settings")}>
            <SettingsIcon size={17} />
            设置
          </button>
          <button className="primary-button" type="button" onClick={openTaskModal}>
            <Plus size={18} />
            新建任务
          </button>
        </div>
      </header>

      {error ? (
        <div className="error-strip">
          <AlertTriangle size={17} />
          <span>{error}</span>
        </div>
      ) : null}

      <section className="workspace" aria-label="任务收件箱">
        <aside className="filter-rail">
          <div className="rail-section">
            <div className="rail-title">
              <Inbox size={17} />
              <span>状态</span>
            </div>
            <div className="filter-list">
              {statusFilters.map((filter) => (
                <button
                  className={`filter-chip ${statusFilter === filter.value ? "selected" : ""}`}
                  key={filter.value}
                  type="button"
                  onClick={() => setStatusFilter(filter.value)}
                >
                  <StatusIcon status={filter.value} />
                  <span>{filter.label}</span>
                  <b>{countTasksByStatus(tasks, filter.value)}</b>
                </button>
              ))}
            </div>
          </div>

          <div className="rail-section">
            <div className="rail-title">
              <GitBranch size={17} />
              <span>仓库</span>
            </div>
            <div className="filter-list">
              <button
                className={`filter-chip ${repositoryFilterId === "all" ? "selected" : ""}`}
                type="button"
                onClick={() => setRepositoryFilterId("all")}
              >
                <span>全部仓库</span>
                <b>{tasks.length}</b>
              </button>
              {repositories.map((repository) => (
                <button
                  className={`filter-chip ${repositoryFilterId === repository.id ? "selected" : ""}`}
                  key={repository.id}
                  type="button"
                  onClick={() => setRepositoryFilterId(repository.id)}
                >
                  <span>{repository.name}</span>
                  <b>{tasks.filter((task) => task.repositoryId === repository.id).length}</b>
                </button>
              ))}
              {repositories.length === 0 ? (
                <button className="empty-repo-action" type="button" onClick={() => setActiveModal("repositories")}>
                  配置第一个仓库
                </button>
              ) : null}
            </div>
          </div>
        </aside>

        <section className="inbox-panel">
          <div className="inbox-heading">
            <div>
              <p>任务流</p>
              <h2>{statusFilter === "all" ? "收件箱" : taskStatusLabels[statusFilter]}</h2>
            </div>
            <span>{visibleTasks.length} 个任务</span>
          </div>

          <div className="inbox-groups">
            {groupedTasks.length > 0 ? (
              groupedTasks.map((group) => (
                <section className="task-group" key={group.id}>
                  <div className="group-header">
                    <div>
                      <h3>{group.title}</h3>
                      <p>{group.hint}</p>
                    </div>
                    <b>{group.tasks.length}</b>
                  </div>

                  <div className="task-list">
                    {group.tasks.length > 0 ? (
                      group.tasks.map((task) => (
                        <button
                          className={`inbox-row ${selectedId === task.id ? "selected" : ""}`}
                          key={task.id}
                          type="button"
                          onClick={() => setSelectedId(task.id)}
                        >
                          <span className={`status-dot ${task.status}`}>
                            <StatusIcon status={task.status} />
                          </span>
                          <span className="row-main">
                            <strong>{task.title}</strong>
                            <small>{latestRunText(task)}</small>
                          </span>
                          <span className="row-chip">{task.repository?.name ?? "未绑定仓库"}</span>
                          <span className="row-chip muted">{task.latestRun?.workspaceStrategy ? workspaceStrategyLabels[task.latestRun.workspaceStrategy] : "未运行"}</span>
                          <time>{formatShortDate(task.updatedAt)}</time>
                        </button>
                      ))
                    ) : (
                      <div className="empty-group">暂无任务</div>
                    )}
                  </div>
                </section>
              ))
            ) : (
              <div className="empty-inbox">
                <Inbox size={28} />
                <strong>没有匹配的任务</strong>
                <span>调整搜索、状态或仓库筛选后再看。</span>
              </div>
            )}
          </div>
        </section>

        <aside className="detail">
          {selectedTask && detail ? (
            <>
              <div className="detail-header">
                <div>
                  <span className={`task-status-chip ${selectedTask.status}`}>{taskStatusLabels[selectedTask.status]}</span>
                  <h2>{selectedTask.title}</h2>
                  <p>{selectedTask.key}</p>
                </div>
                <div className="detail-actions">
                  <button
                    aria-label="派发任务"
                    data-tooltip="派发任务"
                    type="button"
                    disabled={selectedTask.status === "finalizing"}
                    onClick={() => void runAction(() => dispatchTask(selectedTask.id))}
                  >
                    <Play size={16} />
                  </button>
                  <button
                    aria-label="取消任务"
                    data-tooltip="取消任务"
                    type="button"
                    disabled={selectedTask.status === "finalizing"}
                    onClick={() => void runAction(() => cancelTask(selectedTask.id))}
                  >
                    <CircleX size={16} />
                  </button>
                  <button
                    aria-label="提交推送并创建 PR"
                    data-tooltip="提交推送并创建 PR"
                    type="button"
                    disabled={selectedTask.status !== "human_review"}
                    onClick={() => void runAction(() => finalizeTask(selectedTask.id))}
                  >
                    <GitPullRequest size={16} />
                  </button>
                </div>
              </div>

              <textarea
                className="detail-description"
                value={detail.task.description}
                placeholder="补充任务描述..."
                onChange={(event) => {
                  const value = event.target.value;
                  setDetail({ ...detail, task: { ...detail.task, description: value } });
                }}
                onBlur={() => void runAction(() => updateTask(detail.task.id, { description: detail.task.description }))}
              />

              <div className="detail-grid">
                <span>仓库</span>
                <b>{detail.repository?.name ?? "未绑定仓库"}</b>
                <span>仓库策略</span>
                <b>{detail.repository ? workspaceStrategyLabels[detail.repository.workspaceStrategy] : "-"}</b>
                <span>本次策略</span>
                <b>{detail.runs[0]?.workspaceStrategy ? workspaceStrategyLabels[detail.runs[0].workspaceStrategy] : "-"}</b>
                <span>范围</span>
                <b>{selectedTask.scopePaths.join(", ") || "自动判断"}</b>
                <span>工作区</span>
                <b>{detail.runs[0]?.workspacePath ?? "-"}</b>
                <span>分支</span>
                <b>{detail.runs[0]?.branchName ?? "-"}</b>
              </div>

              <section className="summary-box">
                <p>最终摘要</p>
                <span>{detail.runs[0]?.summary ?? detail.runs[0]?.error ?? "暂无摘要"}</span>
              </section>

              <section className={`completion-box ${selectedTask.status}`}>
                <div>
                  <p>交付收尾</p>
                  <span>{completionStatusText(selectedTask)}</span>
                </div>
                {selectedTask.completionCommitSha ? (
                  <code>{selectedTask.completionCommitSha.slice(0, 12)}</code>
                ) : null}
                {selectedTask.completionPrUrl ? (
                  <a href={selectedTask.completionPrUrl} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} />
                    查看 PR
                  </a>
                ) : null}
                {selectedTask.completionError ? (
                  <strong>{selectedTask.completionError}</strong>
                ) : null}
                {selectedTask.completionCleanupError ? (
                  <small>工作区清理失败：{selectedTask.completionCleanupError}</small>
                ) : null}
              </section>

              <div className="panel-title logs-title">
                <SlidersHorizontal size={17} />
                <span>运行日志</span>
              </div>
              <div className="log-stream">
                {events.length > 0 ? (
                  events.map((event) => (
                    <div className={`log-line ${event.type}`} key={event.id}>
                      <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
                      <span>{eventTypeLabels[event.type]}</span>
                      <p>{event.message}</p>
                    </div>
                  ))
                ) : (
                  <div className="empty-log">暂无运行事件</div>
                )}
              </div>
            </>
          ) : (
            <div className="empty-detail">
              <Inbox size={26} />
              <span>选择一个任务查看详情</span>
            </div>
          )}
        </aside>
      </section>

      {activeModal === "task" ? (
        <div className="modal-backdrop" role="presentation">
          <section className="dialog-modal task-modal" role="dialog" aria-modal="true" aria-labelledby="task-modal-title">
            <div className="modal-header">
              <div>
                <h2 id="task-modal-title">新建任务</h2>
                <p>创建后进入待处理队列，由你手动派发。</p>
              </div>
              <button className="icon-button" type="button" onClick={() => setActiveModal(null)} title="关闭">
                <X size={18} />
              </button>
            </div>

            <div className="task-form-grid">
              <label className="field full">
                目标仓库 *
                <select value={form.repositoryId} onChange={(event) => setForm({ ...form, repositoryId: event.target.value })}>
                  <option value="">请选择仓库</option>
                  {repositories.map((repository) => (
                    <option value={repository.id} key={repository.id}>
                      {repository.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field full">
                标题 *
                <input placeholder="例如：修复登录页 loading 状态" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
              </label>
              <label className="field full path-mention-field">
                描述 *
                <textarea
                  ref={descriptionRef}
                  placeholder="写清楚目标、约束和验收方式，输入 @ 选择仓库路径"
                  value={form.description}
                  onChange={(event) => updateTaskDescription(event.target.value, event.target.selectionStart)}
                  onKeyDown={handleDescriptionKeyDown}
                  onBlur={() => window.setTimeout(() => setPathMention({ status: "closed" }), 120)}
                />
                {pathMention.status === "open" ? (
                  <div className="path-suggestion-popover" role="listbox" aria-label="仓库路径候选">
                    {pathMention.loading ? <div className="path-suggestion-message">正在搜索路径...</div> : null}
                    {!pathMention.loading && pathMention.message ? (
                      <div className="path-suggestion-message">{pathMention.message}</div>
                    ) : null}
                    {!pathMention.loading && !pathMention.message
                      ? pathMention.suggestions.map((suggestion, index) => (
                          <button
                            className={`path-suggestion-item ${index === pathMention.selectedIndex ? "selected" : ""}`}
                            type="button"
                            role="option"
                            aria-selected={index === pathMention.selectedIndex}
                            key={`${suggestion.kind}:${suggestion.path}`}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => insertPathSuggestion(suggestion)}
                          >
                            {suggestion.kind === "directory" ? <Folder size={16} /> : <File size={16} />}
                            <span>{renderPathWithMatches(suggestion.path, suggestion.matches)}</span>
                          </button>
                        ))
                      : null}
                  </div>
                ) : null}
              </label>
              <label className="field">
                优先级
                <input type="number" min={0} max={5} value={form.priority} onChange={(event) => setForm({ ...form, priority: Number(event.target.value) })} />
              </label>
              <label className="field">
                标签
                <input placeholder="逗号或换行分隔" value={form.labels} onChange={(event) => setForm({ ...form, labels: event.target.value })} />
              </label>
            </div>

            <section className={`advanced-scope ${advancedScopeOpen ? "open" : ""}`}>
              <button className="advanced-toggle" type="button" onClick={() => setAdvancedScopeOpen((current) => !current)}>
                <span>
                  <ChevronDown size={17} />
                  高级范围
                </span>
                <small>可选 sparse scope paths</small>
              </button>
              {advancedScopeOpen ? (
                <label className="field">
                  稀疏范围路径
                  <textarea placeholder={"apps/web\npackages/shared/src"} value={form.scopePaths} onChange={(event) => setForm({ ...form, scopePaths: event.target.value })} />
                </label>
              ) : null}
            </section>

            <div className="modal-footer">
              <span>
                当前仓库策略：
                <b>{formRepository ? workspaceStrategyLabels[formRepository.workspaceStrategy] : "未选择仓库"}</b>
              </span>
              <div>
                <button className="pill-button" type="button" onClick={() => setActiveModal(null)}>
                  取消
                </button>
                <button className="primary-button" type="button" onClick={() => void submitTask()} disabled={!form.title.trim() || !form.repositoryId}>
                  <Plus size={17} />
                  创建任务
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {activeModal === "repositories" ? (
        <div className="modal-backdrop" role="presentation">
          <section className="dialog-modal repo-modal" role="dialog" aria-modal="true" aria-labelledby="repo-modal-title">
            <div className="modal-header">
              <div>
                <h2 id="repo-modal-title">仓库管理</h2>
                <p>配置本地仓库路径和默认 workspace 策略。</p>
              </div>
              <button className="icon-button" type="button" onClick={() => setActiveModal(null)} title="关闭">
                <X size={18} />
              </button>
            </div>

            <div className="repo-form">
              <input className="auto-field" placeholder="仓库名称" value={repositoryForm.name} readOnly title="从所选文件夹自动生成" />
              <button className="path-picker-button" type="button" onClick={() => void pickRepositoryDirectory()} disabled={selectingRepositoryDirectory}>
                <FolderOpen size={18} />
                <span>{repositoryForm.path || (selectingRepositoryDirectory ? "正在打开文件夹选择..." : "选择本地仓库文件夹")}</span>
              </button>
              <input className="auto-field" placeholder="基准分支" value={repositoryForm.baseBranch} readOnly title="从 Git 当前分支自动判断" />
              <select value={repositoryForm.workspaceStrategy} onChange={(event) => setRepositoryForm({ ...repositoryForm, workspaceStrategy: event.target.value as WorkspaceStrategy })}>
                {Object.entries(workspaceStrategyLabels).map(([value, label]) => (
                  <option value={value} key={value}>{label}</option>
                ))}
              </select>
              <button type="button" className="primary-button" onClick={() => void runAction(submitRepository)} disabled={!repositoryForm.name.trim() || !repositoryForm.path.trim()}>
                <Plus size={16} />
                添加仓库
              </button>
            </div>

            <div className="repo-list">
              {repositories.map((repository) => (
                <div className="repo-row" key={repository.id}>
                  <input value={repository.name} onChange={(event) => setRepositories(repositories.map((item) => item.id === repository.id ? { ...item, name: event.target.value } : item))} onBlur={() => void runAction(() => updateRepository(repository.id, { name: repository.name }))} />
                  <input value={repository.path} onChange={(event) => setRepositories(repositories.map((item) => item.id === repository.id ? { ...item, path: event.target.value } : item))} onBlur={() => void runAction(() => updateRepository(repository.id, { path: repository.path }))} />
                  <input value={repository.baseBranch} onChange={(event) => setRepositories(repositories.map((item) => item.id === repository.id ? { ...item, baseBranch: event.target.value } : item))} onBlur={() => void runAction(() => updateRepository(repository.id, { baseBranch: repository.baseBranch }))} />
                  <select value={repository.workspaceStrategy} onChange={(event) => void runAction(() => updateRepository(repository.id, { workspaceStrategy: event.target.value as WorkspaceStrategy }))}>
                    {Object.entries(workspaceStrategyLabels).map(([value, label]) => (
                      <option value={value} key={value}>{label}</option>
                    ))}
                  </select>
                  <button type="button" className="danger-button" title="删除仓库" onClick={() => void runAction(() => deleteRepository(repository.id))}>
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              {repositories.length === 0 ? <div className="empty-repo">还没有配置仓库</div> : null}
            </div>
          </section>
        </div>
      ) : null}

      {activeModal === "settings" ? (
        <div className="modal-backdrop" role="presentation">
          <section className="dialog-modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
            <div className="modal-header">
              <div>
                <h2 id="settings-modal-title">全局设置</h2>
                <p>这些配置对所有仓库共享。</p>
              </div>
              <button className="icon-button" type="button" onClick={() => setActiveModal(null)} title="关闭">
                <X size={18} />
              </button>
            </div>
            <div className="settings-form">
              <label className="field">
                工作区根目录
                <input value={settings.workspaceRoot} onChange={(event) => setSettings({ ...settings, workspaceRoot: event.target.value })} />
              </label>
              <label className="field">
                并发数
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={settings.maxConcurrentAgents}
                  onChange={(event) => setSettings({ ...settings, maxConcurrentAgents: Number(event.target.value) })}
                />
              </label>
            </div>
            <div className="modal-footer">
              <span>默认监听本机地址，不包含登录鉴权。</span>
              <div>
                <button className="pill-button" type="button" onClick={() => setActiveModal(null)}>
                  取消
                </button>
                <button type="button" className="primary-button" onClick={() => void persistSettings()} disabled={savingSettings}>
                  <Save size={16} />
                  保存
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function StatusIcon({ status, size = 16 }: { status: StatusFilter; size?: number }) {
  switch (status) {
    case "all":
      return <Inbox size={size} />;
    case "todo":
    case "queued":
      return <Clock3 size={size} />;
    case "preparing":
    case "running":
    case "finalizing":
      return <LoaderCircle size={size} />;
    case "human_review":
      return <AlertTriangle size={size} />;
    case "done":
      return <CheckCircle2 size={size} />;
    case "failed":
    case "cancelled":
      return <CircleStop size={size} />;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function completionStatusText(task: TaskWithLatestRun): string {
  if (task.status === "finalizing") {
    return "正在运行校验、提交、推送和 PR 创建。";
  }
  if (task.status === "human_review") {
    return task.completionError
      ? "上次交付失败，修复后可重新提交。"
      : "等待人工确认后自动提交、推送并创建 Ready PR。";
  }
  if (task.status === "done") {
    return "已完成自动交付。";
  }
  return "仅待人工确认的任务会触发自动交付。";
}

function countTasksByStatus(tasks: TaskWithLatestRun[], status: StatusFilter): number {
  if (status === "all") {
    return tasks.length;
  }
  return tasks.filter((task) => task.status === status).length;
}

function latestRunText(task: TaskWithLatestRun): string {
  if (!task.latestRun) {
    return "尚未运行";
  }
  if (task.latestRun.error) {
    return task.latestRun.error;
  }
  if (task.latestRun.summary) {
    return task.latestRun.summary;
  }
  const strategy = task.latestRun.workspaceStrategy
    ? ` · ${workspaceStrategyLabels[task.latestRun.workspaceStrategy]}`
    : "";
  return `${runStatusLabels[task.latestRun.status]}${strategy}`;
}

function formatShortDate(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function findPathMention(
  value: string,
  caret: number
): { start: number; end: number; query: string } | null {
  const beforeCaret = value.slice(0, caret);
  const start = beforeCaret.lastIndexOf("@");
  if (start === -1) {
    return null;
  }
  if (start > 0 && !/\s/.test(value[start - 1] ?? "")) {
    return null;
  }

  const query = beforeCaret.slice(start + 1);
  if (/[\s"'`]/.test(query)) {
    return null;
  }

  return { start, end: caret, query };
}

function renderPathWithMatches(path: string, matches: number[]) {
  const highlighted = new Set(matches);
  return path.split("").map((character, index) =>
    highlighted.has(index) ? (
      <mark key={`${character}-${index}`}>{character}</mark>
    ) : (
      character
    )
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
