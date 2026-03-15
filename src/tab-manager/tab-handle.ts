/**
 * Factory function for creating TabHandle instances.
 *
 * A TabHandle is a runtime-only reference to an active Chrome tab
 * managed by the TabManager.
 */

import { randomUUID } from "node:crypto";
import type { CDPSession, Page } from "puppeteer-core";
import type { TabHandle } from "../shared/types.js";
import { DEFAULT_SESSION_TIMEOUT_MS } from "../shared/config.js";

export function createTabHandle(params: {
  notebookAlias: string;
  url: string;
  cdpSession: CDPSession;
  page: Page;
  timeoutMs?: number;
}): TabHandle {
  const now = new Date();
  const timeoutMs = params.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const timeoutAt = new Date(now.getTime() + timeoutMs);

  return {
    tabId: randomUUID(),
    notebookAlias: params.notebookAlias,
    url: params.url,
    state: "active",
    acquiredAt: now.toISOString(),
    timeoutAt: timeoutAt.toISOString(),
    releasedAt: null,
    cdpSession: params.cdpSession,
    page: params.page,
  };
}
