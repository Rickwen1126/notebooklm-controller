## 2026-03-15 02:00 — create_notebook tool + Chrome fixes, 準備重跑 Phase 1

**Goal**: 跑 /test-real 真實驗證，發現並修復問題

**Commits (this session)**:
1. `93fb327`: /test-real Phase 0-1 — build fixes, daemon startup, reauth, keyboard shortcuts
2. `b68019a`: create_notebook tool + Chrome crash bubble + keyboard keyCode fix

**修復總計（16 項）**:
1. SDK 型別修正（systemMessage, hooks, Tool generic, ToolResultType）
2. launcher.ts CLI entry point + --no-headless + import guard
3. package.json build cp config + tsx start
4. Chrome 自動化偵測 — ignoreDefaultArgs + disable AutomationControlled
5. Google session 啟動驗證 + 未登入保留 tab
6. reauth 導航 + loggedIn 回報 + googleSession mutable
7. exec __homepage__ 支援
8. exec result spreading fix
9. register_notebook 改名
10. viewport defaultViewport: null + window-size 1440x900
11. 鍵盤快捷鍵 — dispatchKeyCombo 明確 modifier key down/up 序列
12. 平台無關 action aliases（SelectAll, Copy, Cut, Undo）
13. keyCode 大寫修正（65 not 97）
14. create_notebook typed MCP tool（agent建立 + DOM抓URL + 自動register）
15. Chrome --disable-session-crashed-bubble --noerrdialogs
16. URL 提取 3-strategy fallback

**Phase 0: Pre-flight ✅ PASS**

**Phase 1: 進行中**
- create_notebook 兩次測試：agent 成功建立筆記本，但命名和 URL 提取有問題
- keyCode bug 已修（上次 SelectAll 失敗的可能原因）
- 需重啟 daemon 重跑

**待處理（🟡）**:
- Chrome --disable-blink-features 警告橫幅
- Node 25 ESM 必須用 tsx
- test-real checklist 缺多筆記本 concurrent 測試
- agent prompt 可能需要更精確的 rename 步驟（如果 SelectAll 修正後仍失敗）

**State**: Branch `001-mvp` at `b68019a`。642 tests ✅。

**Next**:
- [ ] 重啟 daemon
- [ ] 刪掉之前建錯的筆記本（手動或 exec）
- [ ] 用 create_notebook(title="nbctl-test") 重跑 Phase 1.1
- [ ] Phase 1.2-1.5（list, set_default, rename, get_status）
- [ ] Phase 2-5
