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

**User Notes**:
- SHIP + insight-learning 比 speckit 更深——檢查的是「設計 vs 現實」的矛盾，不只是 artifacts 一致性
- 資料模型設計要為 agent context 服務（最小 context 精確接手）
- content/ 模組是 utils layer，agent/tools/ 才是 SDK wrapper
- 不要依賴 notification 太重，使用者自己負責記得拉結果

---

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

**User Notes**:
- 用戶對 SDK 與 spec 的高度契合感到驚喜
- 用戶認為 Skill 應該叫 agent config，因為 agent 只有一種定義（SDK 的 CustomAgentConfig）
- 「Agent team program」比「daemon agent program」更精確
- Vision agent 座標點擊是萬能修復工具，不需要給 agent 寫 script 的能力
