## 2026-03-13 11:49 — Phase A+ 補充驗證通過 + Phase B 準備開始

**Goal**: Browser capability spike — 驗證 CDP helpers 能否操控 NotebookLM

**Done**:
- Phase A 三條 flow 全部通過（create notebook / query / add source）
- Experiment script 完成（`spike/browser-capability/experiment.ts`）
- Viewport 除錯：puppeteer `defaultViewport: null` 必須設定，否則強制 800x600
- 發現第六個必要 tool：DOM 查詢（getBoundingClientRect），純 screenshot 座標估算不可行
- Results 記錄完成（`spike/browser-capability/results.md`）
- **Tool 化 clean demo**：14 tool calls, 0 行 code，完成建立筆記本→加來源→提問完整流程
- 新增 `find` command：text/selector/ariaLabel 查詢 → 回傳 center 座標 + rect
- 新增 `shot` command：screenshot + find 合一（省 round-trip）
- 新增 `read` command：CSS selector 取頁面文字（回答提取用 `.message-content`）
- **驗證 read 能力**：`read .message-content` 成功取回 NotebookLM 純文字回答
- **Haiku 模型驗證 PASS**：切換 Claude Code 到 haiku，完整跑 create→add source→query→read，13 tool calls
- **多來源驗證 PASS**：同筆記本加第二個來源（Copilot SDK 說明），成功
- **跨來源 grounding PASS**：問跨兩份來源的問題，NotebookLM 正確引用兩份來源（標記 1/2）
- **UI 狀態陷阱發現**：來源展開後「新增來源」按鈕被遮蔽，`find "collapse_content"` 可恢復
- **交接文件完成**：HANDOVER.md + results.md 更新至最新（含 findings #6-#13）

**Decisions**:
- **座標不能從 screenshot 目測**：估算誤差可達 2-5 倍，agent 必須用 DOM query 定位元素
- **需要第六個 tool：findElement**：`{ text?, selector?, ariaLabel? } → { tag, text, rect }[]`
- **需要第七個 tool：readText**：`{ selector } → string`（回答提取、狀態檢查、錯誤訊息）
- **dispatchPaste > dispatchType**：大量文字用 paste 更快更穩，type 留給特殊按鍵
- **agent 互動迴圈**：screenshot（視覺理解）→ find（精確座標）→ click/paste（動作）→ read（取結果）→ repeat
- **笨模型可行（已實測）**：Haiku 完整跑通 flow，execution 層不需要強推理
- **NotebookLM 回答 selector**：`.to-user-container .message-content` = 只取回答（不含問題）
- **提交按鈕消歧**：頁面有 2 個「提交」，選 y>400 的（chat 區）
- **來源展開遮蔽恢復**：`find "collapse_content"` → click → 重新露出「新增來源」
- **回答載入等待**：跨來源問題需 10-15s，首次 read 可能出現 "Refining..."，需重試

**State**: Phase A+ 全部驗證 PASS。Chrome 在跑（port 9222）。HANDOVER.md/results.md 已更新。準備 commit spike 成果後進入 Phase B（Copilot SDK runtime）。

**Next**:
- [ ] Commit spike 成果（spike/ 目錄全部）
- [ ] Phase B：在 spike/ 內建 Copilot SDK 實驗腳本（不污染 src/）
- [ ] 回灌結論到主專案 task/plan（新增 find + read tools）
- [ ] 修 3 個 critical issues

**User Notes**:
- 用戶提出核心問題：tool 化 + 視覺分析 + Bounding 分析，能否讓 agent 不寫 code 推進任務 → 已驗證：可以
- 用戶要求交接文件放 spike 內部，不污染 repo 主任務
- 用戶關注回答提取 + cache 能力：agent 需要 read → cache flow，不只是操作
- 用戶強調 Phase B 實驗腳本必須在 spike/ 資料夾內，不能污染 repo code
- 用戶故意觸發 UI 狀態陷阱（展開來源）測試 agent 恢復能力 → 發現 collapse_content 恢復路徑

---

## 2026-03-13 10:34 — Review Point 1 完成 + Spike 決策

**Goal**: Phase 2 code review + 決定 spike 實驗方案

**Done**:
- Sky Eye CodeTour 產出（`.tours/01-sky-eye-phase2-foundation.tour`，14 steps，用戶已填寫思考回答 + 4 份深度 review insight）
- Code Review 產出（`.tours/review-phase2-foundation-20260312.tour`，3 critical / 7 suggestions / 6 good）
- Review Point 1 的深度 review findings（client.ts autoRestart 衝突分析、session-runner boundary validation 缺失、hooks FR-051 logging gap、browser-tools spike 提案）
- Brainstorm 決策：主線暫停，先跑 browser capability spike

**Decisions**:
- **主線 Phase 3 暫停，spike 先行**：核心假設（LLM + browser tools 能不能穩定操控 NotebookLM）未驗證前，繼續堆架構沒有意義
- **兩階段實驗**：Phase A（puppeteer-core + CDP helpers 直接驗證）→ Phase B（Copilot SDK runtime 驗證）
- **必須用 puppeteer-core + CDP**：不能用 Playwright（失真，與主專案架構不符）
- **Phase A 工具約束**：只用已寫好的 5 個 CDP helper（captureScreenshot, dispatchClick, dispatchType, dispatchScroll, dispatchPaste），agent 不能自己創造工具
- **驗證 3 條 flow**：create notebook / query / add source
- **A 通過後可繼續 Phase 3**（接線不是功能），B 在 Phase 4 前完成

**State**: Review Point 1 完成。Spike 設計已存 memory（`project_spike_browser_capability.md`）。Brainstorm design doc 尚未寫入 `docs/superpowers/specs/`。

**Next**:
- [ ] 寫 experiment script：puppeteer-core launch → CDP session → 5 helper 包成可呼叫介面
- [ ] Phase A 實驗：3 flow × 探索 + 工具化 + 純工具重跑（45-60 min）
- [ ] Phase B 實驗：搬進 Copilot SDK runtime（30-45 min）
- [ ] 回灌結論到主專案 task/plan
- [ ] 修 3 個 critical issues（JSON parse、writeFile path validation、scheduler result persist）

**User Notes**:
- 「自動分析點擊的這條實驗必須要先跑通，我們有個底氣確認核心功能可運作無誤，我們再往下做才有意義」
- 實驗必須完全依照主專案架構使用的工具（puppeteer-core + CDP），不能用 Playwright
- 兩階段都跑，值得花 1-2 小時確認清楚

---

## 2026-03-12 16:00 — Phase 2 Foundational 實作完成，Review Point 1

**Goal**: `/speckit.implement` Phase 1 Setup + Phase 2 Foundational 全部實作

**Done**:
- Phase 1 (T001-T004): project scaffolding, tsconfig, vitest, eslint, prettier
- Phase 2 (T005-T036 + T007.1/T032.1/T033.1/T035.1): 全部 36 tasks 完成
- 15 test files, **227 tests passing**, TypeScript compilation clean
- Modules implemented:
  - `src/shared/` — types (17 interfaces), errors (8 error types), config, logger
  - `src/state/` — state-manager (atomic write), task-store (state machine), cache-manager
  - `src/tab-manager/` — cdp-helpers (5 CDP ops), tab-handle, tab-manager (EventEmitter)
  - `src/network-gate/` — acquirePermit (fail-open), reportAnomaly (backoff+jitter)
  - `src/agent/` — agent-loader (YAML frontmatter), client (singleton), hooks (4 lifecycle), session-runner
  - `src/agent/tools/` — browser-tools (5 tools), state-tools (3 tools), index (factory)
  - `src/daemon/` — scheduler (per-notebook queues), mcp-server (Streamable HTTP skeleton)
  - `src/notification/` — notifier (fire-and-forget MCP notification)

**Decisions**:
- SDK hook types (`SessionHooks`, `PreToolUseHookInput` etc.) defined locally — not re-exported from `@github/copilot-sdk`
- `PermissionHandler` returns `{ kind: "approved" }` not `{ result: "allow" }`
- Tool<T> covariance workaround: `as any as Tool<unknown>[]`
- Zod v4: `z.record()` requires key schema → `z.record(z.string(), z.unknown())`
- MCP server uses raw `node:http` for Streamable HTTP transport (SDK limitation)

**State**: Branch `001-mvp`. 227 tests pass. At **Review Point 1** — user requested stop for code review before Phase 3.

**Next**:
- [ ] User code review (Review Point 1)
- [ ] Phase 3: US1 Daemon lifecycle (T037-T046)
- [ ] Phases 4-7 for MVP completion

**User Notes**:
- 「記得做完到第一個 checkpoint 要停下來 review」— 明確要求 Phase 2 完成後停下

---

## 2026-03-12 11:28 — Analyze 修正完成 + Constitution v1.7.0 + Checklist 重建

**Goal**: 處理 analyze report 所有 issues，修正 Constitution，重建 checklist 準備 implement

**Done**:
- Constitution v1.6.0 → v1.7.0：移除 CodeTour (IX) 和 Review hard gate (X)，精簡為 9 條原則
  - 核心決策：CodeTour/audit/review 是開發者主動活動，不是 AI executor 約束
  - 開發迴圈精簡為 4 步：tests → implement → tests pass → commit
- tasks.md 107 → 114 tasks：補 analyze HIGH issues（+6 tasks, -1 T103 CodeTour）
  - 新增：T007.1 logging, T032.1/T033.1/T035.1 unit tests, T058.1 description, T095.1 sync
  - 3 個 Review Point：Phase 2 done → Phase 7 done → Phase 14 done
- Analyze M1-M5 全部修正：quickstart skills/→agents/, spec profiles/chrome/→profiles/, data-model infer 描述, T102.1 OS notification, 4 組重複 FR alias 標注
- L2 add_all_notebooks 標注 postponed（傾向 Preview+confirm 兩步模式，MVP 後決定）
- Checklist 重建：刪除 v1-v2 舊版 3 份，產出對齊 spec v7 的 3 份新版（48 items）
  - `mcp-agent.md` (17), `browser-state.md` (16), `flow-coverage.md` (15)

**Decisions**:
- **Review 不是 executor 約束**：Constitution 只管 AI executor 做的事，開發者自己決定何時 /codetour /audit /reviewCode
- **Review 三個時間點**：Phase 2 (foundational) → Phase 7 (MVP) → Phase 14 (all done)
- **Checklist 是 pre-planning 產物**：spec 品質檢查，不是 implement gate。但 implement 腳本會看，所以要對齊

**State**: Branch `001-mvp` at `157bae1`。所有 analyze issues 已清完。Checklist 48 items 未勾。準備 `/speckit.implement`。

**Next**:
- [ ] 勾 checklist（時機待定）
- [ ] `/speckit.implement` 開始實作 Phase 1 Setup

**User Notes**:
- Checklist 不需要在 implement 前全部勾完，是開發過程中發現 spec 需要補充的指引
- Review Point 是告訴 executor 停下來等使用者，不是開發者的備忘

---

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
- [x] 決定 analyze 報告的 2 個 CRITICAL（CodeTour 時機、Review gate）處理策略
- [x] 補缺失 tasks
- [x] Commit tasks.md
- [ ] 開始實作 Phase 1 Setup

**User Notes**:
- 用戶覺得逐條 review tasks.md 很痛苦且不必要 → 只需看 dependency graph + MVP scope
- tasks.md 是給 AI 執行者的 checklist，細節在它引用的 spec/plan/data-model 裡

---

