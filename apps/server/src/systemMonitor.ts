import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { Logger } from "pino";
import type { SystemErrorRecordResult, SymphonyDb } from "./db";

export type SystemErrorSource = "fastify" | "process" | "orchestrator" | "finalizer";

export type ReportSystemErrorInput = {
  source: SystemErrorSource;
  error: unknown;
  context?: Record<string, unknown>;
  now?: Date;
};

export type SystemMonitorDeps = {
  db: SymphonyDb;
  projectRoot: string;
  logger: Logger;
};

const blockedContextKeys = new Set([
  "authorization",
  "body",
  "cookie",
  "headers",
  "password",
  "payload",
  "requestBody",
  "secret",
  "token"
]);

export class SystemMonitor {
  private readonly projectRoot: string;
  private readonly repository: {
    name: string;
    path: string;
    baseBranch: string;
    workspaceStrategy: "full";
  };
  private readonly processListeners: Array<() => void> = [];

  constructor(private readonly deps: SystemMonitorDeps) {
    this.projectRoot = resolve(deps.projectRoot);
    this.repository = {
      name: "Symphony",
      path: this.projectRoot,
      baseBranch: currentGitBranch(this.projectRoot) ?? "main",
      workspaceStrategy: "full"
    };
  }

  report(input: ReportSystemErrorInput): SystemErrorRecordResult | null {
    try {
      const settings = this.deps.db.getSettings();
      if (!settings.selfMonitor.enabled) {
        return null;
      }

      const normalized = normalizeError(input.error);
      const safeContext = sanitizeContext(input.context ?? {});
      const fingerprint = fingerprintError(input.source, normalized);
      const summary = buildSummary(input.source, normalized);
      const result = this.deps.db.recordSystemErrorIncident({
        fingerprint,
        source: input.source,
        title: buildTaskTitle(summary),
        description: buildTaskDescription({
          source: input.source,
          fingerprint,
          summary,
          error: normalized,
          context: safeContext
        }),
        summary,
        repository: this.repository,
        cooldownMinutes: settings.selfMonitor.cooldownMinutes,
        ...(input.now ? { now: input.now } : {})
      });

      this.deps.logger.warn(
        {
          source: input.source,
          fingerprint,
          taskId: result.task?.id ?? null,
          createdTask: result.createdTask,
          occurrences: result.incident.occurrences
        },
        "system_error_incident_recorded"
      );
      return result;
    } catch (error) {
      this.deps.logger.error({ err: error }, "system_monitor_failed");
      return null;
    }
  }

  startProcessListeners(): void {
    if (this.processListeners.length > 0) {
      return;
    }

    const onUnhandledRejection = (reason: unknown) => {
      this.report({
        source: "process",
        error: reason,
        context: { event: "unhandledRejection" }
      });
    };
    const onUncaughtExceptionMonitor = (error: Error, origin: string) => {
      this.report({
        source: "process",
        error,
        context: { event: "uncaughtExceptionMonitor", origin }
      });
    };

    process.on("unhandledRejection", onUnhandledRejection);
    process.on("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);
    this.processListeners.push(() => process.off("unhandledRejection", onUnhandledRejection));
    this.processListeners.push(() =>
      process.off("uncaughtExceptionMonitor", onUncaughtExceptionMonitor)
    );
  }

  stop(): void {
    for (const unsubscribe of this.processListeners.splice(0)) {
      unsubscribe();
    }
  }
}

type NormalizedError = {
  name: string;
  message: string;
  stackFrame: string | null;
};

function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    return {
      name: sanitizeText(error.name || "Error"),
      message: sanitizeText(error.message || "未知错误"),
      stackFrame: firstStackFrame(error.stack)
    };
  }

  return {
    name: "NonError",
    message: sanitizeText(typeof error === "string" ? error : stringifyUnknown(error)),
    stackFrame: null
  };
}

function fingerprintError(source: SystemErrorSource, error: NormalizedError): string {
  const raw = [source, error.name, error.stackFrame ?? error.message].join("\n");
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function buildSummary(source: SystemErrorSource, error: NormalizedError): string {
  return limitText(`${source}: ${error.name}: ${error.message}`, 180);
}

function buildTaskTitle(summary: string): string {
  return limitText(`修复 Symphony 系统错误：${summary}`, 80);
}

function buildTaskDescription(input: {
  source: SystemErrorSource;
  fingerprint: string;
  summary: string;
  error: NormalizedError;
  context: Record<string, string | number | boolean | null>;
}): string {
  const contextLines = Object.entries(input.context)
    .map(([key, value]) => `- ${key}: ${String(value)}`)
    .join("\n");
  return [
    "系统错误自监控自动创建了这个修复任务。",
    "",
    "## 错误摘要",
    `- 来源：${input.source}`,
    `- 指纹：${input.fingerprint}`,
    `- 摘要：${input.summary}`,
    `- 错误类型：${input.error.name}`,
    `- 错误信息：${input.error.message}`,
    input.error.stackFrame ? `- 栈位置：${input.error.stackFrame}` : null,
    contextLines ? "" : null,
    contextLines ? "## 安全上下文" : null,
    contextLines || null,
    "",
    "## 修复要求",
    "- 先基于真实代码、日志和复现路径定位根因。",
    "- 只修复 Symphony 自身系统错误，不扩大到普通任务失败。",
    "- 不要把 API key、请求 body、authorization、cookie 或完整敏感 payload 写入任务、日志或前端。"
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function sanitizeContext(input: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const entries = Object.entries(input)
    .filter(([key]) => !blockedContextKeys.has(key.trim().toLowerCase()))
    .map(([key, value]) => [key, sanitizeContextValue(value)] as const)
    .filter((entry): entry is readonly [string, string | number | boolean | null] => entry[1] !== undefined);
  return Object.fromEntries(entries);
}

function sanitizeContextValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return limitText(sanitizeText(value), 240);
  }
  return undefined;
}

function sanitizeText(value: string | undefined): string {
  return limitText(
    (value || "未知错误")
      .replace(/(authorization|cookie|api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
      .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]")
      .replace(/\s+/g, " ")
      .trim(),
    800
  );
}

function firstStackFrame(stack: string | undefined): string | null {
  const frame = stack
    ?.split("\n")
    .slice(1)
    .map((line) => sanitizeText(line))
    .find(Boolean);
  return frame ? limitText(frame, 240) : null;
}

function currentGitBranch(cwd: string): string | null {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

function stringifyUnknown(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function limitText(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) {
    return value;
  }
  return `${characters.slice(0, Math.max(1, maxLength - 3)).join("")}...`;
}
