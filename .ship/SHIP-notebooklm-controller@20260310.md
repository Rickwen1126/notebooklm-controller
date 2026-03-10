# SHIP: notebooklm-controller

tags: [ship, browser-automation, copilot-sdk, mcp-server, daemon]

## Relations
- ship_plan_for [[todo-notebooklm-controller]]

## 1. Problem Statement
**問題**：Google NotebookLM 沒有公開 API，開發者無法讓 AI 工具自動餵入資料、查詢 grounded 回答、產生 Audio Overview
**對象**：使用 AI 工具（Claude Code 等）的開發者（自己）
**成功條件**：AI 工具透過 MCP protocol 呼叫 daemon，daemon 用 vision-based AI agent 操作 NotebookLM web UI 完成端對端操作

## 2. Solution Space

### 介面層
| 做法 | 優勢 | 風險/代價 |
|------|------|-----------|
| CLI + HTTP API（Fastify + Commander） | 人類也能用 CLI | 18 command files + Fastify routes + Skill Template = 大量膠水層；主要消費者是 AI agent，CLI 多餘 |
| **MCP Server（Streamable HTTP）** | **AI 原生協議；tool 自描述；持續連線可推送通知** | **MCP 生態系較新；人類 debug 需透過 MCP client** |

**選擇**：MCP Server
**原因**：主要消費者是 AI agent，MCP 是原生協議，砍掉整層膠水。日後可加 thin CLI wrapper（MCP client）。

### 瀏覽器架構
| 做法 | 優勢 | 風險/代價 |
|------|------|-----------|
| Multi-tab（1 Chrome N tabs, Puppeteer 高層 API） | 省記憶體 | Puppeteer 高層 API background tab 不可靠（#3318）；需序列化 |
| BrowserPool（N Chrome instances） | 真正 parallel；agent 有完整 Chrome | ~900MB 記憶體；需 cookie injection（SingletonLock） |
| **Single Browser Multi-tab（1 Chrome N tabs, CDP 底層 API）** | **~500MB；CDP 底層 API background tab 可靠（Spike 0 驗證）；userDataDir 共享認證** | **單一 Chrome crash 全掛** |

**選擇**：Single Browser Multi-tab（CDP 底層 API）
**原因**：Spike 0 實驗證實 CDP 底層操作可靠，記憶體最省，認證最簡單

## 3. 技術決策清單
| 決策點 | 選擇 | 原因 | 備選 |
|--------|------|------|------|
| 語言 | TypeScript 5.x + Node.js 22 | Copilot SDK + puppeteer-core 都是 TS/Node 生態 | Python（puppeteer 沒 Python 版） |
| AI Agent | **GitHub Copilot SDK**（`@github/copilot-sdk`） | Copilot CLI 的 agent runtime，支援多模型、custom tools、MCP 整合 | Claude Agent SDK（直接 API） |
| 瀏覽器控制 | puppeteer-core + CDP 底層 API | Background tab 操作可靠（Spike 0 驗證） | Playwright（CDP 支援不如 Puppeteer 直接） |
| 介面 | MCP Server（Streamable HTTP, `@modelcontextprotocol/sdk`） | AI 原生協議、砍膠水層 | CLI + HTTP API |
| 認證 | userDataDir 共享 | 一個 Chrome instance 免 cookie injection | Cookie extraction/injection |
| 流量控制 | NetworkGate permit-based | 不在 data path，只管許可 | Proxy 攔截 |
| 持久化 | JSON 檔案 + atomic write（temp + rename） | 簡單、符合 Principle I；rename 是 atomic operation | SQLite（過重） |
| 測試 | Vitest | 原生 TS、Jest 相容 | Jest |

## 4. 橫向掃描
| 參考專案 | 值得借鏡的做法 | 要避開的坑 |
|---------|---------------|-----------|
| PleasePrompto/notebooklm-mcp | MCP 作為介面的概念驗證 | Thin DOM-scraping proxy，沒有 AI agent，selector-based 容易被 UI 更新打壞 |

## 5. 知識風險標記

### [B]lock（不理解，會影響方向）— 全部解除 ✅

- [x] **Copilot SDK agent runtime 模型**
  - 解什麼問題：Agent 需要記憶（session）來做連續操作，但 session 在 process memory 中
  - 用錯會怎樣：依賴 session persistence → 過度設計；不理解 tool 自包原則 → daemon 多做中轉
  - 為什麼選這做法：Daemon 是指揮者（調度任務、提供工具），Agent 是執行者（自主使用工具）
  - Exit Questions:
    1. ~~Session 在 daemon restart 後能恢復嗎？~~ → **不重要。** Task 切細粒度 + 每步進度外部化 = 任何 agent 都能接手。類比 message queue consumer。 ✅
    2. ~~Vision input 怎麼傳給 agent？~~ → **降級 [N]。** Tool 自包截圖 + 格式轉換（CDP → 圖片 → 回傳），Copilot CLI agent 自主分析。SDK tool return spec 是語法問題。 ✅
    3. BYOK 模式下可以指定用哪個模型嗎？ [A] → Spike 1 確認
  - 狀態：**已解除**

- [x] **Daemon graceful shutdown + crash recovery**
  - 解什麼問題：Daemon 可能在 agent 操作途中被終止
  - 用錯會怎樣：依賴 graceful shutdown → 等 agent 完成要 5 分鐘、handler 不可靠（SIGKILL 繞過）
  - 為什麼選這做法：不做 graceful shutdown，直接終止。Task queue 負責恢復。細粒度任務讓損失最小。
  - Exit Questions:
    1. ~~SIGTERM mid-operation 會怎樣？~~ → **直接殺。** Vision agent 一步可能 5 分鐘，graceful shutdown 不可靠且等不起。Task queue 恢復。 ✅
    2. ~~Atomic write 怎麼保證 crash 安全？~~ → **temp + rename。** rename 是 atomic（單一 metadata pointer），writeFile 不是（多次 data block）。 ✅
    3. ~~Stale PID 怎麼處理？~~ → **PID file 存 `{ pid, startedAt }`，雙重檢查防 PID 重用。** ✅
  - 狀態：**已解除**

### [R]isky（大概懂但不確定）— 全部解除 ✅

- [x] **TabManager lifecycle** → **已解除**
  - Chrome 對 daemon 至關重要。`browser.on('disconnected')` → 通知所有 agent 停止 → 重啟 Chrome → agent 從 task queue 接手。0 tab 策略待定（idle timeout 或常駐）。

- [x] **NetworkGate permit 模型** → **降級為介面設計問題**
  - 不規範 agent 偵測 429 的方式（CDP 或視覺分析都可）。Daemon 提供 `reportRateLimit` tool，agent 自主回報，NetworkGate 負責 backoff 決策。

- [x] **MCP Server Streamable HTTP transport** → **已解除**
  - MCP 對 client 而言是可重試的資料來源，非 mission-critical 即時通道。Notification fire-and-forget，不做補發。Client 再 query 就好。

### Spike 計畫
- **Spike 0（已完成）**: Multi-tab background tab 操作實驗 ✅
  - 結論：CDP 底層 API background tab 操作完全可靠
  - 架構影響：BrowserPool → Single Browser Multi-tab
- **Spike 1（範圍縮小）**: Copilot SDK agent runtime
  - 原本覆蓋：B1-Q1（session 持久化）, B1-Q2（vision input）
  - **現在只需確認**：B1-Q3（BYOK 模型選擇）+ tool return spec 的 image 格式（語法層）
  - 預計：15 min

### [N]ice-to-know（不影響方向）
- 語法類（API 參數、puppeteer launch options、MCP SDK route 定義）→ AI 負責
- Copilot SDK JSON-RPC 底層協議細節 → SDK 封裝好了
- Copilot SDK tool return spec 的 image 格式 → Spike 1 順便確認

## 6. 設計洞察（SHIP 過程中釐清的架構決策）

1. **Daemon vs Agent 分工**：Daemon 是指揮者（調度任務、管理全局狀態、提供工具），Agent 是執行者（自主使用工具完成細粒度任務）。不共同監控工具層。
2. **Agent conceptually stateless per run**：Task 切細粒度，每步進度外部化。任何無記憶的 agent 都能從 task store 接手。Session 內部有 state（對話記憶），但架構不依賴 session persistence。
3. **Shutdown = 直接殺**：不做 agent-level graceful shutdown。恢復靠 task queue，不靠 cleanup handler。
4. **Chrome must stay alive**：Chrome crash = 全 agent 工作環境消失。立即偵測、通知、重啟。
5. **429 偵測是 agent 的事**：不規範偵測方式，只提供回報介面（`reportRateLimit` tool）。
6. **MCP notification 是 fire-and-forget**：不做補發。Client pull-based 查詢天然可靠。
7. **PID file 雙重檢查**：`{ pid, startedAt }` 防止 PID 重用誤判。
8. **Atomic write = temp + rename**：rename 是 atomic，writeFile 不是。

## 7. SDK 深入學習（insight-learning）

基於 SDK source code 研究（`@github/copilot-sdk` v0.1.32+, nodejs/src/），
盤點 9 個機制級知識點，用 insight-learning 建立心智模型。

### SDK Source 結構（6 檔案）
```
nodejs/src/
├── index.ts              # Public exports（CopilotClient, CopilotSession, defineTool, approveAll + 所有 types）
├── client.ts             # CopilotClient class — spawn CLI process, JSON-RPC connection, session 管理
├── session.ts            # CopilotSession class — event dispatch, tool execution, hooks invocation
├── types.ts              # 所有 type definitions（Tool, SessionConfig, SessionHooks, CustomAgentConfig, ProviderConfig 等）
├── sdkProtocolVersion.ts # Protocol version constant
└── generated/
    ├── rpc.ts            # Auto-generated JSON-RPC method stubs（from api.schema.json）
    └── session-events.ts # Auto-generated session event type definitions
```

### 知識點清單

| # | 知識點 | 面向 | 狀態 |
|---|--------|------|------|
| 0 | SDK 基本架構導覽（帶 src） | 機制 | [x] |
| 1 | CopilotClient ↔ CLI process 的 JSON-RPC 邊界 | 機制、故障模式 | [x] |
| 2 | Session 狀態邊界：client vs session vs disk | 機制、故障模式 | [x] |
| 3 | Tool 自包原則 vs daemon 中轉 | 設計取捨 | [x] |
| 4 | ToolResultObject 的 binary 回傳路徑 | 機制、故障模式 | [x] |
| 5 | CustomAgentConfig ↔ Skill 映射 | 設計取捨 | [x] |
| 6 | SessionHooks 的阻塞語意 | 機制、故障模式 | [x] |
| 7 | Infinite sessions 與 context 自動管理 | 機制 | [x] |
| 8 | Permission model：approveAll 的安全邊界 | 設計取捨 | [x] |

### 學習紀錄

- [x] #0 SDK 基本架構導覽 — 兩個 process（Daemon + CLI Server），JSON-RPC over stdio，SDK 是薄皮，能力在 CLI
- [x] #1 JSON-RPC 邊界 — tool schema 過線但 handler 留本地，tool call 跨兩次 process boundary
- [x] #2 Session 狀態邊界 — 三層 state（Daemon 記憶體/CLI 記憶體/disk），我們不依賴 session persistence
- [x] #3 Tool 自包原則 — agent 自己決定截圖時機，daemon 不中轉。例外：notification、NetworkGate、task store
- [x] #4 ToolResultObject binary 路徑 — 全程 base64 string，兩個通道（text + binary）互補
- [x] #5 CustomAgentConfig ↔ Skill 映射 — **命名修正：skill → agent config**。YAML 就是 agent config，不需另外發明詞。
- [x] #6 SessionHooks 的阻塞語意 — hook 是 blocking（CLI Server await JSON-RPC response）。fail-open 設計（hook crash = 不干預）。**acquirePermit max wait 必須 < sendAndWait timeout**，否則層級反轉（gate > task）。onErrorOccurred 提供 retry/skip/abort 三路分流。
- [x] #7 Infinite sessions 與 context 自動管理 — 80% background compact、95% blocking compact，agent 無感。Compact 丟資訊但 daemon 側 task store 有完整紀錄，架構天然互補。沒理由關掉。
- [x] #8 Permission model — **SDK 只有 approveAll，沒有 per-call alternative**。安全不靠 permission model，靠三道防線（tool 白名單 + handler 註冊 + handler 範圍限制）。approveAll 和 onPreToolUse 是不同層級：前者是 permission gate，後者是 event middleware（用來掛 NetworkGate 流量控制）。

### 命名修正決策（#5 產出）

- `skills/` → `agents/`（YAML 目錄）
- `skill-loader.ts` → `agent-loader.ts`
- `src/skill/` → 併入 `src/agent/` 或改名 `src/agent-config/`
- **理由**：Agent 只有一種定義（SDK 的 CustomAgentConfig），Daemon 不是 agent 而是調度者
- **精確描述**：這是一個 agent team program（daemon 調度多個 agent），不是 daemon agent program
- 待更新：plan.md, spec.md, CLAUDE.md

## 8. 開工決策
- [x] 所有 [B]lock 已解除 ✅
- [x] [B]lock ≤ 3 個（原 2 個，已全部解除）
- [x] Problem Statement 清晰
- [x] Solution Space 有比較過
- [x] 技術決策都有根據（Spike 0 驗證瀏覽器架構；SDK 和 MCP 有研究支撐）

**狀態**：✅ 開工條件滿足。Spike 1 範圍縮小為語法確認（BYOK + image format），不阻塞開工。
