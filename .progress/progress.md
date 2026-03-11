## 2026-03-12 00:13 — SHIP 筆記整理 + tasks.md 產出 + analyze 完成

**Goal**: 整理 SHIP 學習筆記、產出 tasks.md、跑 cross-artifact consistency check

**Done**:
- SHIP 9 個知識點整理為兩篇 Obsidian 筆記（含 Training Angles）
  - `projects/notebooklm-controller/001-mvp-copilot-sdk-架構與邊界@2026-03-11.md`（#0-#3）
  - `projects/notebooklm-controller/001-mvp-copilot-sdk-生命週期與安全@2026-03-11.md`（#4-#8）
- `/speckit.tasks` 產出 `specs/001-mvp/tasks.md`（107 tasks, 14 phases）
- `/speckit.analyze` 完成 cross-artifact consistency check

**Decisions**:
- SHIP 設計洞察（Section 6）只有一行摘要深度不夠，不獨立成筆記 → 直接 4+5 知識點分兩篇
- MVP scope = US1+US2+US3+US10+US13+US14 = Phases 1-7（78 tasks）
- SHIP 不適合拿來 review tasks（SHIP 是知識確認，tasks 是開發步驟）→ 改用 speckit.analyze

**State**: Branch `001-mvp` at `99fe458`。tasks.md 已產出但尚未 commit。analyze 報告已產出（未寫入檔案）。

**Next**:
- [ ] 決定 analyze 報告的 2 個 CRITICAL（CodeTour 時機、Review gate）處理策略
- [ ] 補缺失 tasks（FR-044 sync、FR-045~047 description、FR-051 logging、FR-031 timeout、T033-T036 unit tests）
- [ ] Commit tasks.md
- [ ] 開始實作 Phase 1 Setup

**User Notes**:
- 用戶覺得逐條 review tasks.md 很痛苦且不必要 → 只需看 dependency graph + MVP scope
- tasks.md 是給 AI 執行者的 checklist，細節在它引用的 spec/plan/data-model 裡

---

## 2026-03-11 17:29 — SHIP 9/9 完成 + Data Model Review + 設計修正

**Goal**: 完成 SHIP 剩餘驗證 + review data model 10 個 entity + 記錄設計洞察

**Done**:
- SHIP #8 驗證通過（approveAll 安全邊界）— SDK 只有 approveAll，不是選擇題；安全靠三道防線；approveAll 和 onPreToolUse 是不同層級
- SHIP 9/9 知識點全部完成，學習紀錄更新
- Commit `dec2275`: Spec v7 + SHIP 完成 + Plan/Research/Quickstart cascade
- Commit `d8f6750`: 命名修正 skill → agent config（cascade 所有 artifacts）
- Data model insight-learning review 10 個 entity 全部過完
- Commit `99fe458`: Data model review 設計修正（7 個修正 + 3 個文件補強）
- 筆記存到 Obsidian vault

**Decisions**:
- **approveAll 不是選擇題**：SDK 只提供 approveAll，per-call 機制不存在。安全靠前三道防線，不靠 permission model
- **AsyncTask vs OperationLog 分離**：context 污染防治。agent 執行時只載入 task（集中），歷史按需載入
- **OperationLog 是 agent 外部記憶體**：stateless per run 設計下，agent 靠它精確接手中斷任務
- **ArtifactRecord 補 soft delete**：雲端資料需追溯（與 SourceRecord 同理）
- **Notification 是 best-effort**：任務完成是我們的責任，通知送達是對方的責任。Pull（get_status）是可靠通道
- **Main Agent vs Subagent**：Daemon 不是 agent，是 createSession 呼叫者。Main agent 是 Copilot runtime。customAgents 全部是 subagent，只看到自己 config 列的 tools
- **Agent config 格式 .yaml → .md**：YAML frontmatter + Markdown prompt body，prompt 長文本更自然
- **AgentConfig 對齊 SDK**：name, displayName, description, tools, prompt, infer + 我們的 parameters 擴展。砍掉 version（YAGNI）

**State**: Branch `001-mvp` at `99fe458`。SHIP 全部完成。Data model review 完成。所有 artifacts 已 commit。

**Next**:
- [ ] 整理 SHIP 知識點為 Obsidian 筆記
- [ ] Run `/speckit.tasks` → generate implementation tasks
- [ ] Run `/speckit.analyze` → cross-artifact consistency check
- [ ] 開始實作

**User Notes**:
- SHIP + insight-learning 比 speckit 更深——檢查的是「設計 vs 現實」的矛盾，不只是 artifacts 一致性
- 資料模型設計要為 agent context 服務（最小 context 精確接手）
- content/ 模組是 utils layer，agent/tools/ 才是 SDK wrapper
- 不要依賴 notification 太重，使用者自己負責記得拉結果

## 2026-03-11 00:12 — Copilot SDK insight-learning 完成 8/9 知識點

**Goal**: 用 insight-learning 深入研究 @github/copilot-sdk，建立 9 個機制級心智模型

**Done**:
- 讀完 SDK source code（client.ts, session.ts, types.ts, generated/rpc.ts）from GitHub API
- 完成 8/9 知識點（#0~#7 全過，#8 教完待驗證）
- SHIP Section 7 新增 SDK 深入學習紀錄 + 知識點清單
- **命名修正決策**：skill → agent config（YAML 就是 CustomAgentConfig，不需另外發明詞）
  - `skills/` → `agents/`、`skill-loader.ts` → `agent-loader.ts`、`src/skill/` → 併入 `src/agent/`
- **精確定位**：這是 agent team program（daemon 調度多個 agent），不是 daemon agent program

**Decisions**:
- SDK 是薄皮，能力在 Copilot CLI（認證、context 管理、infinite sessions、guardrails）
- BYOK 可用（在 SDK 框架內換 LLM），繞過 CLI 等於重寫 CLI
- Tool schema 過 JSON-RPC 但 handler 留 Daemon 側（一次 tool call = 兩次 process boundary）
- fail-open hook 設計（hook crash = 不干預，tool 照跑）→ 對 NetworkGate 可接受
- **acquirePermit max wait 必須 < sendAndWait timeout**，否則層級反轉（gate > task）
- Infinite sessions compact 是黑盒不可依賴 → 再次印證「不依賴 session 記憶」正確
- approveAll 安全性靠前三道防線（tool 白名單 + handler 註冊 + handler 範圍限制）
- **Vision agent 自我修復 = screenshot + 座標點擊**，不需要 bash/script，不開後門
- Recovery agent 用同樣 tool 白名單但不同 prompt，搞不定就 escalate

**State**: Branch `001-mvp` at `eed3faa`。SHIP Section 7 已更新。#8 驗證三題待回答。spec v7 + plan.md 仍未 commit。

**Next**:
- [ ] 完成 #8 驗證（approveAll 安全邊界）→ 更新 SHIP 學習紀錄
- [ ] Commit spec v7 + SHIP 更新 + plan.md
- [ ] 更新 plan.md/spec.md/CLAUDE.md 的 skill → agent 命名
- [ ] Run `/speckit.tasks` to generate implementation tasks
- [ ] Run `/speckit.analyze` for cross-artifact consistency check
- [ ] 開始實作

**User Notes**:
- 用戶對 SDK 與 spec 的高度契合感到驚喜
- 用戶認為 Skill 應該叫 agent config，因為 agent 只有一種定義（SDK 的 CustomAgentConfig）
- 「Agent team program」比「daemon agent program」更精確
- Vision agent 座標點擊是萬能修復工具，不需要給 agent 寫 script 的能力

## 2026-03-10 18:42 — Cascade 完成 + Constitution 精簡 + Agent SDK 修正 + SHIP 完成

**Goal**: 完成所有設計 artifacts 的 cascade 更新，準備進入實作階段

**Done**:
- Cascade 更新 data-model.md（BrowserInstance→TabHandle, CLI Response→MCP Tool Response, NotificationMessage→MCP Notification Payload, AuthManager/CookieStore 移除）
- Cascade 更新 research.md（Browser Automation 重寫, Fastify→MCP SDK, Commander.js 移除, Inbox→MCP notification, Hooks 移除, 風險表更新）
- Cascade 更新 CLAUDE.md（-fastify -commander +@modelcontextprotocol/sdk, 8 模組結構）
- Commit `28e39e0`: MCP Server 架構 pivot cascade
- Constitution v1.5.0 → v1.6.0：Principle III 精簡（27→5 行，移除 MCP/TabManager 實作細節下放 spec）；Principle VII 新增 per-resource 寫入保護（禁止 global serialization）；移除「並行與資料流設計約束」章節
- Commit `c9ceebd`: Constitution v1.6.0
- **Agent SDK 修正**：所有 artifacts 中 `@anthropic-ai/claude-agent-sdk` → `@github/copilot-sdk`（GitHub Copilot SDK）。CLAUDE.md 新增 CRITICAL 標記，auto memory 寫入防止再次搞混
- Commit `eed3faa`: Agent SDK 修正
- SHIP 草稿完成（Problem Statement, Solution Space, 技術決策清單, 橫向掃描）
- **SHIP B/R/N 全部解除**：用 /insight-learning 走完 10 個知識點，用戶確認所有分類
- **Spec v6 → v7**：補充 SHIP 解除後的 8 個設計決策（Clarifications Session 2026-03-10 + Edge Cases + Key Entities 更新）
- **SHIP 文件更新**：`.ship/SHIP-notebooklm-controller@20260310.md` — 所有 Block 解除、Spike 1 範圍縮小、新增 Section 6 設計洞察

**Decisions**:
- Constitution 不放實作細節（MCP、TabManager、CDP）→ 只放原則，具體架構在 spec
- 磁碟 I/O 保護改為 per-resource per-file，禁止 global serialization（避免過度設計）
- Agent SDK: `@github/copilot-sdk`（GitHub Copilot SDK），不是 Claude Agent SDK — 用戶多次強調
- MCP 和 CLI 不衝突：MVP 先用 MCP，日後可加 thin CLI wrapper
- **Daemon vs Agent 分工**：Daemon 是指揮者（調度、全局狀態），Agent 是執行者（自主使用 tool）
- **Agent conceptually stateless per run**：Task 切細粒度、每步進度外部化、任何 agent 可接手
- **Shutdown = 直接殺**：不做 graceful shutdown，task queue 恢復
- **Chrome must stay alive**：disconnected → 通知 agent → 重啟 → task queue 接手
- **429 偵測是 agent 的事**：不規範方式，提供 reportRateLimit tool
- **MCP notification fire-and-forget**：不補發，client pull-based
- **PID file 雙重檢查**：{ pid, startedAt } 防 PID 重用
- **Tool 自包原則**：screenshot tool 自行截圖+轉換，daemon 不中轉

**State**: Branch `001-mvp` at `eed3faa`（未 commit spec v7 和 SHIP 更新）。SHIP 開工條件滿足。用戶嘗試 `/speckit.plan` 但中斷。

**Next**:
- [ ] Commit spec v7 + SHIP 更新
- [ ] Run `/speckit.plan` to generate implementation plan
- [ ] Run `/speckit.tasks` to generate implementation tasks
- [ ] Run `/speckit.analyze` for cross-artifact consistency check
- [ ] 開始實作

**User Notes**:
- 用戶要求「把 SHIP 全存起來」
- SHIP 產出是 notebooklm-controller daemon（不只是 MCP 研究），MCP 是其中一環
- Agent SDK 是 GitHub Copilot SDK，已反覆強調，寫入 CLAUDE.md CRITICAL 區塊和 auto memory
