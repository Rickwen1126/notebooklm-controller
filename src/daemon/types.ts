/**
 * Daemon-layer type contracts — imported by runners and the dispatcher.
 *
 * Separated from index.ts to prevent circular imports between daemon/ and agent/.
 * Follows the same pattern as scripts/types.ts.
 */

import type { CopilotClientSingleton } from "../agent/client.js";
import type { TabManager } from "../tab-manager/tab-manager.js";
import type { StateManager } from "../state/state-manager.js";
import type { CacheManager } from "../state/cache-manager.js";
import type { NetworkGate } from "../network-gate/network-gate.js";
import type { UIMap, AsyncTask, TabHandle } from "../shared/types.js";

/** Dependencies injected by the dispatcher into each runner. */
export interface RunTaskDeps {
  copilotClient: CopilotClientSingleton;
  tabManager: TabManager;
  stateManager: StateManager;
  networkGate: NetworkGate;
  cacheManager: CacheManager;
  locale: string;
  uiMap: UIMap;
}

/** A runner receives a task + acquired tab + deps, returns session result. */
export type TaskRunner = (
  task: AsyncTask,
  tabHandle: TabHandle,
  deps: RunTaskDeps,
) => Promise<{ success: boolean; result?: object; error?: string }>;
