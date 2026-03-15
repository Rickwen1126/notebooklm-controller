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
