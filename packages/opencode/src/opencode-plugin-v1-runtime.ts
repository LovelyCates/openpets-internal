import { createOpenPetsOpenCodeRuntime, type OpenCodePluginRuntime } from "./opencode-plugin-runtime.js";

/** The public OpenCode 1.x hook shape. The internal fork must be checked separately. */
export interface OpenCodeV1Hooks {
  readonly event: (input: { readonly event?: unknown }) => Promise<void>;
  readonly "chat.message": () => Promise<void>;
  readonly "tool.execute.before": (input: { readonly tool?: unknown }, output: { readonly args?: unknown }) => Promise<void>;
  readonly "permission.ask": (_input: unknown, output: { readonly status?: unknown }) => Promise<void>;
}

export function createOpenPetsOpenCodeV1Hooks(runtime: OpenCodePluginRuntime = createOpenPetsOpenCodeRuntime()): OpenCodeV1Hooks {
  return {
    async event(input) {
      const event = input?.event;
      if (!isRecord(event) || typeof event.type !== "string") return;
      if (event.type === "session.error") {
        runtime.event({ type: "session.execution.failed" });
        return;
      }
      if (event.type === "session.idle") {
        runtime.event({ type: "session.idle" });
        return;
      }
      if (event.type !== "session.status") return;
      const properties = isRecord(event.properties) ? event.properties : undefined;
      const status = properties && isRecord(properties.status) ? properties.status : undefined;
      if (status?.type === "busy") runtime.prompt();
      if (status?.type === "idle") runtime.event({ type: "session.idle" });
    },
    async "chat.message"() {
      runtime.prompt();
    },
    async "tool.execute.before"(input, output) {
      if (typeof input?.tool === "string") runtime.toolBefore(input.tool, output?.args);
    },
    async "permission.ask"(_input, output) {
      if (output?.status === "ask") runtime.event({ type: "permission.asked" });
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
