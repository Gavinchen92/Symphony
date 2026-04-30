import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  CreateRepositoryInputSchema,
  CreateTaskInputSchema,
  SettingsSchema,
  TaskStatusSchema,
  UpdateRepositoryInputSchema,
  UpdateTaskInputSchema
} from "@symphony/shared";
import type { SymphonyDb } from "./db";
import type { EventBus } from "./events";
import type { TaskFinalizer } from "./finalizer";
import type { Orchestrator } from "./orchestrator";
import { listRepositoryPathSuggestions, selectRepositoryDirectory } from "./repositoryDiscovery";

type AppDeps = {
  db: SymphonyDb;
  orchestrator: Orchestrator;
  finalizer: TaskFinalizer;
  eventBus: EventBus;
  webDistDir: string;
};

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "http://127.0.0.1:5173",
  "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type"
};

export function createHttpApp(deps: AppDeps) {
  return createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, jsonHeaders).end();
        return;
      }

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url, deps);
        return;
      }

      await serveStatic(res, deps.webDistDir, url.pathname);
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : "服务内部错误"
      });
    }
  });
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  { db, orchestrator, finalizer, eventBus }: AppDeps
) {
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/system/select-repository-directory") {
    sendJson(res, 200, await selectRepositoryDirectory());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    sendJson(res, 200, db.getSettings());
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/settings") {
    const input = SettingsSchema.parse(await readJson(req));
    sendJson(res, 200, db.saveSettings(input));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/repositories") {
    sendJson(res, 200, db.listRepositories());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/repositories") {
    const input = CreateRepositoryInputSchema.parse(await readJson(req));
    sendJson(res, 201, db.createRepository(input));
    return;
  }

  if (parts[1] === "repositories" && parts[2]) {
    const repositoryId = parts[2];

    if (req.method === "PATCH" && parts.length === 3) {
      const input = UpdateRepositoryInputSchema.parse(await readJson(req));
      sendJson(res, 200, db.updateRepository(repositoryId, input));
      return;
    }

    if (req.method === "DELETE" && parts.length === 3) {
      db.deleteRepository(repositoryId);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && parts[3] === "path-suggestions") {
      const repository = db.getRepository(repositoryId);
      const query = url.searchParams.get("q") ?? "";
      sendJson(res, 200, await listRepositoryPathSuggestions(repository.path, query));
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/tasks") {
    sendJson(res, 200, db.listTasksWithLatestRun());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tasks") {
    const input = CreateTaskInputSchema.parse(await readJson(req));
    sendJson(res, 201, db.createTask(input));
    return;
  }

  if (parts[1] === "tasks" && parts[2]) {
    const taskId = parts[2];

    if (req.method === "GET" && parts.length === 3) {
      sendJson(res, 200, db.getTaskDetail(taskId));
      return;
    }

    if (req.method === "PATCH" && parts.length === 3) {
      const input = UpdateTaskInputSchema.parse(await readJson(req));
      sendJson(res, 200, db.updateTask(taskId, input));
      return;
    }

    if (req.method === "POST" && parts[3] === "dispatch") {
      const run = orchestrator.dispatch(taskId);
      sendJson(res, 202, run);
      return;
    }

    if (req.method === "POST" && parts[3] === "cancel") {
      sendJson(res, 200, orchestrator.cancelTask(taskId));
      return;
    }

    if (req.method === "POST" && parts[3] === "mark-done") {
      sendJson(res, 202, finalizer.finalize(taskId));
      return;
    }

    if (req.method === "POST" && parts[3] === "finalize") {
      sendJson(res, 202, finalizer.finalize(taskId));
      return;
    }

    if (req.method === "POST" && parts[3] === "status") {
      const rawInput = await readJson(req);
      const status =
        rawInput && typeof rawInput === "object"
          ? (rawInput as { status?: unknown }).status
          : undefined;
      const input = TaskStatusSchema.parse(status);
      sendJson(res, 200, db.updateTaskStatus(taskId, input));
      return;
    }
  }

  if (parts[1] === "runs" && parts[2] && parts[3] === "events") {
    const runId = parts[2];

    if (req.method === "GET" && parts.length === 4) {
      sendJson(res, 200, db.listRunEvents(runId));
      return;
    }

    if (req.method === "GET" && parts[4] === "stream") {
      streamRunEvents(res, runId, db, eventBus);
      return;
    }
  }

  sendJson(res, 404, { error: "未找到资源" });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(payload));
}

function streamRunEvents(
  res: ServerResponse,
  runId: string,
  db: SymphonyDb,
  eventBus: EventBus
): void {
  res.writeHead(200, {
    ...jsonHeaders,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });

  for (const event of db.listRunEvents(runId)) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const unsubscribe = eventBus.onRunEvent((event) => {
    if (event.runId === runId) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  });

  res.on("close", unsubscribe);
}

async function serveStatic(
  res: ServerResponse,
  webDistDir: string,
  pathname: string
): Promise<void> {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(webDistDir, safePath.replace(/^\/+/, ""));
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "content-type": mimeType(filePath) });
    res.end(content);
  } catch {
    try {
      const content = await readFile(join(webDistDir, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(content);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("未找到前端构建产物");
    }
  }
}

function mimeType(filePath: string): string {
  switch (extname(filePath)) {
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
