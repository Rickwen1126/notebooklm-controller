/**
 * MCP Server skeleton for NotebookLM Controller.
 *
 * Sets up a Streamable HTTP server on MCP_HOST:MCP_PORT using the
 * high-level McpServer API from @modelcontextprotocol/sdk.
 *
 * Individual tools (get_status, exec, etc.) are registered externally
 * via `registerTool()` during daemon setup.
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { MCP_HOST, MCP_PORT } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options accepted by `registerTool` for the tool's metadata. */
export interface RegisterToolOptions {
  description: string;
  inputSchema?: ZodRawShapeCompat;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = logger.child({ module: "mcp-server" });

// ---------------------------------------------------------------------------
// NbctlMcpServer
// ---------------------------------------------------------------------------

export class NbctlMcpServer {
  private readonly mcpServer: McpServer;

  /** Active transports keyed by MCP session ID. */
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();

  /** Node HTTP server instance — created in `start()`, closed in `stop()`. */
  private httpServer: HttpServer | null = null;

  constructor() {
    this.mcpServer = new McpServer(
      {
        name: "notebooklm-controller",
        version: "0.1.0",
      },
      {
        capabilities: {
          logging: {},
        },
      },
    );

    log.info("McpServer instance created");
  }

  // -----------------------------------------------------------------------
  // registerTool
  // -----------------------------------------------------------------------

  /**
   * Register an MCP tool.
   *
   * Call this during daemon setup — before `start()` — to wire each tool
   * into the MCP server.  Tools registered after `start()` will still be
   * picked up by the SDK (it sends `tools/list_changed` automatically).
   *
   * @param name    Unique tool name (e.g. "get_status", "exec").
   * @param options Tool metadata: description, optional Zod input schema, optional annotations.
   * @param handler Async callback invoked when a client calls the tool.
   */
  registerTool<Args extends ZodRawShapeCompat>(
    name: string,
    options: RegisterToolOptions,
    handler: ToolCallback<Args>,
  ): void {
    const config: {
      description: string;
      inputSchema?: Args;
      annotations?: RegisterToolOptions["annotations"];
    } = {
      description: options.description,
    };

    if (options.inputSchema) {
      config.inputSchema = options.inputSchema as Args;
    }

    if (options.annotations) {
      config.annotations = options.annotations;
    }

    this.mcpServer.registerTool(name, config, handler);

    log.info("tool registered", { tool: name });
  }

  // -----------------------------------------------------------------------
  // start
  // -----------------------------------------------------------------------

  /**
   * Start listening on MCP_HOST:MCP_PORT with Streamable HTTP transport.
   *
   * The HTTP server handles POST (JSON-RPC requests), GET (SSE streams),
   * and DELETE (session termination) on the `/mcp` endpoint, following
   * the MCP Streamable HTTP specification.
   */
  async start(): Promise<void> {
    const app = createServer(
      (req, res) => void this.handleHttpRequest(req, res),
    );

    await new Promise<void>((resolve, reject) => {
      app.once("error", reject);
      app.listen(MCP_PORT, MCP_HOST, () => {
        app.removeListener("error", reject);
        resolve();
      });
    });

    this.httpServer = app;

    log.info("MCP server listening", {
      host: MCP_HOST,
      port: MCP_PORT,
      url: `http://${MCP_HOST}:${MCP_PORT}/mcp`,
    });
  }

  // -----------------------------------------------------------------------
  // stop
  // -----------------------------------------------------------------------

  /** Gracefully shut down the server: close all transports, then the HTTP server. */
  async stop(): Promise<void> {
    log.info("MCP server stopping", {
      activeSessions: this.transports.size,
    });

    // Close every active transport.
    const closeOps: Promise<void>[] = [];
    for (const [sessionId, transport] of this.transports.entries()) {
      closeOps.push(
        transport.close().catch((err: unknown) => {
          log.error("error closing transport", {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      );
    }
    await Promise.all(closeOps);
    this.transports.clear();

    // Shut down the HTTP server.
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.httpServer = null;
    }

    await this.mcpServer.close();

    log.info("MCP server stopped");
  }

  // -----------------------------------------------------------------------
  // getServer
  // -----------------------------------------------------------------------

  /** Expose the underlying McpServer for advanced use (notifications, etc.). */
  getServer(): McpServer {
    return this.mcpServer;
  }

  // -----------------------------------------------------------------------
  // Private: HTTP request dispatch
  // -----------------------------------------------------------------------

  /**
   * Route incoming HTTP requests to the correct Streamable HTTP transport.
   *
   * - POST /mcp  → JSON-RPC (initialize or existing session)
   * - GET  /mcp  → SSE stream for an existing session
   * - DELETE /mcp → session termination
   */
  private async handleHttpRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    // Only serve the /mcp path.
    const url = new URL(req.url ?? "/", `http://${MCP_HOST}:${MCP_PORT}`);
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const method = req.method?.toUpperCase();

    try {
      if (method === "POST") {
        await this.handlePost(req, res);
      } else if (method === "GET") {
        await this.handleGet(req, res);
      } else if (method === "DELETE") {
        await this.handleDelete(req, res);
      } else {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
      }
    } catch (err: unknown) {
      log.error("unhandled error in HTTP handler", {
        method,
        error: err instanceof Error ? err.message : String(err),
      });

      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // POST /mcp
  // -----------------------------------------------------------------------

  private async handlePost(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    // Read the raw body.
    const body = await this.readBody(req);
    const parsed: unknown = JSON.parse(body);

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && this.transports.has(sessionId)) {
      // Existing session — forward to the stored transport.
      const transport = this.transports.get(sessionId)!;
      await transport.handleRequest(req, res, parsed);
      return;
    }

    if (!sessionId && isInitializeRequest(parsed)) {
      // New session — create a transport and connect it.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          this.transports.set(sid, transport);
          log.info("session initialized", { sessionId: sid });
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          this.transports.delete(sid);
          log.info("session closed", { sessionId: sid });
        }
      };

      // Connect to a fresh McpServer instance's transport layer.
      await this.mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsed);
      return;
    }

    // Invalid request.
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      }),
    );
  }

  // -----------------------------------------------------------------------
  // GET /mcp  (SSE stream)
  // -----------------------------------------------------------------------

  private async handleGet(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId || !this.transports.has(sessionId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
      return;
    }

    const transport = this.transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  }

  // -----------------------------------------------------------------------
  // DELETE /mcp  (session termination)
  // -----------------------------------------------------------------------

  private async handleDelete(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId || !this.transports.has(sessionId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
      return;
    }

    const transport = this.transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  }

  // -----------------------------------------------------------------------
  // Utility: read raw request body
  // -----------------------------------------------------------------------

  private readBody(req: import("node:http").IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }
}
