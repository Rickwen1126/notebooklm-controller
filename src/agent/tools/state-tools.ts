/**
 * State tools for the Copilot SDK agent.
 *
 * Provides tools for reporting rate-limit anomalies to NetworkGate,
 * updating the per-notebook cache (sources / artifacts), and writing
 * files to disk.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { defineTool } from "@github/copilot-sdk";
import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import type { NetworkGate } from "../../network-gate/network-gate.js";
import type { CacheManager } from "../../state/cache-manager.js";
import type { SourceRecord, ArtifactRecord } from "../../shared/types.js";

/** Build a simple text ToolResultObject. */
function textResult(text: string): ToolResultObject {
  return {
    textResultForLlm: text,
    resultType: "success",
  };
}

/** Build an error ToolResultObject. */
function errorResult(text: string): ToolResultObject {
  return {
    textResultForLlm: text,
    resultType: "failure",
    error: text,
  };
}

/**
 * Create state management tools bound to the given dependencies.
 *
 * Returns an array of Tool instances (Copilot SDK `defineTool` format).
 */
export function createStateTools(deps: {
  networkGate: NetworkGate;
  cacheManager: CacheManager;
  notebookAlias: string;
}): Tool[] {
  const { networkGate, cacheManager, notebookAlias } = deps;

  // ---------------------------------------------------------------------------
  // reportRateLimit
  // ---------------------------------------------------------------------------

  const reportRateLimitTool = defineTool("reportRateLimit", {
    description:
      "Report a network rate-limit or anomaly signal (e.g. HTTP 429, CAPTCHA) to the NetworkGate, triggering exponential backoff.",
    parameters: z.object({
      signal: z
        .string()
        .describe(
          'The anomaly signal to report, e.g. "HTTP 429", "503", "CAPTCHA", "timeout"',
        ),
    }),
    handler: async (args) => {
      networkGate.reportAnomaly(args.signal);
      return textResult(
        `Rate-limit signal "${args.signal}" reported. NetworkGate backoff activated.`,
      );
    },
  });

  // ---------------------------------------------------------------------------
  // updateCache
  // ---------------------------------------------------------------------------

  const updateCacheTool = defineTool("updateCache", {
    description:
      "Update the per-notebook cache: add, update, or remove a source or artifact record.",
    parameters: z.object({
      type: z
        .enum(["source", "artifact"])
        .describe("The record type to operate on"),
      action: z
        .enum(["add", "update", "remove"])
        .describe("The cache operation to perform"),
      data: z.record(z.string(), z.unknown()).describe("The record data object"),
    }),
    handler: async (args) => {
      try {
        if (args.type === "source") {
          switch (args.action) {
            case "add":
              await cacheManager.addSource(args.data as unknown as SourceRecord);
              return textResult("Source record added to cache.");
            case "update": {
              const id = (args.data as { id?: string }).id;
              if (!id) {
                return errorResult(
                  "Missing 'id' field in data for source update.",
                );
              }
              await cacheManager.updateSource(notebookAlias, id, args.data as Partial<SourceRecord>);
              return textResult(`Source record "${id}" updated in cache.`);
            }
            case "remove": {
              const id = (args.data as { id?: string }).id;
              if (!id) {
                return errorResult(
                  "Missing 'id' field in data for source removal.",
                );
              }
              await cacheManager.removeSource(notebookAlias, id);
              return textResult(`Source record "${id}" removed from cache.`);
            }
          }
        } else {
          switch (args.action) {
            case "add":
              await cacheManager.addArtifact(args.data as unknown as ArtifactRecord);
              return textResult("Artifact record added to cache.");
            case "update":
              return errorResult(
                "Artifact update is not supported. Use add or remove.",
              );
            case "remove": {
              const id = (args.data as { id?: string }).id;
              if (!id) {
                return errorResult(
                  "Missing 'id' field in data for artifact removal.",
                );
              }
              await cacheManager.removeArtifact(notebookAlias, id);
              return textResult(`Artifact record "${id}" removed from cache.`);
            }
          }
        }
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : String(err);
        return errorResult(`Cache operation failed: ${message}`);
      }
    },
  });

  // ---------------------------------------------------------------------------
  // writeFile
  // ---------------------------------------------------------------------------

  const writeFileTool = defineTool("writeFile", {
    description:
      "Write text content to a file at the given path. Creates parent directories if needed.",
    parameters: z.object({
      path: z.string().describe("Absolute or relative file path to write to"),
      content: z.string().describe("Text content to write to the file"),
    }),
    handler: async (args) => {
      try {
        await mkdir(dirname(args.path), { recursive: true });
        await writeFile(args.path, args.content, "utf-8");
        return textResult(`File written successfully: ${args.path}`);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : String(err);
        return errorResult(`Failed to write file: ${message}`);
      }
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return [reportRateLimitTool, updateCacheTool, writeFileTool] as any as Tool[];
}
