# 技術研究報告：NotebookLM Controller MVP

**Date**: 2026-02-24 (v4 — 對齊 spec v6 MCP Server + Single Browser Multi-tab)
**Feature Branch**: `001-mvp`
**Previous Version**: 2026-02-12 v3（spec v4 BrowserPool）, 2026-02-12 v2（spec v3 multi-tab）, 2026-02-07 v1（spec v1）

<!--
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
  - 更新 Agent SDK V2 API 研究
  - 更新技術風險表
-->

## 1. 語言與框架選擇

### Decision: TypeScript 5.x + Node.js 22 LTS

**Rationale**:
- Agent SDK (`@anthropic-ai/claude-agent-sdk`) 提供 TypeScript SDK
- puppeteer-core 為 Node.js 生態系標準 CDP 工具
- 統一語言減少維護成本

**Alternatives considered**:
- Python：有 Agent SDK Python 版本，但 puppeteer-core 只有 Node.js 版本

## 2. Agent SDK V2

### Decision: `@anthropic-ai/claude-agent-sdk` V2 API (unstable preview)

**Key findings**:
- V2 API：`unstable_v2_createSession` / `unstable_v2_resumeSession`
  明確的 session 生命週期管理，適合 daemon 架構
- 每個 session 獨立上下文，可自動 compact
- Sessions 自動持久化到磁碟（`~/.claude/projects/`），可跨 process restart resume
- 支援 1M token context window（Claude Opus 4.6，beta flag `context-1m-2025-08-07`）
- Auto-compact 在 ~83.5% context window（~167K tokens for 200K）觸發

**Custom tool 定義**:
```typescript
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const screenshotTool = tool(
  "screenshot",
  "Take a screenshot of the current page",
  { pageId: z.string() },
  async (args) => {
    const base64 = await connectionManager.screenshot(args.pageId);
    return {
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: base64 } }],
      isError: false
    };
  }
);

const mcpServer = createSdkMcpServer({
  name: "nbctl-agent-tools",
  version: "1.0.0",
  tools: [screenshotTool, clickTool, typeTool, ...]
});
```

**Vision 輸入格式**:
```typescript
// 標準 Anthropic API base64 image content block
{ type: "image", source: { type: "base64", media_type: "image/png", data: "<base64>" } }
```
支援 PNG、JPEG、GIF、WebP。

**Architecture pattern** (updated for v6 — MCP Server + Single Browser Multi-tab):
```
Daemon process (MCP Server, Streamable HTTP)
├── TabManager: manage single Chrome instance, multi-tab (CDP sessions)
├── NetworkGate: acquirePermit() / reportAnomaly()
├── SessionManager: Map<notebookAlias, SessionState>
├── 每個 notebook 一個 agent session + 獨立 tab（CDP session）
├── session.send() 發送指令，session.stream() 取得結果
├── Session 自動持久化，daemon 重啟後可 resume
├── Agent tools 透過 createSdkMcpServer 注入
├── MCP tools/list 自描述（不需額外 Skill Template）
└── MCP notification 推送非同步操作結果
```

**Known limitations**:
- V2 API 為 unstable preview，API 可能變更
- Session forking 在 V2 尚不可用
- Vision 分析每張截圖 ~1000+ tokens

**Mitigation**:
- 封裝 adapter layer，隔離 SDK API 變動
- Auto-compact 自動處理 token 限制
- 截圖在 daemon 隔離 context 中消耗，不影響使用者的 AI 工具 context

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
| Agent SDK V2 API unstable | API 可能變更 | 封裝 adapter layer，隔離 SDK 依賴 |
| NotebookLM UI 更新破壞 agent | 操作失敗 | Vision-based 而非 selector-based；失敗時回報截圖 |
| 截圖 token 消耗大 | 上下文膨脹 | SDK 自動 compact（1M context）；限制單次操作截圖數 |
| Single Chrome instance tab 記憶體累積 | 長期運行記憶體增長 | 操作完畢關閉 tab；daemon 定期 healthcheck |
| Agent 佔用 tab 不歸還 | tab 泄漏 | TabManager timeout 強制關閉 tab |
| Google session 過期 | 操作失敗 | 偵測 302 redirect → 提示 `reauth` MCP tool |
| NotebookLM rate limiting | 操作被拒 | NetworkGate exponential backoff |
| Headless 渲染與 headed 不一致 | Vision agent 判斷錯誤 | 使用 `headless: true`（new headless，完整 Chrome 引擎） |
| MCP client 斷線時通知丟失 | 使用者錯過通知 | 通知資訊保留在 AsyncTask 狀態，client 可透過 `get_status` 查詢 |
| Daemon crash 後資料不一致 | 任務狀態錯誤 | Atomic write + crash recovery（FR-108） |
