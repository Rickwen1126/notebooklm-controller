# 技術研究報告：NotebookLM Controller MVP

**Date**: 2026-03-10 (v5 — 補充 spec v7 SHIP 決策 + 運維設計)
**Feature Branch**: `001-mvp`
**Previous Version**: 2026-02-24 v4（spec v6 MCP+Multi-tab）, 2026-02-12 v3（spec v4 BrowserPool）, 2026-02-12 v2（spec v3 multi-tab）, 2026-02-07 v1（spec v1）

<!--
  v5 更新摘要（SHIP B/R/N 解除 + spec v7 設計決策）：
  - 新增 Section 14: Daemon 運維設計（Shutdown、Chrome crash recovery、PID double-check）
  - 新增 Section 15: Agent Task 設計原則（stateless per run、細粒度、Tool 自包）
  - 更新技術風險表（新增 SHIP 解除後的緩解策略）

  v4 更新摘要（MCP Server + Single Browser Multi-tab pivot）：
  - Browser Automation：BrowserPool（多 Chrome instance）→ Single Browser Multi-tab（一 Chrome 多 tab）
  - Cookie injection 移除 → userDataDir 共享認證
  - AuthManager 移除 → 不需獨立模組
  - HTTP Server：Fastify → MCP Server（@modelcontextprotocol/sdk, Streamable HTTP）
  - CLI Framework：Commander.js → 移除（薄啟動器 npx nbctl 取代）
  - Notification Inbox：檔案型 inbox → MCP notification 直接推送
  - Claude Code Hooks：Hook 腳本移除（MCP notification 取代）
  - 更新技術風險表

  v3 更新摘要（BrowserPool 架構 pivot）：
  - Browser Automation section 重寫：multi-tab → BrowserPool 模型
  - 新增 BrowserPool 設計研究（中央集權管理 + 全權委派）
  - 新增 Cookie injection 可行性研究（setCookie vs userDataDir + SingletonLock）
  - 新增 Agent 自我修復能力分析
  - 更新 Cookie 持久化為 injection 模式
  - Network 監控 → NetworkGate permit-based 模型
  - 更新技術風險表

  v2 更新摘要：
  - 移除 MCP Server 相關研究（spec v3 已移除 MCP）
  - 新增 Chrome 生命週期管理研究（daemon 自管 Chrome）
  - 新增 Multi-tab CDP 操作研究（critical finding: background tab 不可靠）
  - 新增 Cookie 持久化研究
  - 新增 Headless/Headed 模式研究
  - 新增 Notification Inbox 設計研究
  - 新增 Claude Code Hooks 整合研究
  - 新增 Network 監控研究
  - 更新 Copilot SDK API 研究
  - 更新技術風險表
-->

## 1. 語言與框架選擇

### Decision: TypeScript 5.x + Node.js 22 LTS

**Rationale**:
- Copilot SDK (`@github/copilot-sdk`) 提供 TypeScript SDK
- puppeteer-core 為 Node.js 生態系標準 CDP 工具
- 統一語言減少維護成本

**Alternatives considered**:
- Python：Copilot SDK 有 Python 版本，但 puppeteer-core 只有 Node.js 版本

## 2. Copilot SDK

### Decision: `@github/copilot-sdk`（Technical Preview, v0.1.32+）

**v5 重大更新**：基於 SDK 原始碼和 README 完整研究，確認 API 實際結構。

**核心架構**:
- `CopilotClient` — 管理 Copilot CLI server process lifecycle（JSON-RPC over stdio）
- `CopilotSession` — 單一對話 session，支援 multi-turn、streaming、event-driven
- `defineTool()` — 型別安全 tool 定義（Zod schema + handler）
- `CustomAgentConfig` — 自訂 agent 定義（prompt + tool 限制 + MCP servers）

**Import pattern**:
```typescript
import { CopilotClient, defineTool, approveAll } from "@github/copilot-sdk";
import { z } from "zod";
```

**CopilotClient（singleton for daemon）**:
```typescript
const client = new CopilotClient({
  autoStart: true,
  autoRestart: true,    // CLI crash → 自動重啟
  logLevel: "info",
  // BYOK 模式：
  // provider 設定在 session 層級，不在 client 層級
});
await client.start();
```

**Session 建立（per task/notebook）**:
```typescript
const session = await client.createSession({
  model: "claude-sonnet-4.5",  // 或其他 Copilot 可用模型
  tools: [...browserTools, ...contentTools, ...stateTools],
  systemMessage: {
    mode: "append",          // 保留 SDK 預設 persona + 安全 guardrails
    content: skillPrompt,    // 附加 skill-specific prompt
  },
  customAgents: [agentConfig],  // 可選：自訂 agent 定義
  agent: agentConfig.name,      // 啟動時使用指定 agent
  onPermissionRequest: approveAll,  // daemon 控制一切，auto-approve
  streaming: true,
  hooks: {
    onPreToolUse: async (input) => { /* NetworkGate acquirePermit */ },
    onErrorOccurred: async (input) => { /* 錯誤處理策略 */ },
    onSessionEnd: async (input) => { /* 清理 tab handle */ },
  },
});
```

**Custom tool 定義（defineTool + Zod）**:
```typescript
const screenshotTool = defineTool("screenshot", {
  description: "Take a screenshot of the current NotebookLM page",
  parameters: z.object({
    fullPage: z.boolean().optional().describe("Capture full page or viewport only"),
  }),
  handler: async ({ fullPage }, invocation) => {
    const base64 = await cdpSession.send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: fullPage ?? false,
    });
    // Tool 自包：screenshot tool 自行截圖 + 格式轉換
    return {
      textResultForLlm: "Screenshot captured successfully.",
      binaryResultsForLlm: [{
        data: base64.data,
        mimeType: "image/png",
        type: "image",
        description: "Current page screenshot",
      }],
      resultType: "success" as const,
    } satisfies ToolResultObject;
  },
});
```

**Main Agent vs Subagent 架構**:

createSession 時，Copilot CLI runtime 自帶 main agent（Copilot 本身），
你傳的 `customAgents` 全部是 subagent 候選。`infer: true`（預設）的 subagent
會被轉成 `task:xxx` tool 注入 main agent 的 tool list，由 main agent 的 model
自動決定何時呼叫哪個 subagent。

```
Main Agent (Copilot runtime 內建)
  ├── built-in tools: grep, glob, view, edit, bash, ...
  ├── task:add-source   ← customAgent infer:true → 變成 tool
  └── task:query        ← customAgent infer:true → 變成 tool

Subagent "add-source" 被呼叫時
  └── 只看到自己 config 裡列的 tools: screenshot, click, type, paste, repoToText
      （不看到其他 subagent，不看到 main agent 的 built-in tools）
```

**關鍵規則**：
- Main agent 是 Copilot runtime，不需要也不能由我們定義
- `systemMessage` 可追加指令給 main agent（mode: "append" 保留預設 prompt）
- Subagent 之間互相看不到，不能互相呼叫
- Subagent 的 tools 是 per-agent 白名單（防線 1），不繼承 main agent 的 tool list
- 我們的 daemon 是 createSession 的呼叫者，不是 agent

**對我們架構的意義**：
- 每個 agent config YAML 對應 customAgents 陣列的一個 entry
- `requiredTools` 就是 subagent 的 tool 白名單
- `promptTemplate` 就是 subagent 的 prompt
- main agent 的 `systemMessage` 用來設定全局行為（例如 NotebookLM 操作通則）

**Custom Agent Config 定義**:
```typescript
const addSourceAgent: CustomAgentConfig = {
  name: "add-source",
  displayName: "Add Source",
  description: "Add content to NotebookLM as a source",
  prompt: `You are operating NotebookLM to add a new source...
    Steps: 1. screenshot to see current state 2. click "Add source"...`,
  tools: ["screenshot", "click", "type", "paste", "repoToText", "urlToText", "pdfToText"],
};
```

**Session 執行 & 結果收集**:
```typescript
// 方法 1：sendAndWait（簡單操作）
const result = await session.sendAndWait({
  prompt: task.command,
  attachments: task.screenshot ? [{ type: "file", path: screenshotPath }] : undefined,
});

// 方法 2：event-driven（需追蹤進度的操作）
session.on("tool.execution_start", (event) => {
  updateTaskProgress(task.taskId, `Running ${event.data.toolName}...`);
});
session.on("assistant.message", (event) => {
  // 最終回答
});
```

**Session 生命週期**:
```
createSession() → send()/sendAndWait() → disconnect()
                                          ↑
                  可多次 send()（multi-turn conversation）
```
- `disconnect()` 保留 session data on disk，可 `resumeSession()` 恢復
- `infiniteSessions` 預設啟用：80% context 自動 compact、95% 阻塞等待

**Architecture pattern** (v5 — 基於 SDK 實際 API):
```
Daemon process (MCP Server, Streamable HTTP)
├── CopilotClient (singleton)
│   └── manages Copilot CLI server process (JSON-RPC)
├── TabManager: Chrome instance → tabs → CDP sessions
├── NetworkGate: acquirePermit() / reportAnomaly()
├── Per-task execution:
│   ├── createSession({ tools, agent, hooks })
│   ├── session.sendAndWait({ prompt })
│   └── session.disconnect()
├── Tools (defineTool + Zod):
│   ├── Browser tools: screenshot, click, type, scroll, paste (CDP-based)
│   ├── Content tools: repoToText, urlToText, pdfToText
│   └── State tools: reportRateLimit, updateCache
├── Agent Configs → CustomAgentConfig (prompt + tool restriction)
├── MCP tools/list 自描述
└── MCP notification fire-and-forget
```

**Known limitations**:
- Technical Preview（v0.1.32），API 可能變更
- JSON-RPC 與 Copilot CLI 的通訊開銷待實測
- Vision（截圖→model）token 消耗待確認
- `binaryResultsForLlm` 接受的格式和大小限制待 Spike 1 驗證

**Mitigation**:
- SDK 的 `CopilotClient`/`CopilotSession`/`defineTool` 已是穩定抽象
- 如 API 變更，影響範圍限於 `agent/` 模組
- Copilot SDK 支援多模型，可選擇最適合 vision 操作的模型
- Infinite sessions 自動管理 context，減少 token 管理負擔

**Spike 1 驗證項目**:
1. `binaryResultsForLlm` 回傳截圖後，agent 是否能正確分析圖片內容
2. `onPreToolUse` hook 插入 `acquirePermit()` 的延遲影響
3. BYOK provider 設定 + 截圖 token 消耗基準
4. `disconnect()` → `resumeSession()` 的 session state 保留範圍

## 3. Browser Automation

### Decision: puppeteer-core Single Browser Multi-tab（單一 Chrome instance 多 tab）

**v6 架構**：Single Browser Multi-tab。Daemon 管理一個 Chrome instance（headless），
每個 notebook 一個 tab，agent 透過 CDP session 操作獨立 tab。

**架構演進歷程**：
1. **v3（multi-tab）→ v4（BrowserPool）**：Puppeteer 高層 API（`page.click()`）在 background tab
   不可靠（#3318, #12712），改為 BrowserPool 多 Chrome instance。
2. **v4（BrowserPool）→ v5/v6（Single Browser Multi-tab）**：Spike 0 實驗證實 CDP 底層 API
   （`Input.dispatchMouseEvent`、`Page.captureScreenshot`）在 background tab 操作完全可靠。
   先前不可靠的結論是 Puppeteer 高層 API 的問題，非 Chrome/CDP 本身限制。
   單一 Chrome instance 多 tab 降低記憶體（~900MB → ~500MB），
   且 `userDataDir` 取代 cookie injection，不需獨立 AuthManager 模組。

**Launch API**（TabManager 內部）:
```typescript
import puppeteer from "puppeteer-core";

// TabManager 啟動時 launch 單一 Chrome instance：
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  userDataDir: "~/.nbctl/profiles/",  // 共享認證，不需 cookie injection
  args: [
    "--no-first-run",
    "--disable-default-apps",
    "--window-size=1280,800"
  ]
});

// TabManager.openTab(notebookUrl) 內部：
const page = await browser.newPage();
await page.goto(notebookUrl);
const cdpSession = await page.createCDPSession();
// 回傳 TabHandle（含 cdpSession + page）
```

**Chrome 路徑探索**（macOS）:
```
優先順序:
1. 環境變數 CHROME_PATH
2. /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
3. /Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary
4. 錯誤：提示使用者安裝 Chrome 或設定 CHROME_PATH
```
注意：`.app` 是目錄，需解析到 `.../Contents/MacOS/<name>`。

### Background finding: CDP 底層 API background tab 操作可靠

**Spike 0 實驗結論**（推翻 v3 研究結果）：

| 操作 | Puppeteer 高層 API | CDP 底層 API | 說明 |
|------|-------------------|-------------|------|
| screenshot | **不可靠** `page.screenshot()` | **可靠** `Page.captureScreenshot` | CDP 直接操作 renderer |
| click | **不可靠** `page.click()` | **可靠** `Input.dispatchMouseEvent` | CDP 直接派發事件 |
| type | **可能有問題** `page.type()` | **可靠** `Input.dispatchKeyEvent` | CDP 直接派發按鍵 |
| evaluate | **可靠** `page.evaluate()` | **可靠** `Runtime.evaluate` | JS 執行不依賴 active tab |
| navigate | **可靠** `page.goto()` | **可靠** `Page.navigate` | Navigation 不依賴 active tab |

CDP 底層 API 繞過 Puppeteer 高層封裝中的 focus/bringToFront 假設，
直接透過 Chrome DevTools Protocol 操作目標 tab 的 renderer process。

### TabManager 設計

**TabManager lifecycle**:
```
TabManager (single Chrome instance)
├── launch() → 啟動 headless Chrome（含 userDataDir 認證）
├── openTab(notebookUrl) → 建立新 tab + CDP session → 回傳 TabHandle
├── closeTab(tabId) → 關閉 tab + 清理 CDP session
├── listTabs() → 列舉所有 active tabs
├── 超時未歸還 → daemon 強制關閉 tab
└── shutdown() → 關閉所有 tab + Chrome process
```

**資源估算**：
- 單一 Chrome instance + N tabs：~500MB（vs BrowserPool 3 instances ~900MB）
- Tab 按需建立，操作完畢關閉

**Agent 防線（防 agent 發瘋）**：
1. Skill prompt — 明確操作範圍和禁止事項
2. Tab timeout — agent 超時沒歸還 → daemon 強制關閉 tab
3. NetworkGate — 即使 agent 瘋狂操作，gate 擋住異常流量
4. Operation timeout — 單一操作超時直接 kill

### 認證：userDataDir 共享

**設計**：Single Chrome instance 共享 `userDataDir`（`~/.nbctl/profiles/`），
不需 cookie extraction/injection，不需獨立 AuthManager 模組。

**認證流程**：
1. 首次啟動：daemon 以 headed mode 啟動 Chrome（`headless: false`）
2. 使用者手動完成 Google 登入
3. Cookies + session state 自動持久化至 `userDataDir`
4. 後續啟動：headless mode 直接複用 session
5. Session 過期：`reauth` MCP tool → headed mode 重新認證

**優勢（相較於 BrowserPool cookie injection）**：
- 不需 AuthManager 模組（減少一個模組）
- 不需 cookie extraction/injection 邏輯
- 不受 Chrome SingletonLock 限制（只有一個 Chrome instance）
- localStorage/IndexedDB 等 session state 自動包含

### Headless 模式

| 模式 | 設定值 | 說明 |
|------|--------|------|
| New headless（預設） | `headless: true` | Puppeteer v22+ 預設。完整 Chrome 功能，較慢 |
| Old headless shell | `headless: 'shell'` | 獨立 binary，較快，功能不完整 |
| Headed | `headless: false` | 可見視窗，用於 Google 登入 |

**專案選擇**：
- TabManager 正常運作：`headless: true`（new headless，完整 Chrome 功能）
- 首次登入 / reauth：`headless: false`（headed，使用者手動 Google login）

**Mode switching**：TabManager 啟動時根據是否有有效 session 決定 headless/headed。
`reauth` MCP tool 流程：關閉 headless Chrome → launch headed Chrome → 完成登入 → 關閉 → 重新 launch headless。

## 4. Content Pipeline

### Decision: repomix + Readability + pdf-parse

（v1 研究結論不變）

**repoToText**: `repomix` npm 套件
- 程式化 API，支援 XML/Markdown/JSON/Plain text 輸出
- 內建 token 計算（Tiktoken）
- `--compress` 模式用 Tree-sitter 減少 ~70% tokens
- 自動尊重 .gitignore，偵測 binary 與敏感資料

**urlToText**: `@mozilla/readability` + `jsdom`
- Mozilla Readability 擷取文章主體
- jsdom 解析 HTML DOM

**pdfToText**: `pdf-parse`
- 簡單直接，適合文字 PDF
- 複雜排版 PDF 可用 `pdfjs-dist`（非 MVP 範圍）

## 5. MCP Server

### Decision: `@modelcontextprotocol/sdk`（Streamable HTTP transport）

**v6 重大變更**：從 Fastify HTTP API 改為 MCP Server。

**Rationale**:
- 主要消費者為 AI agent（Claude Code 等），MCP 是 AI 工具的原生協議
- MCP tool 自描述（tools/list），不需額外 Skill Template
- MCP 持續連線（Streamable HTTP），非同步通知可直接推送
- 砍掉 CLI 模組（18 command files）、Fastify、commander 依賴

**Transport**: Streamable HTTP（`127.0.0.1:19224`）
- Daemon 獨立於 client 存活，支援多 client 同時連線
- 適合 AI 工具的 MCP client 設定（如 Claude Code `mcp.json`）

**Alternatives considered**:
- Fastify HTTP API + CLI wrapper：過多膠水層，CLI 只是 thin HTTP client
- stdio transport：不支援 daemon 獨立存活，無法多 client 連線

## 6. State Persistence

### Decision: JSON 檔案 + atomic write

（v1 研究結論不變，更新目錄結構）

**Storage location**: `~/.nbctl/` 目錄（權限 700）
```
~/.nbctl/
├── profiles/               # Chrome userDataDir（session + cookies，共享認證）
├── state.json              # Notebook Registry + default notebook + daemon PID
├── cache/<notebook-alias>/ # Per-notebook 來源元資料、artifacts 紀錄
├── tasks/                  # Async task 狀態檔案
├── skills/                 # Agent skill 定義檔案
└── logs/                   # 操作日誌
```

**v6 變更**：移除 `inbox/`（MCP notification 取代檔案型通知）、`hooks/`（不需 adapter hook 腳本）。
`profiles/chrome/` 簡化為 `profiles/`（userDataDir 直接使用）。

**Atomic write pattern**:
```typescript
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  await fs.writeFile(tempPath, data, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
}
```

## 7. CLI Framework

### Decision: 移除（v6 — MCP Server 取代）

**v6 變更**：CLI 模組（Commander.js）整個移除。所有功能透過 MCP tool 暴露。

**Thin launcher**：`npx nbctl` 僅負責 daemon 程序管理（start/stop/status），
不是完整 CLI framework。實作為簡單的 `process.argv` 解析，不需 Commander.js。

**Historical note**：
v1~v5 使用 Commander.js 支援 18 個子命令。v6 pivot 後，這些子命令
全部轉為 14 個 MCP tool（exec, get_status, list_notebooks 等）。

## 8. Notification 設計

### Decision: MCP notification 直接推送（v6 — 取代檔案型 inbox）

**v6 變更**：檔案型 per-session inbox 整個移除。改為 MCP notification 直接推送。

**Key design**:
- 非同步操作（`exec` tool 帶 `async: true`）完成後，daemon 透過 MCP notification
  推送結果至所有連線中的 client
- MCP protocol 內建 notification 機制，不需自建 inbox + adapter + hook

**通知格式**（MCP notification payload）:
```json
{
  "taskId": "abc123",
  "status": "completed",
  "notebook": "research",
  "result": { "success": true, "sourceAdded": "my-project (repo)" },
  "originalContext": "把 repo 加入來源",
  "timestamp": "2026-02-12T10:30:00Z"
}
```

**離線 client 處理**：
- 若無 client 連線，通知不會丟失——資訊保留在 AsyncTask 狀態中
- Client 重新連線後可透過 `get_status` MCP tool 查詢任務結果

**Alternatives considered（歷史記錄）**:
- 檔案型 inbox（v3~v5）：per-session JSON 檔案 + rename consume。移除原因：MCP 持續連線可直接推送
- Claude Code Hooks adapter（v3~v5）：UserPromptSubmit hook 注入通知。移除原因：MCP notification 取代

## 9. Claude Code Hooks 整合

### Decision: 移除（v6 — MCP notification 取代）

**v6 變更**：Claude Code Hooks 整合（UserPromptSubmit + Stop hook）整個移除。

**理由**：
- MCP Server 架構下，Claude Code 透過 MCP protocol 直接連線 daemon
- 非同步操作完成後透過 MCP notification 直接推送至 Claude Code
- 不需 hook 腳本讀取 inbox 檔案再注入 context

**Historical note**：
v3~v5 設計了 `UserPromptSubmit` hook 腳本，從 stdin 解析 `session_id` 並讀取
檔案型 inbox 通知。v6 pivot 後，這整套機制被 MCP notification 取代。

## 10. NetworkGate（集中式流量閘門）

### Decision: Permit-based gate + CDP Network domain 監控

**設計哲學**：NetworkGate 不在 data path（不 proxy 請求），只管「能不能做」。
Agent 操作前 `acquirePermit(notebookId)` 取得許可，異常時 `reportAnomaly()` 觸發全域 backoff。

**API 設計**:
```typescript
interface NetworkGate {
  acquirePermit(notebookId: string): Promise<void>;  // throttled 時等待
  reportAnomaly(type: "429" | "503" | "timeout" | "captcha"): void;  // 觸發全域 backoff
  getHealth(): NetworkHealth;  // healthy / throttled / disconnected
}
```

**Throttle detection signals**（由 agent 透過 reportAnomaly 回報）:
- HTTP 429 / 503 response
- 異常延遲（response time > 2x 平均）
- CAPTCHA / bot detection 頁面（URL pattern / DOM 特徵）

**Agent 端 CDP 監控**（在 agent 的 Chrome instance 內）:
```typescript
// Agent 在自己的 Chrome instance 中監聽 response
page.on('response', (response) => {
  if (response.url().includes('notebooklm.google.com')) {
    if (response.status() === 429 || response.status() === 503) {
      networkGate.reportAnomaly(response.status().toString());
    }
  }
});
```

**Exponential backoff**:
```
初始 delay: 5s
乘數: 2x
上限: 5 min
jitter: ±20%
恢復條件: 429/503 清除或延遲恢復正常
全域影響: backoff 期間所有 acquirePermit() 等待
```

## 11. 測試框架

### Decision: Vitest

（v1 研究結論不變）

- 原生 TypeScript 支援
- Jest 相容 API
- 內建 mock 功能

## 12. Daemon 程序管理

### Decision: child_process.fork + PID file

**Daemonization**（flow-coverage CHK016）:
- `npx nbctl` thin launcher fork 一個 child process（`node daemon/index.ts`）
- Child process 寫入 PID file：`~/.nbctl/daemon.pid`
- Parent process 確認 child 啟動後退出
- `npx nbctl stop` 讀取 PID file，發送 SIGTERM
- Daemon 收到 SIGTERM 後 graceful shutdown：關閉 MCP Server → 關閉所有 agent session → 關閉 Chrome → 清理 PID file
- 亦可透過 `shutdown` MCP tool 觸發 graceful shutdown

**Signal handling**:
```typescript
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
// SIGKILL 不可捕獲，依賴 state persistence 恢復
```

## 13. 技術風險與緩解

| 風險 | 影響 | 緩解策略 |
|------|------|----------|
| Copilot SDK Technical Preview | API 可能變更 | 封裝 adapter layer，隔離 SDK 依賴 |
| NotebookLM UI 更新破壞 agent | 操作失敗 | Vision-based 而非 selector-based；失敗時回報截圖 |
| 截圖 token 消耗大 | 上下文膨脹 | SDK 自動 compact（1M context）；限制單次操作截圖數 |
| Single Chrome instance tab 記憶體累積 | 長期運行記憶體增長 | 操作完畢關閉 tab；daemon 定期 healthcheck |
| Agent 佔用 tab 不歸還 | tab 泄漏 | TabManager timeout 強制關閉 tab |
| Google session 過期 | 操作失敗 | 偵測 302 redirect → 提示 `reauth` MCP tool |
| NotebookLM rate limiting | 操作被拒 | NetworkGate exponential backoff |
| Headless 渲染與 headed 不一致 | Vision agent 判斷錯誤 | 使用 `headless: true`（new headless，完整 Chrome 引擎） |
| MCP client 斷線時通知丟失 | 使用者錯過通知 | 通知資訊保留在 AsyncTask 狀態，client 可透過 `get_status` 查詢 |
| Daemon crash 後資料不一致 | 任務狀態錯誤 | Atomic write + crash recovery（FR-108） |
| PID file 殘留導致誤判 daemon 在運行 | 無法啟動新 daemon | PID file 存 `{ pid, startedAt }`，雙重檢查防 PID 重用 |
| Daemon SIGKILL 無法 cleanup | Agent 操作中斷 | Task queue 恢復：queued 恢復、running 標記 failed |

## 14. Daemon 運維設計

### Decision: 不做 graceful agent shutdown + task queue 恢復

**v7 新增**（SHIP B/R/N 解除後的設計決策）。

**Shutdown 策略**:
- 不做 agent-level graceful shutdown。Vision agent 單步操作可能耗時數分鐘，
  等待 agent 完成不切實際。Graceful shutdown handler 本身也不可靠
  （SIGKILL/OOM 直接繞過 handler）。
- 關閉策略：直接終止 process。
- 恢復策略：task queue 負責。重啟後：
  - `queued` 任務恢復為 `queued`
  - `running` 任務標記為 `failed`（reason: "daemon interrupted"）
  - Agent task 設計為細粒度，每步進度外部化，最多重做一個小步驟。

**Chrome crash recovery**:
- Chrome 對 daemon 至關重要（所有 agent 的工作環境）。
- `browser.on('disconnected')` → 立即通知所有 agent 停止工作 →
  重啟 Chrome → agent 從 task queue 的上一個完成點接手。
- Chrome 重啟後所有 tab handle 失效，需重建。

**PID file 雙重檢查**:
```typescript
interface PidFile {
  pid: number;
  startedAt: string; // ISO 8601
}

// 驗證邏輯：
// 1. 讀取 PID file
// 2. 檢查 process 是否存在（process.kill(pid, 0)）
// 3. 檢查 startedAt 是否與 process 啟動時間吻合
// 4. 兩者都通過 → daemon 正在運行
// 5. 任一不通過 → stale PID file，可覆寫
```
防止 OS 重用 PID 給其他 process 導致的誤判。

**Rationale**:
- Graceful shutdown 是「假安全」——無法處理最常見的失敗情境（SIGKILL, OOM, crash）
- Task queue + atomic write 提供真正的 crash safety
- 簡化程式碼：不需複雜的 shutdown coordinator

## 15. Agent Task 設計原則

### Decision: Stateless per run + 細粒度 + Tool 自包

**v7 新增**（SHIP B/R/N 解除後的設計決策）。

**Agent conceptually stateless per run**:
- Task 切為細粒度步驟，每步完成後進度外部化至 task store。
- 每個 run 完成後，任何無記憶的 agent 都能從 task store 接手。
- Session 內部有 state（對話記憶），但架構不依賴 session persistence。
- 類比 message queue consumer：consumer 是 stateless 的，state 在 queue 裡。

**Daemon vs Agent 分工**:
- Daemon 是指揮者：調度任務、提供工具、設定目標、管理全局狀態。
- Agent 是執行者：自主使用 tool 完成單一細粒度任務。
- Daemon 不中轉 agent 的操作邏輯。

**Tool 自包原則**:
- Screenshot tool 自行透過 CDP 截圖 + 格式轉換，回傳給 Copilot CLI agent。
- Daemon 不做「接收截圖 → 轉換 → 回傳」的中轉。
- 每個 tool 封裝完整操作邏輯，agent 直接呼叫即得結果。

**429 偵測**:
- 不規範偵測方式（CDP 或視覺分析都可），agent 自主決定。
- Daemon 提供 `reportRateLimit` tool 讓 agent 回報。
- NetworkGate 負責 backoff 決策。

**MCP notification fire-and-forget**:
- 不補發。MCP 對 client 而言是可重試的資料來源，非 mission-critical 即時通道。
- Client 斷線後重新連線可透過 `get_status` tool 查詢結果。
