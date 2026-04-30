# Symphony Local Runner

Symphony Local Runner 是一个本地 coding-agent 工作队列。它参考 OpenAI Symphony 的调度边界，但 V1 不接 Linear：任务、运行记录、日志、设置都存储在本地 SQLite 中，并通过一个 React 面板管理。

## V1 能力

- 本地 Web 队列：创建任务、调整状态、派发运行、查看日志。
- 任务标题自动生成：新建任务只填写任务内容，服务端 AI 根据内容生成标题。
- 单仓库配置：绑定一个目标 monorepo。
- `sparse-worktree` workspace：每个任务一个独立 git worktree，并启用 sparse-checkout。
- Codex app-server adapter：每次 run 启动一个 Codex app-server 会话，事件写入 DB 并流式推给前端。
- 系统错误自监控：捕获 Symphony 自身系统错误，按指纹去重后自动创建待派发的修复任务。

## 架构与运行边界

系统架构、模块职责和日志边界见 [docs/architecture.md](docs/architecture.md)。

## 常用命令

```bash
pnpm install
pnpm dev
pnpm test
pnpm build
pnpm test:e2e
```

默认服务地址：

- API: `http://127.0.0.1:4317`
- Web: `http://127.0.0.1:5173`

## 本地数据

- SQLite: `data/symphony.sqlite`
- 服务端结构化日志: `data/logs/server.jsonl`
- 系统错误记录表: `system_error_incidents`
- Workspaces: `.workspaces/<task-key>`

SQLite 里的 `run_events` 是前端可见的任务运行事件流，`server.jsonl` 是服务端调试和审计日志。`data/` 和 `.workspaces/` 默认不会进入 Git。

系统错误自监控可在 Web 面板的“设置”里开关，并可配置重复错误冷却时间。监控器只创建 `todo` 修复任务，不自动派发、不提交、不推送。
