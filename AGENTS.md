# AGENTS.md

## 项目规则
- UI的变更需要通过e2e测试进行验收
- UI界面使用中文
- 当代码变更影响系统架构、模块职责、API 契约、配置项、日志/可观测性、任务状态流、AI Advisor/Git Finalizer 边界或数据持久化结构时，必须在同一变更中同步更新 `README.md` 或 `docs/architecture.md`；若判断无需更新，需在总结中说明原因。

## 任务边界设计

- `Codex turn` 是唯一的代码执行 agent：负责读取真实代码、调试、修改文件、运行必要命令、总结改动和风险。
- `AiAdvisor` 只做轻量 server-side 建议：workspace strategy、摘要、commit/PR 文案草稿、scope/标签/验收候选提取。它不读写仓库，不执行命令，不操作 Git。
- `Git Finalizer` 是确定性后端状态机：负责校验、暂存、提交、推送、创建 Ready PR 和清理任务 worktree。失败必须记录到任务和运行事件中，不能让 AI 即兴接管。
- `Web UI` 只负责发起动作、展示状态和错误；不得持有 AI key，不得在前端拼接 Git 命令或直接调用通用 AI。

明确禁止：

- 不要让通用 AI 执行 `git add` / `commit` / `push` / `gh pr create` / worktree 清理。
- 不要让 AI 决定跳过失败的校验命令。
- 不要把 `SYMPHONY_LLM_API_KEY` 暴露到前端、任务内容、运行日志或 SQLite 普通业务字段中。
- 不要让 finalizer 启动新的 Codex turn；finalizer 只能消费已完成 run 的结果和可选文案草稿。
