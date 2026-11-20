import { join } from "node:path";
import { realpathSync } from "node:fs";
import { AtlasSession } from "./runtime.ts";
import { check, SKILL } from "./store.ts";

const MESSAGE_TYPE = "agent-atlas";

// Structural subset of the documented Pi ExtensionAPI. No host runtime import is
// necessary: the installed ESM bundles the graph engine and its TypeScript parser.
export interface PiAPI {
  on(event: string, handler: (event: any, ctx: any) => any): unknown;
  registerCommand(
    name: string,
    options: { description: string; handler: (args: string, ctx: any) => any },
  ): unknown;
  sendMessage(message: { customType: string; content: string; display: boolean }): unknown;
}
export default function atlas(pi: PiAPI, root: string) {
  const session = new AtlasSession(root);
  const compatible = (ctx: any) => realpathSync(ctx.cwd) === session.root;
  pi.registerCommand("atlas", {
    description:
      "Select explicit repository domain/seed scope, widen with a reason, check or refresh Atlas",
    handler(args, ctx) {
      let content: string;
      try {
        if (!compatible(ctx)) {
          throw new Error("Atlas v1 requires Pi to start at the installed repository root");
        }
        content = session.command(args);
      } catch (e: any) {
        content = `Atlas: ${String(e.message ?? e)}`;
      }
      // This does not trigger a provider request, including headless/RPC mode.
      pi.sendMessage({
        customType: MESSAGE_TYPE,
        content: content.slice(0, 12000),
        display: true,
      });
    },
  });
  pi.on("session_start", (_event, ctx) => {
    session.scope = undefined;
    session.dirty = false;
    if (ctx.hasUI) {
      ctx.ui.notify(
        "Atlas: /atlas domain NAME or /atlas seed FILE selects task scope. Read-only discovery until selected.",
        "info",
      );
    }
  });
  pi.on("resources_discover", (_event, ctx) =>
    compatible(ctx) ? { skillPaths: [join(root, SKILL)] } : undefined,
  );
  pi.on("before_agent_start", (_event, ctx) => ({
    message: {
      customType: "agent-atlas",
      content: compatible(ctx)
        ? session.prepare()
        : "Atlas: start Pi at the installed repository root; native mutations are blocked until then.",
      display: false,
    },
  }));
  pi.on("context", (event, ctx) => {
    const content = compatible(ctx)
      ? session.prepare()
      : "Atlas requires the installed repository root as cwd.";

    // Replace old Atlas context rather than accumulating a map every turn. No
    // continuation requests, provider calls, subprocesses, timers or tool loops.
    return {
      messages: [
        ...event.messages.filter((m: any) => m.customType !== MESSAGE_TYPE),
        {
          role: "custom",
          customType: MESSAGE_TYPE,
          content,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });
  pi.on("tool_call", (event, ctx) => {
    if (!compatible(ctx)) {
      return {
        block: true,
        reason: "Atlas v1 requires Pi cwd to be the installed repository root",
        terminate: true,
      };
    }
    // Detect edits made outside Pi since the last model context. Never refresh in
    // a tool preflight: successful edits are refreshed at the next context boundary.
    try {
      if (!check(root).fresh && !session.dirty) {
        session.problem =
          "Sources changed externally; navigation refreshes before the next request. Use /atlas refresh if it cannot update.";
      }
    } catch (e: any) {
      session.problem = String(e.message ?? e);
    }
    const reason = session.gate(event.toolName, event.input, ctx.cwd);

    return reason ? { block: true, reason, terminate: true } : undefined;
  });
  pi.on("tool_result", (event) => {
    session.result(event.toolName, !!event.isError);
  });
  pi.on("agent_settled", () => {
    if (session.dirty) {
      session.prepare();
    }
  });

  return session;
}
