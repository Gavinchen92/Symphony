# Symphony 架构说明

这份文档是 Symphony 的架构真值源。`README.md` 负责项目入口和启动信息，`AGENTS.md` 只记录 agent 执行规则；涉及模块职责、接口契约、配置、日志、任务状态流、AI Advisor/Git Finalizer 边界或持久化结构的代码变更，都要同步检查这份文档。

## 运行边界

Symphony Local Runner 是本地 coding-agent 工作队列。V1 不接 Linear，任务、运行记录、运行事件和设置都存在本地 SQLite 中，前端通过本地 Web 面板管理。

核心模块分工如下：

- Web UI：只负责发起动作、展示状态和错误。前端不得持有 AI key，不拼接 Git 命令，不直接调用通用 AI。
- Fastify API：负责 HTTP transport、CORS、JSON body、请求校验入口、错误分层、结构化 request log、静态资源和 SSE。它不替代业务状态机，也不替代 DB 查询层。
- Orchestrator：负责任务派发、并发队列、workspace 准备和 Codex turn 生命周期。
- AiAdvisor：只做轻量 server-side 建议，比如 workspace strategy、提交/PR 文案草稿。它不读写仓库，不执行命令，不操作 Git。
- Git Finalizer：确定性后端状态机，负责校验、暂存、提交、推送、创建 Ready PR 和清理任务 worktree。失败必须写回任务和运行事件。
- SystemMonitor：确定性系统错误监控器，捕获 Symphony 自身未处理 500、进程级未处理异常和基础设施失败，按指纹去重后创建修复任务。它不执行修复、不派发任务、不操作 Git。
- SymphonyDb：SQLite 持久化边界，集中维护表结构、查询、状态转换和 row mapping。路由层不得绕过它直接写 SQL。
- EventBus：进程内运行事件广播，用于把新 `run_events` 推给 SSE 订阅者。

## HTTP 与 API

后端入口使用 Fastify，当前 API 路径保持 `/api/*`：

- `GET /api/health`
- `GET|PUT /api/settings`
- `GET|POST /api/repositories`
- `PATCH|DELETE /api/repositories/:repositoryId`
- `GET /api/repositories/:repositoryId/path-suggestions`
- `GET|POST /api/tasks`
- `GET|PATCH /api/tasks/:taskId`
- `POST /api/tasks/:taskId/dispatch`
- `POST /api/tasks/:taskId/cancel`
- `POST /api/tasks/:taskId/mark-done`
- `POST /api/tasks/:taskId/finalize`
- `POST /api/tasks/:taskId/status`
- `GET /api/runs/:runId/events`
- `GET /api/runs/:runId/events/stream`

请求和响应契约以 `packages/shared` 里的 Zod schema 为准。Fastify 只负责接收请求和统一错误返回；业务输入仍在 handler 边界用 shared schema 解析。

任务列表和任务创建响应保持同一列表项 DTO：`GET /api/tasks` 返回 `TaskWithLatestRun[]`，`POST /api/tasks` 返回 `TaskWithLatestRun`。其中 `repository` 和 `latestRun` 必须显式返回对象或 `null`；新建任务尚未派发时 `latestRun` 为 `null`。

错误返回保持稳定：

- 输入解析或 Zod 校验失败：`400 { "error": "请求参数不合法" }`
- 未匹配的 API：`404 { "error": "未找到资源" }`
- 未处理异常：`500 { "error": "服务内部错误" }`

真实异常只进入服务端日志，不直接暴露给前端。

## 持久化与状态

本地 SQLite 默认路径是 `data/symphony.sqlite`。数据库表由 `SymphonyDb` 维护：

- `app_settings`：本地运行设置。
- `repositories`：可派发任务的仓库配置。
- `tasks`：任务本体、状态和交付结果。
- `runs`：一次 Codex turn 的运行记录。
- `run_events`：前端可见的运行事件流。
- `system_error_incidents`：系统错误指纹、发生次数、关联自修复任务和最近安全摘要。

`SymphonyDb` 继续使用手写 SQL。引入 Fastify 不代表引入 ORM，也不代表把查询写到 route handler 里。

任务状态转换以 shared 包里的状态表为准。Orchestrator 和 Git Finalizer 只能通过 `SymphonyDb` 更新任务与运行记录，不能绕过状态转换规则。

## 系统错误自监控

SystemMonitor 只监控 Symphony 自身系统错误。当前纳入范围：

- Fastify error handler 中未被业务层稳定处理的 500。
- `unhandledRejection` 和 `uncaughtExceptionMonitor` 进程级错误。
- Orchestrator 在 Codex turn 启动前的准备、策略和 workspace 基础设施失败。
- Git Finalizer 中非校验、非提交/推送/PR 命令类的意外基础设施失败。

以下不属于系统自监控范围：普通任务失败、Codex turn 失败、校验失败、没有可提交改动、提交/推送/PR 创建失败。这些继续通过原有 task/run/finalizer 状态展示给用户。

监控器发现错误后读取 `settings.selfMonitor`。关闭时不创建任务；开启时用错误来源、错误类型和稳定栈帧生成指纹。同一指纹在冷却期内，或已有未关闭修复任务时，只更新 `system_error_incidents` 的发生次数和最近摘要；冷却期后且原任务已关闭，才创建新任务。

自修复任务固定绑定当前 Symphony `projectRoot` 对应的仓库记录，默认优先级为 4，标签为 `system-monitor` 和 `auto-created`，状态为 `todo`，不会自动派发。真正修复仍必须由用户派发后进入 Codex turn。

## 日志与可观测性

系统有两类日志，职责不同：

- `run_events`：存在 SQLite 中，是前端展示给用户看的任务运行事件，支持历史查询和 SSE 实时推送。
- `data/logs/server.jsonl`：服务端结构化日志，用于调试、审计和排障。

服务日志记录 request 生命周期，包括 `requestId`、method、url、statusCode 和 responseTime。后台任务相关日志必须带上 `runId`，能拿到任务时也要带 `taskId`。

日志不能记录 request body、AI key、authorization、cookie 或完整敏感 payload。`SYMPHONY_LLM_API_KEY` 只能存在服务端运行环境里，不得进入前端、任务内容、运行日志或 SQLite 普通业务字段。

相关配置：

- `SYMPHONY_LOG_LEVEL`：服务日志级别，默认 `info`。
- `SYMPHONY_LOG_DIR`：服务日志目录，默认 `${SYMPHONY_DATA_DIR}/logs`，未设置 `SYMPHONY_DATA_DIR` 时为 `data/logs`。
- `settings.selfMonitor.enabled`：是否启用系统错误自监控，默认 `true`。
- `settings.selfMonitor.cooldownMinutes`：同一错误指纹重复建任务的冷却分钟数，默认 `30`。

## 文档分层

- `README.md`：项目入口。只放项目是什么、怎么启动、主要能力、本地数据和关键文档链接。
- `docs/architecture.md`：架构真值源。记录模块职责、运行边界、接口与日志原则。
- `AGENTS.md`：agent 执行规则。只放会影响 agent 行为的约束，不承载长篇架构说明。

如果代码改变了架构事实，优先更新 `docs/architecture.md`；如果改变了启动方式或使用入口，同时更新 `README.md`；如果改变了 agent 执行约束，才更新 `AGENTS.md`。
