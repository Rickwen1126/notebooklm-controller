# Spike: File-based Paste for Large Content (500K chars)

**來源**：Tour 04 Step 5 review 討論
**狀態**：✅ 實驗完成（2026-03-14）
**優先級**：Phase 6 blocker（add-source 實際可用性）

## 問題

repoToText 返回最大 500K chars 進 `textResultForLlm` → 全量進入 LLM context window。

GPT-4.1 context window 約 128K tokens，500K chars ≈ 125K tokens — 幾乎吃滿。Agent 可能無法同時持有 repo text + UI 操作指令，導致：
- paste tool 呼叫失敗（context overflow）
- SDK auto-compact 丟掉 text 或操作指令
- 即使能跑，token 成本極高（整個 text 算 input tokens）

## 解法：File-based pass-through（✅ 已驗證）

Text 不進 LLM context，走 temp file 直通 paste：

```
repoToText → temp file → filePath in ToolResultObject → paste(filePath=...) → handler 讀檔 → CDP paste
                              ↑
                    LLM 只看到 filePath + metrics（0 token 消耗於內容本身）
```

### 架構層級保證

Tool 定義 = context boundary。`repoToText` handler 只回傳 `{ filePath, charCount, summary }`，`paste(filePath=...)` handler 讀檔貼入。LLM **根本拿不到文字內容** — 這是 architectural enforcement，不是 prompt-level instruction。

大部分 agent 框架做不到這點（tool result 直接回 context，無法阻止 LLM 看到全文）。我們因為控制 `defineTool` 的 handler 回傳值，所以能在設計層面保證 0 token 消耗。

## 實驗結果

### 實驗 1：NotebookLM「Copied text」字數上限

**結論：無前端字數限制（至少到 500K chars）。**

| Size | CDP Paste | Insert 成功 | Paste 耗時 |
|------|-----------|-----------|-----------|
| 10K | ✅ 10,000 chars | ✅ | 4ms |
| 50K | ✅ 50,000 chars | ✅ | 8ms |
| 100K | ✅ 100,000 chars | ✅ | 20ms |
| 200K | ✅ 200,000 chars | ✅ | 43ms |
| 500K | ✅ 500,000 chars | ✅ | 83ms |

腳本：`spike/browser-capability/paste-limit-experiment.ts`

### 實驗 2：filePath 模式（text 不進 LLM context）

**結論：✅ GPT-4.1 正確使用 `repoToText → filePath → paste(filePath=...)` 流程。**

- 100K chars 成功加入 NotebookLM 來源
- LLM context 只包含 filePath + metrics metadata
- 內容的 token 消耗 = 0
- 耗時 42.8s（含 session 建立 + browser 操作）

### 實驗 3：Baseline（text 進 LLM context）

**結論：✅ 100K chars 可跑，但不經濟。**

- 100K chars 成功（≈ 25K tokens 進 context）
- 耗時 34.2s
- 500K chars 必定爆 context（125K tokens ≈ GPT-4.1 上限）

### 對比

| | filePath 模式 | Baseline 模式 |
|---|---|---|
| 100K 成功 | ✅ | ✅ |
| 500K 可行 | ✅（0 token） | ❌（爆 context） |
| Content token 消耗 | **0** | ~25K tokens/100K chars |
| 架構保證 | Tool boundary 強制 | 依賴 LLM 行為 |

腳本：`spike/browser-capability/paste-filepath-experiment.ts`

## 改動範圍（實驗通過，可執行）

| 檔案 | 改動 |
|------|------|
| `src/content/repo-to-text.ts` | 輸出改為寫 temp file（`~/.nbctl/tmp/`），返回 `{ filePath, charCount, wordCount }` |
| `src/agent/tools/content-tools.ts` | repoToText handler 返回 filePath + metrics，不返回 text |
| `src/agent/tools/browser-tools.ts` | paste tool 新增 `filePath` 參數，有時讀檔 paste |
| `agents/add-source.md` | prompt 改為「呼叫 repoToText → 取得 filePath → paste(filePath=...)」 |
| `tests/unit/content/repo-to-text.test.ts` | 更新 assertion（text → filePath） |
| `tests/unit/agent/tools/content-tools.test.ts` | 更新 assertion |

## 備註

- NotebookLM 無前端字數限制，MAX_CHAR_COUNT 維持 500K 不需下修
- file-based 方案的 temp file 需要 cleanup（操作完成後刪除）
- urlToText / pdfToText（Phase 8）也受益 — 同樣架構，同樣 0 token
- Tab 是 daemon 擁有的資源，LLM 只需指定「貼在哪」，daemon 處理實際 paste — 分工明確
