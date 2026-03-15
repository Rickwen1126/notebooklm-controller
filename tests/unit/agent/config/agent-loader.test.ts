import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadAgentConfig,
  loadAllAgentConfigs,
  buildPlannerCatalog,
} from "../../../../src/agent/agent-loader.js";
import type { AgentConfig } from "../../../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-loader-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Write a fixture file and return its absolute path. */
async function writeFixture(
  filename: string,
  content: string,
): Promise<string> {
  const filePath = join(tempDir, filename);
  await writeFile(filePath, content, "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_CONFIG = `---
name: add-source
displayName: Add Source
description: Add a source to NotebookLM
tools:
  - repoToText
  - click
  - type
  - screenshot
  - paste
infer: true
parameters:
  notebookAlias:
    type: string
    description: Target notebook alias
    default: default
---

You are operating on notebook {{notebookAlias}}.

Screenshot the current state, then click "Add source"...
`;

const MINIMAL_CONFIG = `---
name: simple-agent
description: A minimal agent with no optional fields
---

Do something useful.
`;

const NO_FRONTMATTER = `# Just Markdown

No YAML frontmatter at all.
`;

const _BROKEN_YAML = `---
name: broken
description
  this is not valid
---

Some body.
`;

const MISSING_NAME = `---
description: Has description but no name
tools:
  - click
---

Body here.
`;

const MULTI_PARAM_CONFIG = `---
name: query-agent
displayName: Query Agent
description: Perform a query against NotebookLM
tools:
  - screenshot
  - click
infer: false
parameters:
  notebookAlias:
    type: string
    description: Target notebook alias
    default: my-notebook
  maxRetries:
    type: number
    description: Maximum retry attempts
    default: 3
  verbose:
    type: boolean
    description: Enable verbose logging
    default: false
---

Operating on {{notebookAlias}} with max {{maxRetries}} retries. Verbose: {{verbose}}.
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadAgentConfig", () => {
  it("should parse a valid agent config file", async () => {
    const filePath = await writeFixture("add-source.md", VALID_CONFIG);
    const config = await loadAgentConfig(filePath);

    expect(config).not.toBeNull();
    expect(config!.name).toBe("add-source");
    expect(config!.displayName).toBe("Add Source");
    expect(config!.description).toBe("Add a source to NotebookLM");
  });

  it("should extract name, displayName, description, tools, infer, and parameters from YAML", async () => {
    const filePath = await writeFixture("add-source.md", VALID_CONFIG);
    const config = await loadAgentConfig(filePath);

    expect(config).not.toBeNull();
    expect(config!.tools).toEqual([
      "repoToText",
      "click",
      "type",
      "screenshot",
      "paste",
    ]);
    expect(config!.infer).toBe(true);
    expect(config!.parameters).toHaveProperty("notebookAlias");
    expect(config!.parameters["notebookAlias"]).toEqual({
      type: "string",
      description: "Target notebook alias",
      default: "default",
    });
  });

  it("should extract prompt from Markdown body after frontmatter", async () => {
    const filePath = await writeFixture("add-source.md", VALID_CONFIG);
    const config = await loadAgentConfig(filePath);

    expect(config).not.toBeNull();
    // The template variable should be replaced with the default value.
    expect(config!.prompt).toContain(
      "You are operating on notebook default.",
    );
    expect(config!.prompt).toContain(
      'Screenshot the current state, then click "Add source"...',
    );
  });

  it("should render template variables with parameter defaults", async () => {
    const filePath = await writeFixture(
      "query-agent.md",
      MULTI_PARAM_CONFIG,
    );
    const config = await loadAgentConfig(filePath);

    expect(config).not.toBeNull();
    expect(config!.prompt).toBe(
      "Operating on my-notebook with max 3 retries. Verbose: false.",
    );
  });

  it("should render template variables with custom overrides", async () => {
    const filePath = await writeFixture(
      "query-agent.md",
      MULTI_PARAM_CONFIG,
    );
    const config = await loadAgentConfig(filePath, {
      notebookAlias: "production",
      maxRetries: 5,
      verbose: true,
    });

    expect(config).not.toBeNull();
    expect(config!.prompt).toBe(
      "Operating on production with max 5 retries. Verbose: true.",
    );
  });

  it("should return null for a file without frontmatter", async () => {
    const filePath = await writeFixture("no-front.md", NO_FRONTMATTER);
    const config = await loadAgentConfig(filePath);

    expect(config).toBeNull();
  });

  it("should return null for a file with malformed YAML (missing required fields)", async () => {
    const filePath = await writeFixture("missing-name.md", MISSING_NAME);
    const config = await loadAgentConfig(filePath);

    expect(config).toBeNull();
  });

  it("should return null for a non-existent file", async () => {
    const config = await loadAgentConfig(
      join(tempDir, "does-not-exist.md"),
    );
    expect(config).toBeNull();
  });

  it("should default infer to true when not specified", async () => {
    const filePath = await writeFixture("minimal.md", MINIMAL_CONFIG);
    const config = await loadAgentConfig(filePath);

    expect(config).not.toBeNull();
    expect(config!.infer).toBe(true);
  });

  it("should default parameters to empty object when not specified", async () => {
    const filePath = await writeFixture("minimal.md", MINIMAL_CONFIG);
    const config = await loadAgentConfig(filePath);

    expect(config).not.toBeNull();
    expect(config!.parameters).toEqual({});
  });

  it("should default displayName to name when not specified", async () => {
    const filePath = await writeFixture("minimal.md", MINIMAL_CONFIG);
    const config = await loadAgentConfig(filePath);

    expect(config).not.toBeNull();
    expect(config!.displayName).toBe("simple-agent");
  });

  it("should default tools to empty array when not specified", async () => {
    const filePath = await writeFixture("minimal.md", MINIMAL_CONFIG);
    const config = await loadAgentConfig(filePath);

    expect(config).not.toBeNull();
    expect(config!.tools).toEqual([]);
  });

  it("should handle infer: false correctly", async () => {
    const filePath = await writeFixture(
      "query-agent.md",
      MULTI_PARAM_CONFIG,
    );
    const config = await loadAgentConfig(filePath);

    expect(config).not.toBeNull();
    expect(config!.infer).toBe(false);
  });

  it("should leave unresolved template variables as-is", async () => {
    const content = `---
name: test-agent
description: Test agent
---

Hello {{unknownParam}}, welcome.
`;
    const filePath = await writeFixture("unresolved.md", content);
    const config = await loadAgentConfig(filePath);

    expect(config).not.toBeNull();
    expect(config!.prompt).toBe("Hello {{unknownParam}}, welcome.");
  });

  it("should inject NOTEBOOKLM_KNOWLEDGE when locale is provided and placeholder is present", async () => {
    const content = `---
name: knowledge-agent
description: Agent with knowledge injection
---

{{NOTEBOOKLM_KNOWLEDGE}}

Now operate the notebook.
`;
    const filePath = await writeFixture("knowledge-agent.md", content);
    const config = await loadAgentConfig(filePath, {}, "zh-TW");

    expect(config).not.toBeNull();
    expect(config!.prompt).toContain("NotebookLM UI Knowledge");
    expect(config!.prompt).toContain("新建");
  });
});

describe("loadAllAgentConfigs", () => {
  it("should load multiple agent configs from a directory", async () => {
    await writeFixture("add-source.md", VALID_CONFIG);
    await writeFixture("query-agent.md", MULTI_PARAM_CONFIG);
    await writeFixture("minimal.md", MINIMAL_CONFIG);

    const configs = await loadAllAgentConfigs(tempDir);

    expect(configs).toHaveLength(3);
    const names = configs.map((c) => c.name).sort();
    expect(names).toEqual(["add-source", "query-agent", "simple-agent"]);
  });

  it("should skip invalid files and still load valid ones", async () => {
    await writeFixture("valid.md", VALID_CONFIG);
    await writeFixture("invalid.md", NO_FRONTMATTER);
    await writeFixture("missing-name.md", MISSING_NAME);

    const configs = await loadAllAgentConfigs(tempDir);

    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("add-source");
  });

  it("should only load .md files", async () => {
    await writeFixture("agent.md", VALID_CONFIG);
    await writeFixture("notes.txt", "not an agent config");
    await writeFixture("config.json", '{"name": "not-an-agent"}');

    const configs = await loadAllAgentConfigs(tempDir);

    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("add-source");
  });

  it("should return empty array for a non-existent directory", async () => {
    const configs = await loadAllAgentConfigs(
      join(tempDir, "nonexistent"),
    );
    expect(configs).toEqual([]);
  });

  it("should return empty array for an empty directory", async () => {
    const emptyDir = join(tempDir, "empty");
    await mkdir(emptyDir);

    const configs = await loadAllAgentConfigs(emptyDir);
    expect(configs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T068C: buildPlannerCatalog
// ---------------------------------------------------------------------------

describe("buildPlannerCatalog", () => {
  function makeConfig(overrides: Partial<AgentConfig>): AgentConfig {
    return {
      name: "test-agent",
      displayName: "Test Agent",
      description: "A test agent",
      tools: [],
      prompt: "do stuff",
      infer: true,
      startPage: "notebook",
      parameters: {},
      ...overrides,
    };
  }

  it("returns '(no agents available)' for empty configs array", () => {
    expect(buildPlannerCatalog([])).toBe("(no agents available)");
  });

  it("includes name, description, and tools for each agent", () => {
    const configs = [
      makeConfig({
        name: "add-source",
        description: "Add a source to NotebookLM",
        tools: ["find", "click", "paste"],
      }),
    ];

    const catalog = buildPlannerCatalog(configs);

    expect(catalog).toContain("name: add-source");
    expect(catalog).toContain("description: Add a source to NotebookLM");
    expect(catalog).toContain("tools: [find, click, paste]");
  });

  it("includes parameters when present", () => {
    const configs = [
      makeConfig({
        name: "query",
        description: "Query notebook",
        tools: ["find", "click"],
        parameters: {
          question: {
            type: "string",
            description: "The question to ask",
            default: "",
          },
        },
      }),
    ];

    const catalog = buildPlannerCatalog(configs);

    expect(catalog).toContain("parameters:");
    expect(catalog).toContain('"question"');
    expect(catalog).toContain('"type":"string"');
    expect(catalog).toContain('"description":"The question to ask"');
  });

  it("omits parameters line when agent has no parameters", () => {
    const configs = [
      makeConfig({
        name: "list-sources",
        description: "List all sources",
        tools: ["read"],
        parameters: {},
      }),
    ];

    const catalog = buildPlannerCatalog(configs);

    expect(catalog).not.toContain("parameters:");
  });

  it("handles multiple agents", () => {
    const configs = [
      makeConfig({ name: "agent-a", description: "First agent", tools: ["find"] }),
      makeConfig({ name: "agent-b", description: "Second agent", tools: ["click", "paste"] }),
    ];

    const catalog = buildPlannerCatalog(configs);

    expect(catalog).toContain("name: agent-a");
    expect(catalog).toContain("name: agent-b");
    expect(catalog).toContain("tools: [find]");
    expect(catalog).toContain("tools: [click, paste]");
  });
});
