import type {
  NotebookCatalogMetadata,
  NotebookCatalogRole,
  NotebookEntry,
} from "./types.js";

const COMPOUND_DOMAINS = new Set([
  "ai-tool",
]);

const ROLE_MARKERS = new Set<NotebookCatalogRole>([
  "canonical",
  "reference",
  "practice",
  "guide",
  "idioms",
  "blueprint",
  "strategy",
  "source",
  "core",
  "book",
  "implementation",
]);

const ROLE_ORDER: Record<NotebookCatalogRole, number> = {
  canonical: 0,
  core: 1,
  reference: 2,
  practice: 3,
  guide: 4,
  idioms: 5,
  blueprint: 6,
  source: 7,
  implementation: 8,
  book: 9,
  strategy: 10,
};

export interface NotebookIndexItem {
  alias: string;
  title: string;
  url: string;
  description: string;
  status: NotebookEntry["status"];
  sourceCount: number;
  domain: string;
  topic: string;
  role: NotebookCatalogRole | null;
  isDefault: boolean;
}

export interface NotebookIndexTopicGroup {
  topic: string;
  canonicalAlias: string | null;
  notebooks: NotebookIndexItem[];
}

export interface NotebookIndexDomainGroup {
  domain: string;
  topics: NotebookIndexTopicGroup[];
}

export interface NotebookIndexResult {
  total: number;
  defaultNotebook: string | null;
  domains: NotebookIndexDomainGroup[];
}

function parseAliasCatalog(alias: string): {
  domain: string;
  topic: string;
  role: NotebookCatalogRole | null;
} {
  const parts = alias.split("-").filter(Boolean);
  if (parts.length === 0) {
    return { domain: "uncategorized", topic: alias, role: null };
  }

  let domain = parts[0];
  let rest = parts.slice(1);

  if (parts.length >= 2) {
    const maybeCompound = `${parts[0]}-${parts[1]}`;
    if (COMPOUND_DOMAINS.has(maybeCompound)) {
      domain = maybeCompound;
      rest = parts.slice(2);
    }
  }

  let role: NotebookCatalogRole | null = null;
  if (rest.length > 0) {
    const last = rest[rest.length - 1] as NotebookCatalogRole;
    if (ROLE_MARKERS.has(last)) {
      role = last;
      rest = rest.slice(0, -1);
    }
  }

  const topic = rest.join("-") || domain;
  return { domain, topic, role };
}

function getNotebookCatalog(entry: NotebookEntry): {
  domain: string;
  topic: string;
  role: NotebookCatalogRole | null;
} {
  const catalog = entry.catalog as NotebookCatalogMetadata | undefined;
  if (catalog?.domain || catalog?.topic || catalog?.role) {
    return {
      domain: catalog.domain ?? "uncategorized",
      topic: catalog.topic ?? catalog.domain ?? entry.alias,
      role: catalog.role ?? null,
    };
  }
  return parseAliasCatalog(entry.alias);
}

function compareRole(a: NotebookCatalogRole | null, b: NotebookCatalogRole | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return ROLE_ORDER[a] - ROLE_ORDER[b];
}

function sortTopicNotebooks(a: NotebookIndexItem, b: NotebookIndexItem): number {
  const roleCmp = compareRole(a.role, b.role);
  if (roleCmp !== 0) return roleCmp;
  return a.alias.localeCompare(b.alias);
}

function pickCanonicalAlias(notebooks: NotebookIndexItem[]): string | null {
  const explicit = notebooks.find((nb) => nb.role === "canonical");
  if (explicit) return explicit.alias;
  const core = notebooks.find((nb) => nb.role === "core");
  if (core) return core.alias;
  return null;
}

export function buildNotebookIndex(
  notebooks: Record<string, NotebookEntry>,
  defaultNotebook: string | null,
): NotebookIndexResult {
  const domains = new Map<string, Map<string, NotebookIndexItem[]>>();

  for (const entry of Object.values(notebooks)) {
    const catalog = getNotebookCatalog(entry);
    const item: NotebookIndexItem = {
      alias: entry.alias,
      title: entry.title,
      url: entry.url,
      description: entry.description,
      status: entry.status,
      sourceCount: entry.sourceCount,
      domain: catalog.domain,
      topic: catalog.topic,
      role: catalog.role,
      isDefault: entry.alias === defaultNotebook,
    };

    const domainTopics = domains.get(item.domain) ?? new Map<string, NotebookIndexItem[]>();
    const topicItems = domainTopics.get(item.topic) ?? [];
    topicItems.push(item);
    domainTopics.set(item.topic, topicItems);
    domains.set(item.domain, domainTopics);
  }

  const domainGroups: NotebookIndexDomainGroup[] = [...domains.entries()]
    .map(([domain, topics]) => ({
      domain,
      topics: [...topics.entries()]
        .map(([topic, items]) => {
          const notebooksForTopic = [...items].sort(sortTopicNotebooks);
          return {
            topic,
            canonicalAlias: pickCanonicalAlias(notebooksForTopic),
            notebooks: notebooksForTopic,
          };
        })
        .sort((a, b) => a.topic.localeCompare(b.topic)),
    }))
    .sort((a, b) => a.domain.localeCompare(b.domain));

  return {
    total: Object.keys(notebooks).length,
    defaultNotebook,
    domains: domainGroups,
  };
}
