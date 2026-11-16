import { createOpenPetsOpenCodeRuntime, shouldIgnoreOpenPetsTool, type OpenCodePluginRuntime } from "./opencode-plugin-runtime.js";

/** The public OpenCode 1.x hook shape. The internal fork must be checked separately. */
export interface OpenCodeV1Hooks {
  readonly event: (input: { readonly event?: unknown }) => Promise<void>;
  readonly "chat.message": (input?: { readonly sessionID?: unknown }) => Promise<void>;
  readonly "tool.execute.before": (input: { readonly tool?: unknown; readonly sessionID?: unknown; readonly callID?: unknown }, output: { readonly args?: unknown }) => Promise<void>;
  readonly "tool.execute.after": (input: { readonly tool?: unknown; readonly sessionID?: unknown; readonly callID?: unknown }, output?: unknown) => Promise<void>;
  readonly "permission.ask": (input: unknown, output: { readonly status?: unknown }) => Promise<void>;
}

export function createOpenPetsOpenCodeV1Hooks(runtime: OpenCodePluginRuntime = createOpenPetsOpenCodeRuntime()): OpenCodeV1Hooks {
  const permissionAsked = (input: unknown, action: unknown): void => {
    const properties = isRecord(input) ? input : undefined;
    const permission = typeof action === "string" ? action : undefined;
    if (permission && shouldIgnoreOpenPetsTool(permission)) return;
    runtime.event({
      type: "permission.asked",
      data: {
        ...(typeof properties?.sessionID === "string" ? { sessionID: properties.sessionID } : {}),
        ...(permission === undefined ? {} : { action: permission }),
        // V1 tool contains message/call IDs, not a tool name. Patterns and
        // metadata can include private paths or arguments and are not needed.
        resources: [],
      },
    });
  };

  return {
    async event(input) {
      const event = input?.event;
      if (!isRecord(event) || typeof event.type !== "string") return;
      if (event.type === "message.part.updated" || event.type === "message.part.delta" || event.type === "message.updated") {
        runtime.event(event);
        return;
      }
      const properties = isRecord(event.properties) ? event.properties : undefined;
      const sessionID = typeof properties?.sessionID === "string" ? properties.sessionID : undefined;
      const sessionData = sessionID ? { data: { sessionID } } : {};
      if (event.type === "permission.asked") {
        if (typeof properties?.permission === "string" && properties.permission.length > 0) {
          permissionAsked(properties, properties.permission);
        }
        return;
      }
      if (event.type === "permission.replied") {
        if (sessionID && sessionID.length <= 256) {
          runtime.event({ type: "permission.replied", data: { sessionID } });
        }
        return;
      }
      if (event.type === "session.error") {
        runtime.event({ type: "session.execution.failed", ...sessionData });
        return;
      }
      if (event.type === "session.idle") {
        runtime.event({ type: "session.idle", ...sessionData });
        return;
      }
      if (event.type !== "session.status") return;
      const status = properties && isRecord(properties.status) ? properties.status : undefined;
      if (status?.type === "busy") runtime.prompt(sessionID);
      if (status?.type === "idle") runtime.event({ type: "session.idle", ...sessionData });
    },
    async "chat.message"(input) {
      runtime.prompt(typeof input?.sessionID === "string" ? input.sessionID : undefined);
    },
    async "tool.execute.before"(input, output) {
      if (typeof input?.tool === "string") runtime.toolBefore(
        input.tool,
        output?.args,
        typeof input.sessionID === "string" ? input.sessionID : undefined,
        typeof input.callID === "string" ? input.callID : undefined,
      );
    },
    async "tool.execute.after"(input, output) {
      // Public V1 has no status field. Only its successful result shape proves
      // completion; an undefined failure result must not fabricate success.
      if (!isRecord(output) || typeof output.output !== "string") return;
      runtime.toolAfter({
        tool: input?.tool,
        sessionID: input?.sessionID,
        id: input?.callID,
        status: "completed",
      });
    },
    async "permission.ask"(input, output) {
      if (output?.status !== "ask") return;
      const properties = isRecord(input) ? input : undefined;
      permissionAsked(properties, properties?.type ?? properties?.permission);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
