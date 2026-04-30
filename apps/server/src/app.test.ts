import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createFastifyApp } from "./app";
import { SymphonyDb } from "./db";
import { EventBus } from "./events";
import { createServiceLogger } from "./logger";

describe("Fastify app", () => {
  it("serves health and CORS preflight", async () => {
    const fixture = await createFixture();
    try {
      const health = await fixture.app.inject({ method: "GET", url: "/api/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ ok: true });

      const options = await fixture.app.inject({
        method: "OPTIONS",
        url: "/api/health",
        headers: {
          origin: "http://127.0.0.1:5173",
          "access-control-request-method": "GET"
        }
      });
      expect(options.statusCode).toBe(204);
      expect(options.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
    } finally {
      await fixture.app.close();
    }
  });

  it("keeps repository and task API contracts stable", async () => {
    const fixture = await createFixture();
    try {
      const repository = await fixture.app.inject({
        method: "POST",
        url: "/api/repositories",
        payload: {
          name: "Repo",
          path: fixture.root,
          baseBranch: "main",
          workspaceStrategy: "full"
        }
      });
      expect(repository.statusCode).toBe(201);
      const repositoryBody = repository.json() as { id: string };

      const task = await fixture.app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
          repositoryId: repositoryBody.id,
          title: "实现 Fastify 迁移",
          description: "保持 API 不变",
          priority: 2,
          labels: [],
          scopePaths: []
        }
      });
      expect(task.statusCode).toBe(201);
      expect(task.json()).toMatchObject({
        repositoryId: repositoryBody.id,
        title: "实现 Fastify 迁移",
        status: "todo"
      });

      const list = await fixture.app.inject({ method: "GET", url: "/api/tasks" });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toHaveLength(1);
    } finally {
      await fixture.app.close();
    }
  });

  it("maps validation failures and missing API routes to stable errors", async () => {
    const fixture = await createFixture();
    try {
      const invalidInput = await fixture.app.inject({
        method: "POST",
        url: "/api/repositories",
        payload: {}
      });
      expect(invalidInput.statusCode, invalidInput.body).toBe(400);
      expect(invalidInput.json()).toEqual({ error: "请求参数不合法" });

      const missingApi = await fixture.app.inject({ method: "GET", url: "/api/missing" });
      expect(missingApi.statusCode).toBe(404);
      expect(missingApi.json()).toEqual({ error: "未找到资源" });
    } finally {
      await fixture.app.close();
    }
  });

  it("streams replayed and live run events", async () => {
    const fixture = await createFixture();
    try {
      const repository = fixture.db.createRepository({
        name: "Repo",
        path: fixture.root,
        baseBranch: "main",
        workspaceStrategy: "full"
      });
      const task = fixture.db.createTask({
        repositoryId: repository.id,
        title: "SSE test",
        description: "",
        priority: 2,
        labels: [],
        scopePaths: []
      });
      const run = fixture.db.createRun(task.id);
      fixture.db.addRunEvent(run.id, "status", "历史事件");

      await fixture.app.listen({ host: "127.0.0.1", port: 0 });
      const response = await fetch(`${serverUrl(fixture.app)}/api/runs/${run.id}/events/stream`);
      expect(response.ok).toBe(true);
      expect(response.body).not.toBeNull();

      const reader = response.body!.getReader();
      await expect(readUntil(reader, "历史事件")).resolves.toContain("历史事件");
      fixture.db.addRunEvent(run.id, "status", "实时事件");
      await expect(readUntil(reader, "实时事件")).resolves.toContain("实时事件");
      await reader.cancel();
    } finally {
      await fixture.app.close();
    }
  });

  it("serves static files and falls back to index.html for SPA routes", async () => {
    const fixture = await createFixture({ withWebDist: true });
    try {
      const fallback = await fixture.app.inject({ method: "GET", url: "/tasks/abc" });
      expect(fallback.statusCode).toBe(200);
      expect(fallback.headers["content-type"]).toContain("text/html");
      expect(fallback.body).toContain("Symphony Web");
    } finally {
      await fixture.app.close();
    }
  });

  it("keeps sendFile fallback available when web dist appears after startup", async () => {
    const fixture = await createFixture();
    try {
      writeFileSync(join(fixture.webDistDir, "index.html"), "<!doctype html><title>Late Web</title>");

      const fallback = await fixture.app.inject({ method: "GET", url: "/late-route" });
      expect(fallback.statusCode).toBe(200);
      expect(fallback.headers["content-type"]).toContain("text/html");
      expect(fallback.body).toContain("Late Web");
    } finally {
      await fixture.app.close();
    }
  });
});

async function createFixture(input: { withWebDist?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "symphony-fastify-"));
  const webDistDir = join(root, "web-dist");
  if (input.withWebDist) {
    mkdirSync(webDistDir, { recursive: true });
    writeFileSync(join(webDistDir, "index.html"), "<!doctype html><title>Symphony Web</title>");
  }

  const eventBus = new EventBus();
  const db = new SymphonyDb(join(root, "db.sqlite"), eventBus, root);
  const logger = createServiceLogger({
    level: "silent",
    dir: join(root, "logs"),
    stdout: false
  });
  const app = await createFastifyApp({
    db,
    eventBus,
    webDistDir,
    logger: logger.logger,
    closeLogger: logger.close,
    orchestrator: {
      dispatch(taskId) {
        return db.createRun(taskId);
      },
      cancelTask() {
        return null;
      }
    },
    finalizer: {
      finalize(taskId) {
        return db.updateTaskStatus(taskId, "finalizing");
      }
    }
  });

  return { app, db, eventBus, root, webDistDir };
}

function serverUrl(app: Awaited<ReturnType<typeof createFastifyApp>>): string {
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fastify server address is unavailable");
  }
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pattern: string
): Promise<string> {
  const decoder = new TextDecoder();
  let content = "";
  const startedAt = Date.now();

  while (!content.includes(pattern) && Date.now() - startedAt < 2000) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    content += decoder.decode(result.value, { stream: true });
  }

  if (!content.includes(pattern)) {
    throw new Error(`未读取到 SSE 内容：${pattern}`);
  }
  return content;
}
