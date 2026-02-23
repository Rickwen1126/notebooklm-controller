# 技術研究報告：NotebookLM Controller MVP

**Date**: 2026-02-12 (v3 — 對齊 spec v4 BrowserPool 架構)
**Feature Branch**: `001-mvp`
**Previous Version**: 2026-02-12 v2（spec v3 multi-tab）, 2026-02-07 v1（spec v1）

<!--
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

**Architecture pattern** (updated for v4 — BrowserPool):
```
Daemon process
├── BrowserPool: manage N headless Chrome instances (max=3)
├── AuthManager: cookie extraction + injection
├── NetworkGate: acquirePermit() / reportAnomaly()
├── SessionManager: Map<notebookAlias, SessionState>
├── 每個 notebook 一個 agent session + 獨立 Chrome instance
├── session.send() 發送指令，session.stream() 取得結果
├── Session 自動持久化，daemon 重啟後可 resume
└── Agent tools 透過 createSdkMcpServer 注入
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

### Decision: puppeteer-core BrowserPool（多 headless Chrome instance）

**v4 重大變更**：從 multi-tab（1 Chrome N tabs）改為 BrowserPool（N headless Chrome instances）。

**架構 pivot 理由**：
1. **序列化讓 multi-tab 優勢消失**：Puppeteer research 確認 background tab 的
   screenshot/click 不可靠（#3318, #12712），必須序列化所有 vision 操作。
   序列化後 multi-tab 唯一好處只剩省 navigate 時間，不值得整個 ConnectionManager 抽象。
2. **BoundTools interface 限制 agent 自我修復能力**：multi-tab 下 agent 拿到的是
   bounded interface（`click(pageId, x, y)`），遇到意外（modal dialog、redirect）
   只能回報錯誤，需額外 repair agent + unsolved problem queue。
   若 agent 有完整 Chrome instance，可自己截圖分析、retry、關 modal → 可靠度大幅提升。
3. **BrowserPool 天然支援真正 parallel**：每個 agent session 獨立 Chrome instance，
   無需 bringToFront 序列化，跨 notebook 操作真正平行。

**Launch API**（BrowserPool 內部，per instance）:
```typescript
import puppeteer from "puppeteer-core";

// BrowserPool.acquire(notebookUrl) 內部：
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,  // Pool 中的 instance 全部 headless
  args: [
    "--no-first-run",
    "--disable-default-apps",
    "--window-size=1280,800"
  ]
  // 注意：不使用 userDataDir（改用 cookie injection）
});

// 注入 cookies（從 AuthManager 取得）
const context = browser.defaultBrowserContext();
await context.setCookie(...storedCookies);

// Navigate 到目標 notebook
const page = await browser.newPage();
await page.goto(notebookUrl);
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

### Background finding: Multi-tab 並行操作不可靠（促使架構 pivot）

**研究結果**（Puppeteer GitHub #3318、#12712、PR #12724）：

| 操作 | 非 active tab | 說明 |
|------|-------------|------|
| `page.screenshot()` | **不可靠** | 可能 timeout，即使 headless 模式 |
| `page.click()` | **不可靠** | 背景 tab 中 click 已知問題 |
| `page.type()` | **可能有問題** | 依賴焦點狀態 |
| `page.evaluate()` | **可靠** | JS 執行不依賴 active tab |
| `page.goto()` | **可靠** | Navigation 不依賴 active tab |

此發現直接促成從 multi-tab 改為 BrowserPool 的架構 pivot。

### BrowserPool 設計

**Pool lifecycle**:
```
BrowserPool (max N=3)
├── acquire(notebookUrl) → launch headless Chrome + inject cookies + navigate
│   → 回傳完整 Browser instance
├── release(instanceId) → 關閉 Chrome process，歸還 slot
├── 超時未歸還 → daemon 強制 kill Chrome process 並歸還 slot
└── healthcheck() → 檢查所有 active instance 是否回應
```

**資源估算**：
- 每個 headless Chrome instance ~300MB RAM
- Pool max=3 → ~900MB（vs multi-tab ~500MB，差 400MB 可接受）
- 不是每個 notebook 常駐一個 Chrome，需要操作時才 acquire

**Agent 防線（防 agent 發瘋）**：
1. Skill prompt — 明確操作範圍和禁止事項
2. BrowserPool timeout — agent 超時沒歸還 → daemon 強制回收
3. NetworkGate — 即使 agent 瘋狂操作，gate 擋住異常流量
4. Operation timeout — 單一操作超時直接 kill

### Cookie Injection 可行性

**問題**：Chrome 對 `userDataDir` 有 SingletonLock，同一 `userDataDir` 不能被
多個 Chrome instance 同時使用。BrowserPool 需要多個 instance 共享認證。

**解法**：Cookie injection（不使用 userDataDir）

**AuthManager 流程**：
1. 首次登入：launch headed Chrome（有 userDataDir）→ 使用者完成 Google login
2. 擷取 cookies：`BrowserContext.cookies()` 取得所有 Google cookies
   - 重要 cookies：SID, HSID, SSID, APISID, `__Secure-1PSID`, `__Secure-3PSID` on `.google.com`
3. 儲存：`~/.nbctl/profiles/cookies.json`（權限 600）
4. 關閉 headed Chrome
5. 後續每個 headless Chrome instance 啟動後注入：
   ```typescript
   const context = browser.defaultBrowserContext();
   await context.setCookie(...storedCookies);
   ```

**API 注意事項**：
- `page.cookies()` / `page.setCookie()` 已 deprecated
- 改用 `BrowserContext.cookies()` / `BrowserContext.setCookie()`
- Cookie 設定需在 navigate 之前完成

**風險**：
- NotebookLM 可能不只靠 cookies（可能有 localStorage/IndexedDB auth state）
- 需實測驗證 cookie injection 是否足以建立有效 session
- Mitigation：若 cookies 不夠，可嘗試 CDP `Storage.getStorageItems` + `Storage.setStorageItems`

### Headless 模式

| 模式 | 設定值 | 說明 |
|------|--------|------|
| New headless（預設） | `headless: true` | Puppeteer v22+ 預設。完整 Chrome 功能，較慢 |
| Old headless shell | `headless: 'shell'` | 獨立 binary，較快，功能不完整 |
| Headed | `headless: false` | 可見視窗，用於 Google 登入 |

**專案選擇**：
- BrowserPool instances：`headless: true`（new headless，完整 Chrome 功能）
- AuthManager 首次登入：`headless: false`（headed，使用者手動 Google login）

**Mode switching**：BrowserPool 中的 instance 始終 headless。
AuthManager 認證 Chrome 獨立於 pool，僅用於登入。
`nbctl reauth` 流程：launch headed Chrome → 完成登入 → 擷取 cookies → 更新儲存 → 關閉。

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

## 5. HTTP Server

### Decision: Fastify

（v1 研究結論不變）

- 高效能（比 Express 快 2-3x）
- 內建 JSON schema validation
- 良好的 TypeScript 支援

## 6. State Persistence

### Decision: JSON 檔案 + atomic write

（v1 研究結論不變，更新目錄結構）

**Storage location**: `~/.nbctl/` 目錄（權限 700）
```
~/.nbctl/
├── profiles/chrome/        # Chrome userDataDir（session + cookies）
├── state.json              # Notebook Registry + default notebook + daemon PID
├── cache/<notebook-alias>/ # Per-notebook 來源元資料、artifacts 紀錄
├── tasks/                  # Async task 狀態檔案
├── inbox/                  # Notification Inbox
│   ├── <session-id>/
│   │   ├── urgent/         # 失敗操作通知
│   │   ├── normal/         # 成功操作通知
│   │   └── consumed/       # 已消費通知（audit trail）
│   └── _default/           # 無 session-id 時的 fallback
├── hooks/                  # Adapter hook 腳本
├── skills/                 # Agent skill 定義檔案
└── logs/                   # 操作日誌
```

**Atomic write pattern**:
```typescript
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  await fs.writeFile(tempPath, data, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
}
```

## 7. CLI Framework

### Decision: Commander.js

（v1 研究結論不變）

支援子命令：start, stop, status, list, open, close, use, add, add-all, exec,
rename, remove, cancel, reauth, skills, install-hooks, uninstall-hooks, export-skill。

## 8. Notification Inbox 設計

### Decision: 檔案型 per-session inbox + rename consume

**Key design**:
- 每個通知為獨立 JSON 檔案：`~/.nbctl/inbox/<session-id>/<priority>/task-<taskId>.json`
- 寫入：atomic write（temp + rename）
- 消費：rename 到 `consumed/`（保留 audit trail）
- 清理：daemon 定期清除 >24h 的 consumed 通知

**通知格式**:
```json
{
  "taskId": "abc123",
  "status": "completed",
  "notebook": "research",
  "result": { "success": true, "sourceAdded": "my-project (repo)" },
  "originalContext": "把 repo 加入來源",
  "sessionId": "session-xyz",
  "priority": "normal",
  "timestamp": "2026-02-12T10:30:00Z"
}
```

**Alternatives considered**:
- SQLite：過重，不符 Principle I
- Unix socket / IPC：daemon 重啟後通知丟失
- 單一 JSON 檔案：concurrent write 衝突

## 9. Claude Code Hooks 整合

### Decision: UserPromptSubmit + Stop hook，stdin JSON 解析 session_id

**Key findings**:
- Claude Code hooks 透過 stdin 接收 JSON，包含 `session_id` 欄位
- `UserPromptSubmit` hook：使用者送出訊息時觸發，stdout 內容注入 AI context
- `Stop` hook：AI 停止前觸發，exit 2 可阻止停止
- Hook timeout 預設 60s，我們限制 5s（FR-126）

**Hook 腳本設計**（shell script，安裝到 `~/.nbctl/hooks/`）:

```bash
#!/bin/bash
# user-prompt-submit.sh
# 從 stdin 解析 session_id，讀取該 session 的 inbox
SESSION_ID=$(cat | jq -r '.session_id // empty')
if [ -z "$SESSION_ID" ]; then exit 0; fi

INBOX_DIR="$HOME/.nbctl/inbox/$SESSION_ID"
if [ ! -d "$INBOX_DIR" ]; then exit 0; fi

# 讀取 urgent + normal 通知
for priority in urgent normal; do
  for f in "$INBOX_DIR/$priority"/task-*.json; do
    [ -f "$f" ] || continue
    echo "[nbctl] $(jq -r '.status' "$f"): $(jq -r '.result | tostring' "$f")"
    mkdir -p "$INBOX_DIR/consumed"
    mv "$f" "$INBOX_DIR/consumed/"
  done
done
```

**Adapter 安裝**：`nbctl install-hooks --tool claude-code` 將 hook 腳本寫入
`~/.nbctl/hooks/` 並修改使用者的 `.claude/settings.json`（或 `.claude/settings.local.json`）
加入 hook 配置。

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
- `nbctl start` fork 一個 child process（`node daemon/server.ts`）
- Child process 寫入 PID file：`~/.nbctl/daemon.pid`
- Parent process 確認 child 啟動後退出
- `nbctl stop` 讀取 PID file，發送 SIGTERM
- Daemon 收到 SIGTERM 後 graceful shutdown：關閉 HTTP server → 關閉所有 agent session → 關閉 Chrome → 清理 PID file

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
| Cookie injection 不足以建立 session | NotebookLM 可能需要 localStorage 等 | 實測驗證；fallback: CDP Storage API 注入完整 state |
| BrowserPool Chrome instance 記憶體過高 | 同時 3 個 instance ~900MB | Pool max 可調降；操作完畢即 release |
| Agent 佔用 Chrome instance 不歸還 | Pool 耗盡 | BrowserPool timeout 強制回收 |
| Google session 過期 | 操作失敗 | 偵測 302 redirect → 提示 `nbctl reauth` |
| NotebookLM rate limiting | 操作被拒 | Network Manager exponential backoff |
| Headless 渲染與 headed 不一致 | Vision agent 判斷錯誤 | 使用 `headless: true`（new headless，完整 Chrome 引擎） |
| Hook 腳本執行失敗 | 通知遺漏 | 通知保留在 inbox，下次 hook 重試；不影響 AI 工具正常操作 |
| Daemon crash 後資料不一致 | 任務狀態錯誤 | Atomic write + crash recovery（FR-108） |
