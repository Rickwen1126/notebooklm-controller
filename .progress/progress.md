## 2026-02-24 00:21 — Architecture pivot: CLI+HTTP → MCP Server

**Goal**: 將介面層從 CLI + HTTP API 改為 MCP Server，cascade 更新所有設計 artifacts

**Done**:
- 架構討論：CLI+HTTP vs MCP Server → 決定走 MCP Server（主要消費者是 AI agent，MCP 是原生協議）
- 分析 PleasePrompto/notebooklm-mcp（競品）：thin DOM-scraping proxy，非 AI agent，不適合作為基礎
- 反偵測分析：NotebookLM 不主動封鎖機器人操作，MVP 不需 anti-detection，符合 Principle I
- Constitution v1.4.0 → v1.5.0：新增 MCP Server 介面段落（Principle III）
- Spec v5 → v6：CLI command → MCP tool 全面替換，FR-120~127（Adapter）移除，FR-130~133（Skill Template）移除，FR-200~205（MCP Server）新增
- Plan 全面重寫：10 模組 → 8 模組（-cli -auth，notification 簡化），browser-pool → tab-manager，dependency graph 更新
- 驗證：spec 和 plan 無殘留 CLI/Fastify/commander/BrowserPool/AuthManager 引用（僅 changelog 歷史記錄中有）

**Decisions**:
- CLI + HTTP API → MCP Server（Streamable HTTP transport, 127.0.0.1:19224）
- 移除依賴：commander, fastify → 新增：@modelcontextprotocol/sdk
- 模組數 10 → 8：移除 cli（18 command files）、auth（cookie injection）；notification 簡化為單一 notifier.ts
- US15（AI Skill Template）移除 → MCP tool 自描述取代
- US16（Notification Adapter）移除 → MCP notification 取代
- 14 MCP tools：exec, get_status, list_notebooks, add_notebook, add_all_notebooks, open_notebook, close_notebook, set_default, rename_notebook, remove_notebook, cancel_task, reauth, list_skills, shutdown
- Anti-detection：MVP 不需要，NetworkGate rate limiting 足夠

**State**: Branch `001-mvp` at `581a2c5`（未 commit 新變更）。Constitution v1.5.0、Spec v6、Plan 已更新。data-model.md / research.md / CLAUDE.md 尚未 cascade。

**Next**:
- [ ] Cascade 更新：data-model.md（BrowserInstance → TabHandle, CLI Response → MCP tool response, AuthManager/CookieStore 移除）
- [ ] Cascade 更新：research.md（Browser Automation section）
- [ ] Cascade 更新：CLAUDE.md（模組列表 10→8，依賴更新）
- [ ] Commit 本次所有變更
- [ ] Run `/speckit.tasks` to generate implementation tasks
- [ ] Run `/speckit.analyze` for cross-artifact consistency check
