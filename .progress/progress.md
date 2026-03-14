## 2026-03-14 20:50 — Spike 實驗收尾 + 架構洞見 + Handover

**Goal**: 完成 file-based paste 實驗、整理架構洞見、交接給下一個 session

**Done**:

### Spike 實驗

1. **雙 Session 全量 re-test**（`6712ab8`）
   - 13/13 batch test PASS（dual session Planner+Executor）
   - 23/23 input guard test PASS（Planner as gate）
   - 全部使用 gpt-4.1（修正了 default model 未指定的問題）

2. **File-based Paste 實驗**（`fc9e3e7`）— Finding #51
   - 實驗 1: NotebookLM paste **無前端字數限制**（10K~500K 全通過，500K 只要 83ms）
   - 實驗 2: **filePath 模式成功** — `repoToText → temp file → paste(filePath=...)` — 100K chars, 0 token context 消耗
   - 實驗 3: Baseline 100K 可跑但不經濟（25K tokens 進 context），500K 必爆
   - 核心洞見：**Tool boundary = context boundary**（architectural enforcement，非 prompt-level）

### 架構洞見（Finding #48-51）

- **#48 Executor Pre-Navigate** — 系統層 `tab.url` exact match 判斷頁面錨點，agent 不自己判斷。agentConfig 加 `startPage: "homepage" | "notebook"`
- **#49 Tab Pool Weak Affinity** — `affinityMap[notebookId] = tabId` soft hint，連續操作 0 navigate
- **#50 Default Model Hardcode** — 所有 spike + production 必須 hardcode `model: "gpt-4.1"`，不依賴 SDK default
- **#51 File-based Paste** — 大內容走 temp file，LLM 只看 filePath + metrics。urlToText / pdfToText 同理

### Bug fix

- Spike 腳本未帶 `--model` flag → 跑 SDK 預設高價模型 → 消耗 50% premium。已修正所有 4 個 spike 檔案 default = `"gpt-4.1"`

**State**: Branch `001-mvp` at `fc9e3e7`。573 tests passing, lint 0 errors。

**Files changed this session**:
- `spike/browser-capability/phase-b.ts` — default model → gpt-4.1
- `spike/browser-capability/phase-e.ts` — default model → gpt-4.1
- `spike/browser-capability/phase-f.ts` — default model → gpt-4.1
- `spike/browser-capability/phase-f-guard.ts` — default model → gpt-4.1
- `spike/browser-capability/paste-limit-experiment.ts` — **NEW** 實驗 1 腳本
- `spike/browser-capability/paste-filepath-experiment.ts` — **NEW** 實驗 2+3 腳本
- `spike/browser-capability/HANDOVER.md` — Finding #47-51
- `spike/FilePaste500KExperiment.md` — 實驗結果更新（待實驗 → ✅ 完成）

**Uncommitted**:
- `.progress/progress.md` — this file
- `specs/001-mvp/plan.md` — minor updates
- `specs/001-mvp/spec.md` — minor updates
- `specs/001-mvp/tasks.md` — minor updates

**Next**:
- [ ] Review Point 2（/reviewCode + /audit）
- [ ] Phase 8+: Post-MVP（URL+PDF content, audio, screenshot, etc.）
- [ ] 主線實作：Executor pre-navigate + Tab pool weak affinity + file-based paste
- [ ] 主線實作：paste tool 加 `filePath` 參數，repoToText 改為 file output

**Key references for next session**:
- `spike/browser-capability/HANDOVER.md` — 完整 spike 交接（Finding #1-51）
- `spike/FilePaste500KExperiment.md` — file-based paste 實驗細節 + 改動範圍表
- `.claude/projects/-Users-rickwen-code-notebooklm-controller/memory/MEMORY.md` — 累積的設計決策

---

## 2026-03-14 18:30 — Phase 6+7 完成，MVP core flow ready

**Goal**: 修 Bug → Phase 6 (US3) → Phase 7 (US10) → Review Point 2

**Done**:
- **Bug fixes** (`0e104d0`): T-HF01（tabHandle.url → page.url()）、T-HF02（waitForTask 取代 waitForIdle）、T-HF03（Planner notebook context）
- **Phase 6 — US3** (`0eb71c3`): Content pipeline 完成
  - `src/content/repo-to-text.ts` — repomix CLI wrapper（execFile --stdout）
  - `src/agent/tools/content-tools.ts` — 3 defineTool（repoToText + urlToText/pdfToText stubs）
  - Tool registry 更新（15 tools = 9 browser + 3 state + 3 content）
  - 5 repo-to-text tests + 4 content-tools tests + 3 add-source integration tests
- **Phase 7 — US10** (`0eb71c3`): Query flow 完成
  - agents/query.md 已包含完整 flow
  - 3 query integration tests（成功 + no sources + timeout）
- AUDIT v2: `.audit/AUDIT-notebooklm-controller-v2@20260314.md` — 通過

**State**: Branch `001-mvp` at `0eb71c3`。574 tests passing, lint 0 errors。MVP core flow 完成：啟動 → 認證 → 納管 → 餵入 repo → 查詢 → grounded 回答。

**Next**:
- [ ] Review Point 2（/reviewCode + /audit）
- [ ] Phase 8+: Post-MVP（URL+PDF content, audio, screenshot, etc.）

---

## 2026-03-14 18:15 — Spike 回灌 + speckit.analyze 一致性修正完成

**Goal**: Spike 結論回灌 spec/plan/tasks + 全盤一致性檢查 + commit

**Done**:
- Spike 回灌 4 項 + speckit.analyze 7 findings 全修
- Commit `a564347`
- AUDIT v2 通過（附條件：T-HF01~03 必修）

**State**: 已合併至 `0eb71c3`。

---

## 2026-03-14 13:30 — Review Point 1.5 Code Review + Tour 完成

**Done**:
- Code alignment + Tours + Hotfix 區塊

**State**: 已合併至 `0eb71c3`。
