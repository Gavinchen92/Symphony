import { z } from "zod";
import { ResolvedWorkspaceStrategySchema, type Repository, type Run, type Task } from "@symphony/shared";
import type { LlmRuntimeConfig } from "./config";

const ConventionalCommitTypeSchema = z.enum([
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "test",
  "chore"
]);

const WorkspaceStrategyAdviceSchema = z.object({
  strategy: ResolvedWorkspaceStrategySchema,
  reason: z.string().trim().min(1),
  suggestedSparsePaths: z.array(z.string().trim().min(1)).default([])
});

const CompletionDraftSchema = z.object({
  commitType: ConventionalCommitTypeSchema,
  scope: z.string().trim().min(1).nullable().default(null),
  subject: z.string().trim().min(1),
  body: z.string().trim().min(1),
  prTitle: z.string().trim().min(1),
  prBody: z.string().trim().min(1)
});

const TaskTitleSuggestionSchema = z.object({
  title: z.string().trim().min(1)
});

const ChatCompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable()
        })
      })
    )
    .min(1)
});

export type WorkspaceStrategyAdvice = z.infer<typeof WorkspaceStrategyAdviceSchema>;
export type CompletionDraft = z.infer<typeof CompletionDraftSchema>;

export type TaskTitleInput = {
  task: Task;
  repository: Repository;
};

export type CompletionDraftInput = {
  task: Task;
  repository: Repository;
  run: Run;
  changedFiles: string[];
  verificationCommands: string[];
};

export type AiAdvisor = {
  generateTaskTitle(input: TaskTitleInput): Promise<string | null>;
  selectWorkspaceStrategy(input: { task: Task; repository: Repository }): Promise<WorkspaceStrategyAdvice | null>;
  draftCompletion(input: CompletionDraftInput): Promise<CompletionDraft | null>;
};

export class DisabledAiAdvisor implements AiAdvisor {
  async generateTaskTitle(): Promise<string | null> {
    return null;
  }

  async selectWorkspaceStrategy(): Promise<WorkspaceStrategyAdvice | null> {
    return null;
  }

  async draftCompletion(): Promise<CompletionDraft | null> {
    return null;
  }
}

export class OpenAiCompatibleAdvisor implements AiAdvisor {
  constructor(private readonly config: LlmRuntimeConfig) {}

  async generateTaskTitle(input: TaskTitleInput): Promise<string | null> {
    const content = await this.completeJson({
      purpose: "task title",
      prompt: [
        "请为本地 coding-agent 任务生成一个简短中文标题，只返回 JSON。",
        "你只能生成标题文案，不能执行命令，不能读取本地文件，不能操作 Git。",
        "",
        `仓库：${input.repository.name}`,
        `任务编号：${input.task.key}`,
        `优先级：${input.task.priority}`,
        `标签：${input.task.labels.join(", ") || "(无)"}`,
        `scopePaths：${input.task.scopePaths.join(", ") || "(无)"}`,
        "任务描述：",
        input.task.description || "(无描述)",
        "",
        "标题要求：",
        "- 中文，8 到 24 个字左右",
        "- 使用动宾短语或问题短句",
        "- 不包含任务编号、仓库路径、引号或句号",
        "- 不要使用“任务标题”“新建任务”等泛化占位词",
        "",
        "返回格式：",
        '{"title":"中文标题"}'
      ].join("\n")
    });
    if (!content) {
      return null;
    }
    const parsed = TaskTitleSuggestionSchema.safeParse(content);
    if (!parsed.success) {
      return null;
    }
    return normalizeGeneratedTitle(parsed.data.title);
  }

  async selectWorkspaceStrategy(input: {
    task: Task;
    repository: Repository;
  }): Promise<WorkspaceStrategyAdvice | null> {
    const content = await this.completeJson({
      purpose: "workspace strategy",
      prompt: [
        "请为本地 coding agent 任务选择 workspace 策略，只返回 JSON。",
        "你只能做轻量策略建议，不能要求执行命令，不能读取本地文件，不能操作 Git。",
        "",
        `仓库：${input.repository.name}`,
        `仓库路径：${input.repository.path}`,
        `默认基准分支：${input.repository.baseBranch}`,
        `任务：${input.task.key} ${input.task.title}`,
        "描述：",
        input.task.description || "(无描述)",
        `scopePaths：${input.task.scopePaths.join(", ") || "(无)"}`,
        "",
        "返回格式：",
        '{"strategy":"sparse-worktree|full","reason":"中文原因","suggestedSparsePaths":["相对路径"]}'
      ].join("\n")
    });
    if (!content) {
      return null;
    }
    const parsed = WorkspaceStrategyAdviceSchema.safeParse(content);
    return parsed.success ? parsed.data : null;
  }

  async draftCompletion(input: CompletionDraftInput): Promise<CompletionDraft | null> {
    const content = await this.completeJson({
      purpose: "completion draft",
      prompt: [
        "请为本地 coding agent 任务生成 commit message 和 GitHub PR 文案草稿，只返回 JSON。",
        "你只能生成文案，不能决定是否跳过校验，不能操作 Git，不能清理工作区。",
        "",
        `仓库：${input.repository.name}`,
        `基准分支：${input.repository.baseBranch}`,
        `任务：${input.task.key} ${input.task.title}`,
        "任务描述：",
        input.task.description || "(无描述)",
        "运行摘要：",
        input.run.summary ?? "(无摘要)",
        `变更文件：${input.changedFiles.join(", ") || "(无)"}`,
        `已通过验证：${input.verificationCommands.join(", ") || "(未配置)"}`,
        "",
        "返回格式：",
        [
          "{",
          '"commitType":"feat|fix|docs|style|refactor|test|chore",',
          '"scope":"可为空字符串或 null",',
          '"subject":"中文摘要，不包含 type(scope): 前缀",',
          '"body":"commit body",',
          '"prTitle":"PR 标题",',
          '"prBody":"PR 正文"',
          "}"
        ].join("")
      ].join("\n")
    });
    if (!content) {
      return null;
    }
    const parsed = CompletionDraftSchema.safeParse(content);
    return parsed.success ? parsed.data : null;
  }

  private async completeJson(input: { purpose: string; prompt: string }): Promise<unknown | null> {
    if (!this.config.enabled || !this.config.apiKey || !this.config.model) {
      return null;
    }

    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "你是 Symphony 的 server-side AI advisor。只返回 JSON；不执行命令；不操作 Git；不读写文件。"
            },
            { role: "user", content: input.prompt }
          ]
        })
      });

      if (!response.ok) {
        return null;
      }

      const parsedResponse = ChatCompletionResponseSchema.safeParse(await response.json());
      if (!parsedResponse.success) {
        return null;
      }
      const content = parsedResponse.data.choices[0]?.message.content;
      return content ? parseJsonObject(content) : null;
    } catch {
      return null;
    }
  }
}

export function createAiAdvisor(config: LlmRuntimeConfig): AiAdvisor {
  if (!config.enabled) {
    return new DisabledAiAdvisor();
  }
  return new OpenAiCompatibleAdvisor(config);
}

function parseJsonObject(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeGeneratedTitle(title: string): string | null {
  const withoutWrappingQuotes = title
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[《「『“"']+/, "")
    .replace(/[》」』”"']+$/, "")
    .trim()
    .replace(/[。.!！?？]+$/u, "")
    .trim();

  if (!withoutWrappingQuotes) {
    return null;
  }

  return withoutWrappingQuotes.length > 36
    ? withoutWrappingQuotes.slice(0, 36)
    : withoutWrappingQuotes;
}
