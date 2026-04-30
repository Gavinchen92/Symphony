import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino, { destination, multistream, type Logger } from "pino";

export type LogRuntimeConfig = {
  level: string;
  dir: string;
  stdout: boolean;
};

export type ServiceLogger = {
  logger: Logger;
  logFilePath: string;
  close: () => void;
};

const logLevels = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;

export function normalizeLogLevel(value: string | undefined): string {
  const level = value?.trim().toLowerCase();
  if (!level) {
    return "info";
  }
  return logLevels.some((candidate) => candidate === level) ? level : "info";
}

export function createServiceLogger(config: LogRuntimeConfig): ServiceLogger {
  mkdirSync(config.dir, { recursive: true });
  const logFilePath = join(config.dir, "server.jsonl");
  const fileDestination = destination({ dest: logFilePath, sync: false, mkdir: true });
  const stream = config.stdout
    ? multistream([{ stream: fileDestination }, { stream: process.stdout }])
    : fileDestination;
  const logger = pino(
    {
      level: normalizeLogLevel(config.level),
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        censor: "[redacted]",
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "request.headers.authorization",
          "request.headers.cookie",
          "headers.authorization",
          "headers.cookie",
          "authorization",
          "cookie",
          "apiKey",
          "*.apiKey",
          "llm.apiKey",
          "SYMPHONY_LLM_API_KEY"
        ]
      }
    },
    stream
  );

  let closed = false;
  return {
    logger,
    logFilePath,
    close() {
      if (closed) {
        return;
      }
      closed = true;
      try {
        stream.flushSync?.();
        fileDestination.flushSync();
      } catch {
        // 测试中的小型 app 可能在 SonicBoom 打开完成前就关闭。
      }
      try {
        fileDestination.end();
      } catch {
        // 进程退出时日志关闭只做尽力清理。
      }
    }
  };
}
