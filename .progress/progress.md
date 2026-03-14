## 2026-03-15 03:00 — Phase 0-1 PASS, Phase 2 進行中

**Commits (this session)**:
1. `93fb327`: build fixes + daemon startup + reauth + keyboard shortcuts
2. `b68019a`: create_notebook tool + Chrome crash bubble + keyboard keyCode fix
3. `6041174`: paste(clear=true) + agent-based create_notebook + tab/Chrome fixes

**Phase 0: Pre-flight ✅ PASS**
**Phase 1: Notebook Mgmt ✅ PASS**
- create_notebook, list, set_default, rename, get_status 全部通過

**Phase 2: Content Pipeline — 進行中**
- 2.1 repo 來源：repo 1.5M chars 超過 500K limit → 正常拒絕，需用小 repo 測
- 2.2 URL 來源：agent 找不到「網址來源」選項 → add-source agent prompt 問題
- 2.3-2.5：尚未測

### 發現的問題（累積）

**🔴 需修復（影響功能）**:
1. ~~SelectAll 鍵盤快捷鍵不可靠~~ → 已用 paste(clear=true) 解決
2. add-source agent 不知道怎麼操作 URL 來源按鈕 → agent prompt 需更新
3. create_notebook URL 提取應走 tab pool（acquireTab/releaseTab）而非 openTab/closeTab

**🟡 需修復（非阻塞）**:
4. Chrome --disable-blink-features 警告橫幅（cosmetic）
5. Node 25 ESM 必須用 tsx
6. test-real checklist 缺多筆記本 concurrent 測試
7. 點擊多開 tab — NotebookLM target=_blank 行為導致 untracked tabs
   - Tab pool 不知道瀏覽器自己多開的 tab
   - 需要 browser.on('targetcreated') 攔截或操作前後比對清理
8. create_notebook URL 有 `?addSource=true` query string，應清掉

**State**: Branch `001-mvp` at `6041174`。642 tests ✅。

**Next**:
- [ ] 繼續 Phase 2（用小 repo 或改 URL 來源的 agent prompt）
- [ ] Phase 3: Async + Tasks
- [ ] Phase 4: Error Handling
- [ ] Phase 5: Cleanup
- [ ] 批次修復累積問題
