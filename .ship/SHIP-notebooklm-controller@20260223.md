# SHIP: notebooklm-controller

tags: [ship, browser-automation, agent-sdk, daemon]

## 1. Problem Statement
**問題**：Google NotebookLM 沒有 API，需要透過瀏覽器自動化 + AI agent 來程式化控制
**對象**：開發者（自己），透過 CLI 操作
**成功條件**：`nbctl exec "把 repo 加入來源"` 能完成端對端操作

## 2. Solution Space
| 做法 | 優勢 | 風險/代價 |
|------|------|-----------|
| Multi-tab（1 Chrome N tabs） | 省記憶體（~500MB） | Background tab screenshot/click 不可靠（文獻推論，待實驗驗證）；agent 只拿 bounded interface |
| **BrowserPool（N Chrome instances）** | **真正 parallel、agent 完整 Chrome、自我修復強** | **記憶體較高（~900MB for 3）** |
| Patchright（Playwright 反偵測） | 反 bot detection | Python 生態、MVP 不需要反偵測 |
| MCP Server 模式 | 標準協定 | 不支援 async/notification |
| **CLI + Skill + Notify** | **Async inbox、hook 整合、daemon 常駐** | **自建 notification 機制** |

## 3. 技術決策清單
| 決策點 | 選擇 | 原因 | 備選 |
|--------|------|------|------|
| 語言 | TypeScript + Node 22 | Agent SDK + puppeteer-core 都是 Node 生態 | Python |
| 瀏覽器自動化 | puppeteer-core | Node 生態標準 CDP 工具 | Patchright（未來可換） |
| 瀏覽器架構 | BrowserPool (max 3) | 真正 parallel + agent 完整 Chrome | Multi-tab（待實驗驗證） |
| 認證共享 | Cookie injection (setCookie) | SingletonLock 阻止 userDataDir 共享 | userDataDir 複製 |
| 流量控制 | NetworkGate permit-based | 不在 data path | Proxy 模式 |
| Agent 框架 | Claude Agent SDK V2 | Session 持久化、auto-compact、1M context | 自建 agent loop |
| 架構模式 | CLI + Daemon + Skill + Notify | Async + hook 注入 | MCP Server |
| 狀態存儲 | JSON file + atomic write | 極簡 | SQLite |
| HTTP server | Fastify | 快、schema validation | Express |
| Daemon 化 | child_process.fork + PID file | Node 原生 | pm2 / systemd |

## 5. 知識風險標記

### [B]lock
- [ ] **Agent SDK V2 session 模型**：session 持久化/resume 機制、auto-compact 行為、send vs stream
  - 解什麼問題：{進行中}
  - 用錯會怎樣：{待填}
  - 為什麼選這做法：{待填}
  - Exit Questions:
    1. Session 在 daemon restart 後怎麼恢復？持久化了什麼、沒持久化什麼？ [A]
    2. Auto-compact 觸發時 agent 丟掉什麼上下文？對正在執行的操作有什麼影響？ [B]
    3. send() vs stream() — 什麼情境用哪個？ [A]
  - 狀態：未解除（進行中 — 已討論 Q1 context 持久化）

- [ ] **Daemon graceful shutdown + crash recovery**：SIGTERM 處理、atomic write 保證、stale PID
  - 解什麼問題：{待填}
  - 用錯會怎樣：{待填}
  - 為什麼選這做法：{待填}
  - Exit Questions:
    1. Daemon 收到 SIGTERM 時有 agent mid-operation，會發生什麼？ [A]
    2. Atomic write 怎麼保證 crash 後不讀到 half-written state？ [A]
    3. Stale PID file 怎麼偵測和處理？ [A]
  - 狀態：未解除

### [R]isky
- **BrowserPool lifecycle**：acquire/release/timeout 細節
  - Exit Questions:
    1. Pool 滿了時新的 acquire 請求會怎樣？ [A]
- **Cookie injection 機制**：setCookie 時序、cookies 是否足夠
  - Exit Questions:
    1. NotebookLM 如果不只靠 cookies，fallback 方案是什麼？ [B]
- **NetworkGate permit 模型**：backoff 機制
  - Exit Questions:
    1. Agent 在 Chrome 裡偵測 429 後怎麼通知 gate？ [A]
- **Hook 注入機制**：stdin JSON session_id routing
  - Exit Questions:
    1. Hook stdin 的 session_id 是 Claude Code 的還是 nbctl 的？怎麼對應？ [A]

### Spike 計畫
- **Spike 0（完成）**: Multi-tab background tab 操作實驗 ✅
  - 結論：**BrowserPool 的核心假設錯誤，multi-tab 完全可行**
  - `page.screenshot()` background tab → ✅ 5 tabs 並行，343ms，3 輪 15/15 成功
  - `page.click()` background tab → ❌ Hang（Puppeteer 高層 API 問題）
  - `Input.dispatchMouseEvent` (CDP) background tab → ✅ 5 tabs 全部成功
  - `page.evaluate(() => el.click())` (JS) → ✅ 5 tabs 全部成功
  - **根本原因**：Puppeteer `page.click()` 內部等待 focus/visibility 條件，不是 Chrome/CDP 限制
  - **架構影響**：BrowserPool → Single Browser Multi-tab，cookie injection → userDataDir 共享
- Spike 1: Agent SDK V2 session 行為 → 覆蓋 B3-Q2（auto-compact）
  - 做什麼：建最小 session，觸發 compact，觀察前後 context 差異
  - 預計：30 min

### [N]ice-to-know
- 語法類（API 參數、puppeteer launch options、Fastify route 定義）→ AI 負責

## 6. 開工決策
- [ ] 所有 [B]lock 已解除
- [x] [B]lock ≤ 3 個（2 個）
- [x] Problem Statement 清晰
- [x] Solution Space 有比較過
- [ ] 技術決策都有根據（multi-tab vs BrowserPool 待實驗驗證）

**狀態**：待補 — Spike 0 實驗 + [B] 解除
