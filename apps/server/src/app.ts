import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import {
  CreateRepositoryInputSchema,
  CreateTaskInputSchema,
  SettingsSchema,
  TaskStatusSchema,
  UpdateRepositoryInputSchema,
  UpdateTaskInputSchema
} from "@symphony/shared";
import { ZodError, z } from "zod";
import type { SymphonyDb } from "./db";
import type { EventBus } from "./events";
import type { TaskFinalizer } from "./finalizer";
import type { Orchestrator } from "./orchestrator";
import { listRepositoryPathSuggestions, selectRepositoryDirectory } from "./repositoryDiscovery";

type AppDeps = {
  db: SymphonyDb;
  orchestrator: Pick<Orchestrator, "dispatch" | "cancelTask">;
  finalizer: Pick<TaskFinalizer, "finalize">;
  eventBus: EventBus;
  webDistDir: string;
  logger: FastifyBaseLogger;
  closeLogger?: () => void;
};

declare module "fastify" {
  interface FastifyInstance {
    symphonyDb: SymphonyDb;
    symphonyOrchestrator: Pick<Orchestrator, "dispatch" | "cancelTask">;
    symphonyFinalizer: Pick<TaskFinalizer, "finalize">;
    symphonyEventBus: EventBus;
  }
}

const corsOrigin = "http://127.0.0.1:5173";
const corsMethods = ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] as const;
const corsHeaders = {
  "access-control-allow-origin": corsOrigin,
  "access-control-allow-methods": corsMethods.join(","),
  "access-control-allow-headers": "content-type"
};

const RepositoryParamsSchema = z.object({ repositoryId: z.string().min(1) });
const TaskParamsSchema = z.object({ taskId: z.string().min(1) });
const RunParamsSchema = z.object({ runId: z.string().min(1) });
const PathSuggestionsQuerySchema = z.object({ q: z.string().optional() });
const TaskStatusBodySchema = z.object({ status: TaskStatusSchema });

export async function createFastifyApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = fastify({
    loggerInstance: deps.logger,
    disableRequestLogging: true,
    requestIdHeader: false,
    genReqId: () => randomUUID()
  });

  app.decorate("symphonyDb", deps.db);
  app.decorate("symphonyOrchestrator", deps.orchestrator);
  app.decorate("symphonyFinalizer", deps.finalizer);
  app.decorate("symphonyEventBus", deps.eventBus);

  app.addHook("onClose", () => {
    deps.db.close();
    deps.closeLogger?.();
  });

  app.addHook("onRequest", (request, _reply, done) => {
    request.log.info(
      { requestId: request.id, method: request.method, url: request.url },
      "request_started"
    );
    done();
  });

  app.addHook("onResponse", (request, reply, done) => {
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime
      },
      "request_completed"
    );
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    if (isZodError(error)) {
      request.log.warn({ err: error, requestId: request.id }, "request_validation_failed");
      void reply.code(400).send({ error: "请求参数不合法" });
      return;
    }

    const statusCode = statusCodeOf(error);
    if (statusCode === 400) {
      request.log.warn({ err: error, requestId: request.id }, "request_parse_failed");
      void reply.code(400).send({ error: "请求参数不合法" });
      return;
    }

    request.log.error({ err: error, requestId: request.id }, "request_failed");
    void reply.code(500).send({ error: "服务内部错误" });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      void reply.code(404).send({ error: "未找到资源" });
      return;
    }

    sendSpaFallback(reply, deps.webDistDir);
  });

  await app.register(cors, {
    origin: corsOrigin,
    methods: [...corsMethods],
    allowedHeaders: ["content-type"]
  });

  registerApiRoutes(app);
  await registerStaticRoutes(app, deps.webDistDir);

  return app;
}

function statusCodeOf(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("statusCode" in error)) {
    return null;
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : null;
}

function isZodError(error: unknown): error is ZodError {
  if (!error || typeof error !== "object") {
    return false;
  }
  return error instanceof ZodError || ("issues" in error && Array.isArray(error.issues));
}

function registerApiRoutes(app: FastifyInstance): void {
  app.get("/api/health", async () => ({ ok: true }));

  app.post("/api/system/select-repository-directory", async () => selectRepositoryDirectory());

  app.get("/api/settings", async () => app.symphonyDb.getSettings());

  app.put("/api/settings", async (request) => {
    const input = SettingsSchema.parse(request.body);
    return app.symphonyDb.saveSettings(input);
  });

  app.get("/api/repositories", async () => app.symphonyDb.listRepositories());

  app.post("/api/repositories", async (request, reply) => {
    const input = CreateRepositoryInputSchema.parse(request.body);
    void reply.code(201);
    return app.symphonyDb.createRepository(input);
  });

  app.patch("/api/repositories/:repositoryId", async (request) => {
    const { repositoryId } = RepositoryParamsSchema.parse(request.params);
    const input = UpdateRepositoryInputSchema.parse(request.body);
    return app.symphonyDb.updateRepository(repositoryId, input);
  });

  app.delete("/api/repositories/:repositoryId", async (request) => {
    const { repositoryId } = RepositoryParamsSchema.parse(request.params);
    app.symphonyDb.deleteRepository(repositoryId);
    return { ok: true };
  });

  app.get("/api/repositories/:repositoryId/path-suggestions", async (request) => {
    const { repositoryId } = RepositoryParamsSchema.parse(request.params);
    const { q } = PathSuggestionsQuerySchema.parse(request.query);
    const repository = app.symphonyDb.getRepository(repositoryId);
    return listRepositoryPathSuggestions(repository.path, q ?? "");
  });

  app.get("/api/tasks", async () => app.symphonyDb.listTasksWithLatestRun());

  app.post("/api/tasks", async (request, reply) => {
    const input = CreateTaskInputSchema.parse(request.body);
    void reply.code(201);
    return app.symphonyDb.createTask(input);
  });

  app.get("/api/tasks/:taskId", async (request) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    return app.symphonyDb.getTaskDetail(taskId);
  });

  app.patch("/api/tasks/:taskId", async (request) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    const input = UpdateTaskInputSchema.parse(request.body);
    return app.symphonyDb.updateTask(taskId, input);
  });

  app.post("/api/tasks/:taskId/dispatch", async (request, reply) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    void reply.code(202);
    return app.symphonyOrchestrator.dispatch(taskId);
  });

  app.post("/api/tasks/:taskId/cancel", async (request) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    return app.symphonyOrchestrator.cancelTask(taskId);
  });

  app.post("/api/tasks/:taskId/mark-done", async (request, reply) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    void reply.code(202);
    return app.symphonyFinalizer.finalize(taskId);
  });

  app.post("/api/tasks/:taskId/finalize", async (request, reply) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    void reply.code(202);
    return app.symphonyFinalizer.finalize(taskId);
  });

  app.post("/api/tasks/:taskId/status", async (request) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    const { status } = TaskStatusBodySchema.parse(request.body);
    return app.symphonyDb.updateTaskStatus(taskId, status);
  });

  app.get("/api/runs/:runId/events", async (request) => {
    const { runId } = RunParamsSchema.parse(request.params);
    return app.symphonyDb.listRunEvents(runId);
  });

  app.get("/api/runs/:runId/events/stream", (request, reply) => {
    const { runId } = RunParamsSchema.parse(request.params);
    streamRunEvents(request, reply, runId, app.symphonyDb, app.symphonyEventBus);
  });
}

async function registerStaticRoutes(app: FastifyInstance, webDistDir: string): Promise<void> {
  mkdirSync(webDistDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: webDistDir,
    wildcard: true
  });
}

function streamRunEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  runId: string,
  db: SymphonyDb,
  eventBus: EventBus
): void {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    ...corsHeaders,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });

  for (const event of db.listRunEvents(runId)) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const unsubscribe = eventBus.onRunEvent((event) => {
    if (event.runId === runId) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  });

  request.raw.on("close", unsubscribe);
}

function sendSpaFallback(reply: FastifyReply, webDistDir: string): void {
  if (!existsSync(join(webDistDir, "index.html"))) {
    void reply.code(404).type("text/plain; charset=utf-8").send("未找到前端构建产物");
    return;
  }

  void reply.type("text/html; charset=utf-8").sendFile("index.html");
}
