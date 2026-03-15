## 2026-03-15 04:30 — add-source + query + input gate 全部通過

**Commits (this session, 7 commits)**:
1. `93fb327`: build fixes + daemon startup + reauth + keyboard shortcuts
2. `b68019a`: create_notebook + Chrome crash bubble + keyCode fix
3. `6041174`: paste(clear=true) + agent-based create_notebook
4. `66e1482`: /test-real complete + remove shutdown
5. `b8400fa`: Goal-oriented prompts + Planner WHAT-not-HOW + bug fixes
6. `659ef89`: Debug logging (NBCTL_DEBUG=1)
7. `073222c`: Fix add-source flow + debug logging + log file

**State**: Branch `001-mvp` at `073222c`。640 tests ✅。

### /test-real 真實驗證結果

| 操作 | 結果 |
|------|------|
| create_notebook("nbctl-test") | ✅ 建立 + 命名 + 自動納管 |
| list_notebooks | ✅ |
| set_default | ✅ |
| rename_notebook | ✅ |
| add source (text) | ✅ 「複製的文字」流程完整 12 步 |
| query | ✅ grounded answer 回傳 |
| input gate (off_topic) | ✅ Rejected(off_topic) |
| input gate (ambiguous) | ✅ Rejected(ambiguous) |
| async submit + track + cancel | ✅ |
| error handling | ✅ |
| remove + cleanup | ✅ |

### Root Cause（add-source 失敗）
agent-loader.ts 的 UI Elements 表缺少 `find("新增來源") → click` 第一步。
Agent 直接找「複製的文字」但 dialog 還沒開，找不到就亂貼。
修正後 agent 完美執行 12 步流程。

### 待處理
- [ ] content pipeline: URL/PDF 轉 markdown、repo 分段
- [ ] tab pool: create_notebook URL 提取走 acquireTab
- [ ] untracked tabs 攔截
- [ ] 多筆記本 concurrent 測試
- [ ] agent prompt 自我修復能力進一步驗證
