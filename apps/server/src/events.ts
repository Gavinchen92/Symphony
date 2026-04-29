import { EventEmitter } from "node:events";
import type { RunEvent } from "@symphony/shared";

export class EventBus {
  private emitter = new EventEmitter();

  emitRunEvent(event: RunEvent): void {
    this.emitter.emit("run-event", event);
  }

  onRunEvent(listener: (event: RunEvent) => void): () => void {
    this.emitter.on("run-event", listener);
    return () => this.emitter.off("run-event", listener);
  }
}

