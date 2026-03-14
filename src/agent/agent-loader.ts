/**
 * Agent config loader — parses YAML frontmatter + Markdown prompt from .md files.
 *
 * Each agent config file uses the format:
 *   ---
 *   name: ...
 *   displayName: ...
 *   ...
 *   ---
 *   Markdown prompt body with {{paramName}} template variables.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { logger } from "../shared/logger.js";
import { loadUIMap } from "../shared/locale.js";
import type { AgentConfig, AgentParameter, UIMap } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Internal: YAML frontmatter parser (no external dependency)
// ---------------------------------------------------------------------------

/**
 * Split raw file content into frontmatter (YAML string) and body (Markdown string).
 * Returns null if the file does not have valid `---` delimiters.
 */
function splitFrontmatter(
  raw: string,
): { yaml: string; body: string } | null {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    return null;
  }

  // Find the closing `---` (must be on its own line after the opening one).
  const afterFirst = trimmed.indexOf("\n");
  if (afterFirst === -1) {
    return null;
  }

  const rest = trimmed.slice(afterFirst + 1);
  const closingIdx = rest.indexOf("\n---");
  if (closingIdx === -1) {
    return null;
  }

  const yaml = rest.slice(0, closingIdx);
  // Body starts after the closing `---` line.
  const afterClosing = rest.slice(closingIdx + 4); // "\n---".length === 4
  // Skip the remainder of the closing line (possible trailing whitespace / newline).
  const bodyStart = afterClosing.indexOf("\n");
  const body =
    bodyStart === -1 ? "" : afterClosing.slice(bodyStart + 1);

  return { yaml, body: body.trim() };
}

/**
 * Determine indent level (number of leading spaces) of a line.
 */
function indentLevel(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

/**
 * Parse a simple YAML block into a plain JS object.
 *
 * Supported subset:
 *   - scalar `key: value` (string, number, boolean)
 *   - list values (lines starting with `- `)
 *   - one level of nested objects (for `parameters`)
 */
function parseSimpleYaml(
  yaml: string,
): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines and comments.
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const indent = indentLevel(line);

    // Top-level keys have indent 0.
    if (indent > 0) {
      i++;
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();

    if (rawValue === "") {
      // Could be a list or nested object — peek ahead.
      const children: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const childLine = lines[j];
        if (childLine.trim() === "" || childLine.trim().startsWith("#")) {
          j++;
          continue;
        }
        if (indentLevel(childLine) === 0) {
          break;
        }
        children.push(childLine);
        j++;
      }

      if (children.length > 0 && children[0].trim().startsWith("- ")) {
        // It's a list.
        result[key] = children
          .filter((c) => c.trim().startsWith("- "))
          .map((c) => parseScalar(c.trim().slice(2).trim()));
      } else {
        // Nested object (one level deep — for `parameters`).
        result[key] = parseNestedObject(children);
      }

      i = j;
      continue;
    }

    result[key] = parseScalar(rawValue);
    i++;
  }

  return result;
}

/**
 * Parse a nested YAML object block (two-level deep, for `parameters`).
 *
 * Expected input lines:
 *   "  notebookAlias:"
 *   "    type: string"
 *   "    description: Target notebook alias"
 *   "    default: default"
 */
function parseNestedObject(
  lines: string[],
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  let currentKey: string | null = null;
  let currentBaseIndent = 0;

  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }

    const indent = indentLevel(line);
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();

    if (rawValue === "") {
      // New nested key.
      currentKey = key;
      currentBaseIndent = indent;
      result[currentKey] = {};
    } else if (currentKey !== null && indent > currentBaseIndent) {
      // Property of current nested key.
      result[currentKey][key] = parseScalar(rawValue);
    }
  }

  return result;
}

/**
 * Parse a scalar YAML value: boolean, number, or string.
 */
function parseScalar(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;

  // Try number (only if it looks like a plain number).
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }

  // Strip surrounding quotes if present.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

// ---------------------------------------------------------------------------
// Internal: NOTEBOOKLM_KNOWLEDGE generation
// ---------------------------------------------------------------------------

/**
 * Generate the NOTEBOOKLM_KNOWLEDGE string from a UIMap.
 *
 * This is injected into CustomAgent prompts that reference {{NOTEBOOKLM_KNOWLEDGE}}.
 * Content: UI element table + known CSS selectors + disambiguation rules +
 * state verification principles.
 */
function generateKnowledge(ui: UIMap): string {
  const e = ui.elements;
  const s = ui.selectors;
  return `## NotebookLM UI Knowledge (locale: ${ui.locale})

### Core Rules

1. **Never guess coordinates** — always use find() to get precise coordinates before click().
2. **Use paste() not type()** — paste() for all text input; type() only for special keys (Enter, Tab, Escape).
3. **Two submit buttons** — page has search bar and chat bar submit buttons; always pick the one with y > 400.
4. **Answers need wait** — after submitting a question, wait(15) then read(). If "Refining...", wait(10) more.
5. **Source panel blocks buttons** — if find("${e.add_source?.text ?? "Add source"}") fails, first find("${e.collapse_source?.text ?? "collapse_content"}") and click to collapse.

### State Verification

After every operation, confirm page state before proceeding.
- find() → element existence, coordinates, disabled/expanded state
- read() → element count, text content, visibility
- screenshot() → full visual state (use when uncertain)
DOM queries are faster and cheaper than screenshots; prefer them when sufficient.

### UI Elements

| Action | Steps |
|--------|-------|
| Create notebook | find("${e.create_notebook?.text ?? "Create new"}") → click |
| Add source (text) | find("${e.paste_source_type?.text ?? "Copied text"}") → click → find("${e.paste_textarea?.text ?? "Paste text here"}") → click → paste(content) → find("${e.insert_button?.text ?? "Insert"}") → click |
| Ask question | find("${e.chat_input?.text ?? "Start typing"}") → click → paste(question) → find("${e.submit_button?.text ?? "Submit"}") → click (y>400) |
| Read answer | wait(15) → read("${s.answer ?? ".to-user-container .message-content"}") |
| Collapse sources | find("${e.collapse_source?.text ?? "collapse_content"}") → click |

### CSS Selectors

- Answer text: \`${s.answer ?? ".to-user-container .message-content"}\`
- Question text: \`${s.question ?? ".from-user-container"}\`
- Suggestions: \`${s.suggestions ?? ".suggestions-container"}\`
- Source panel: \`${s.source_panel ?? ".source-panel"}\``;
}

// ---------------------------------------------------------------------------
// Internal: template rendering
// ---------------------------------------------------------------------------

/**
 * Replace `{{varName}}` placeholders with parameter values.
 * Falls back to the parameter's default if no override is provided.
 */
function renderTemplate(
  template: string,
  parameters: Record<string, AgentParameter>,
  overrides: Record<string, string | number | boolean>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => {
    if (varName in overrides) {
      return String(overrides[varName]);
    }
    if (varName in parameters && parameters[varName].default !== undefined) {
      return String(parameters[varName].default);
    }
    // Leave unresolved placeholders as-is.
    return `{{${varName}}}`;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and parse a single agent config file.
 *
 * Returns `null` (with a logged warning) when the file is invalid or
 * missing required fields.
 */
export async function loadAgentConfig(
  filePath: string,
  paramOverrides?: Record<string, string | number | boolean>,
  locale?: string,
): Promise<AgentConfig | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    logger.warn("Failed to read agent config file", {
      filePath,
      error: String(err),
    });
    return null;
  }

  const parts = splitFrontmatter(raw);
  if (!parts) {
    logger.warn("Agent config file missing valid frontmatter", { filePath });
    return null;
  }

  const parsed = parseSimpleYaml(parts.yaml);
  if (!parsed) {
    logger.warn("Failed to parse agent config YAML", { filePath });
    return null;
  }

  // Validate required fields.
  if (
    typeof parsed["name"] !== "string" ||
    typeof parsed["description"] !== "string"
  ) {
    logger.warn("Agent config missing required fields (name, description)", {
      filePath,
    });
    return null;
  }

  const name = parsed["name"] as string;
  const displayName =
    typeof parsed["displayName"] === "string"
      ? parsed["displayName"]
      : name;
  const description = parsed["description"] as string;

  const tools: string[] = Array.isArray(parsed["tools"])
    ? (parsed["tools"] as unknown[]).map(String)
    : [];

  const infer =
    typeof parsed["infer"] === "boolean" ? parsed["infer"] : true;

  const rawStartPage = parsed["startPage"];
  const startPage: "homepage" | "notebook" =
    rawStartPage === "homepage" || rawStartPage === "notebook"
      ? rawStartPage
      : "notebook"; // default: most agents operate on notebook page

  // Build parameters map.
  const parameters: Record<string, AgentParameter> = {};
  if (
    parsed["parameters"] !== null &&
    typeof parsed["parameters"] === "object" &&
    !Array.isArray(parsed["parameters"])
  ) {
    const rawParams = parsed["parameters"] as Record<
      string,
      Record<string, unknown>
    >;
    for (const [paramName, paramDef] of Object.entries(rawParams)) {
      if (typeof paramDef === "object" && paramDef !== null) {
        parameters[paramName] = {
          type: (paramDef["type"] as AgentParameter["type"]) ?? "string",
          description:
            typeof paramDef["description"] === "string"
              ? paramDef["description"]
              : "",
          default: (paramDef["default"] as string | number | boolean) ?? "",
        };
      }
    }
  }

  // Resolve {{NOTEBOOKLM_KNOWLEDGE}} if present in the body.
  let body = parts.body;
  if (body.includes("{{NOTEBOOKLM_KNOWLEDGE}}") && locale) {
    const uiMap = loadUIMap(locale);
    const knowledge = generateKnowledge(uiMap);
    body = body.replace(/\{\{NOTEBOOKLM_KNOWLEDGE\}\}/g, knowledge);
  }

  // Render the prompt template.
  const prompt = renderTemplate(
    body,
    parameters,
    paramOverrides ?? {},
  );

  return {
    name,
    displayName,
    description,
    tools,
    prompt,
    infer,
    startPage,
    parameters,
  };
}

/**
 * Build a Planner catalog string from loaded agent configs.
 *
 * The catalog is injected into the Planner session's systemMessage so it can
 * select the appropriate agent config for each step of the execution plan.
 * Each entry shows the agent's name, description, available tools, and parameters.
 */
export function buildPlannerCatalog(configs: AgentConfig[]): string {
  if (configs.length === 0) {
    return "(no agents available)";
  }

  return configs
    .map((config) => {
      const lines = [
        `  - name: ${config.name}`,
        `    description: ${config.description}`,
        `    tools: [${config.tools.join(", ")}]`,
      ];

      const paramEntries = Object.entries(config.parameters);
      if (paramEntries.length > 0) {
        const paramObj: Record<string, { type: string; description: string }> = {};
        for (const [key, param] of paramEntries) {
          paramObj[key] = { type: param.type, description: param.description };
        }
        lines.push(`    parameters: ${JSON.stringify(paramObj)}`);
      }

      return lines.join("\n");
    })
    .join("\n");
}

/**
 * Load all `.md` agent config files from a directory.
 *
 * Invalid files are silently skipped (a warning is logged).
 */
export async function loadAllAgentConfigs(
  dirPath: string,
  locale?: string,
): Promise<AgentConfig[]> {
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch (err) {
    logger.warn("Failed to read agent configs directory", {
      dirPath,
      error: String(err),
    });
    return [];
  }

  const mdFiles = entries
    .filter((f) => extname(f) === ".md")
    .sort();

  const configs: AgentConfig[] = [];
  for (const file of mdFiles) {
    const config = await loadAgentConfig(join(dirPath, file), undefined, locale);
    if (config) {
      configs.push(config);
    }
  }

  return configs;
}
