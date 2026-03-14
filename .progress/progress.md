## 2026-03-15 04:00 — Prompt 重寫 + bug fixes，準備重新測試

**Commits (this session, 5 commits)**:
1. `93fb327`: build fixes + daemon startup + reauth + keyboard shortcuts
2. `b68019a`: create_notebook tool + Chrome crash bubble + keyboard keyCode fix
3. `6041174`: paste(clear=true) + agent-based create_notebook + tab/Chrome fixes
4. `66e1482`: /test-real complete + remove shutdown MCP tool
5. `b8400fa`: Goal-oriented agent prompts + Planner WHAT-not-HOW + code bug fixes

**State**: Branch `001-mvp` at `b8400fa`。640 tests ✅。

### Prompt 架構改動
- `_knowledge.md`: 觀察→行動→驗證 loop、元件名稱是高信心參考不是指令
- Planner systemMessage: executorPrompt 只說 WHAT 不說 HOW
- Agent prompts: goal-oriented + reference flow 風格
- add-source: 一律走「複製的文字」
- query: 明確要求 read 回完整答案

### 已修 Bug
- input gate rejection metadata 傳遞
- URL normalize（去 query params）

### 待處理
- [ ] 重新跑 /test-real 全流程驗證
- [ ] session log 加 prompt/systemMessage 內容（debug 用）
- [ ] tab pool: create_notebook URL 提取應走 acquireTab/releaseTab
- [ ] untracked tabs 攔截（browser.on targetcreated）
- [ ] content pipeline: URL/PDF 轉 markdown 品質改善
- [ ] repo 分段貼上（超過 limit 時自動分 chunk）
- [ ] agent prompt 自我修復能力驗證
