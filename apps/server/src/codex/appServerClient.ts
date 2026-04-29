import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import WebSocket from "ws";

export type AppServerNotification = {
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  id?: string;
  result?: unknown;
  error?: { message?: string } | string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestId = 0;
  private notifications = new Set<(notification: AppServerNotification) => void>();

  async start(): Promise<void> {
    const port = await getFreePort();
    const endpoint = `ws://127.0.0.1:${port}`;
    this.child = spawn("codex", ["app-server", "--listen", endpoint], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.child.stderr.on("data", (chunk) => {
      this.emit({ method: "stderr", params: chunk.toString("utf8") });
    });

    this.child.stdout.on("data", (chunk) => {
      this.emit({ method: "stdout", params: chunk.toString("utf8") });
    });

    this.child.on("exit", (code, signal) => {
      const error = new Error(`Codex app-server 已退出：code=${code ?? "null"} signal=${signal ?? "null"}`);
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });

    this.ws = await connectWebSocket(endpoint);
    this.ws.on("message", (data) => this.handleMessage(data.toString()));
    this.ws.on("error", (error) => {
      this.emit({ method: "websocket/error", params: String(error) });
    });

    await this.request("initialize", {
      clientInfo: {
        name: "symphony-local-runner",
        title: "Symphony Local Runner",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex app-server WebSocket 未连接"));
    }

    const id = String(++this.requestId);
    const payload = { id, method, params };
    this.ws.send(JSON.stringify(payload));

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
    });
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Codex app-server 已停止"));
    }
    this.pending.clear();
    this.ws?.close();
    this.ws = null;
    this.child?.kill("SIGTERM");
    this.child = null;
  }

  private handleMessage(raw: string): void {
    const message = JSON.parse(raw) as JsonRpcResponse & AppServerNotification;
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(typeof message.error === "string" ? message.error : message.error.message ?? "Codex 请求失败"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.emit({ method: message.method, params: message.params });
    }
  }

  private emit(notification: AppServerNotification): void {
    for (const listener of this.notifications) {
      listener(notification);
    }
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("分配本地端口失败"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function connectWebSocket(endpoint: string): Promise<WebSocket> {
  const startedAt = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - startedAt < 10_000) {
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(endpoint);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  throw new Error(`连接 Codex app-server 失败：${lastError?.message ?? "超时"}`);
}
