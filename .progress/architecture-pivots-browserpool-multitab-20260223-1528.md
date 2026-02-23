## 2026-02-23 15:28 — Architecture pivot: BrowserPool → Single Browser Multi-tab

**Goal**: 驗證 multi-tab 可行性，更新架構從 BrowserPool 到 Single Browser Multi-tab

**Done**:
- Spike 0 實驗完成：background tab screenshot ✅、Puppeteer page.click() ❌ hang、CDP Input.dispatchMouseEvent ✅、JS element.click() ✅
- 關鍵發現：background tab 不可靠是 Puppeteer 高層 API 問題，非 Chrome/CDP 限制
- Constitution v1.3.0 → v1.4.0：BrowserPool → Single Browser Multi-tab
- Spec v4 → v5：所有 BrowserPool 引用更新（US2/US17、FR-004/008/140~175、Key Entities、Clarifications、SC）
- SHIP 檔案建立 `.ship/SHIP-notebooklm-controller@20260223.md`，含 Spike 0 結論
- 3 commits pushed：`75f555a`（BrowserPool artifacts 快照）→ `d34c9f7`（constitution pivot）→ `581a2c5`（spec v5）

**Decisions**:
- BrowserPool → Single Browser Multi-tab：省記憶體（~500MB vs ~900MB）、認證簡化（userDataDir vs cookie injection）、程序管理簡化
- Agent 必須用 CDP 底層 API（Input.dispatchMouseEvent），不能用 Puppeteer page.click()
- Tab 上限從 3 Chrome instances 改為 10 tabs
- AuthManager 移除，認證改為 userDataDir 共享

**State**: Branch `001-mvp` at `581a2c5`。Spec v5 完成。SHIP [B]lock #3（Agent SDK V2）進行中（Q1 討論到 context 持久化）。

---

## 2026-02-22 10:23 — GitHub remote setup

**Goal**: Set up remote repository and push all branches

**Done**:
- Created private GitHub repo: `Rickwen1126/notebooklm-controller`
- Pushed `001-mvp` and `main` branches with upstream tracking

**State**: Both branches on remote. All local changes still unstaged (9 modified + 2 untracked from spec/plan updates).

---

## 2026-02-12 23:58 — BrowserPool architecture update complete

**Goal**: Update all design artifacts from multi-tab to BrowserPool architecture

**Done**:
- `/speckit.plan` Phase 0-1 complete, all artifacts generated and **updated to BrowserPool architecture**
- Constitution v1.2.0 → v1.3.0：BrowserPool 中央集權管理 + 全權委派操作
- spec.md v3 → v4：FR-140~147（BrowserPool+AuthManager）、FR-170~175（multi-browser）、FR-190~194（NetworkGate）、Key Entities、Clarifications、Success Criteria 全部更新
- plan.md：10 模組結構（+AuthManager）、dependency graph 重寫、constitution check ALL PASS
- research.md v2 → v3：Browser Automation 全部重寫（BrowserPool 設計、cookie injection 可行性、agent 自我修復分析）、NetworkGate 設計
- data-model.md：PageHandle → BrowserInstance、BoundTools 移除（agent 取得完整 Chrome）、NotebookEntry tabOpen → active、DaemonStatusResponse browserPool schema
- contracts/http-api.yaml：NotebookEntry schema、DaemonStatus schema、endpoint descriptions
- quickstart.md：open/close 指令描述更新
- CLAUDE.md：10 模組結構更新

**Decisions**:
- Constitution v1.3.0：BrowserPool 中央集權管理 + 全權委派操作
- Cookie sharing：userDataDir SingletonLock → 改用 cookie injection（BrowserContext.setCookie）
- Daemon 程序化：`child_process.fork` + PID file
- BrowserPool max=3（~900MB，vs multi-tab ~500MB，差 400MB 可接受）
- Agent 擁有完整 Chrome instance（非 BoundTools interface），自我修復能力大幅提升
- NetworkGate permit-based 流量控制（不在 data path）

**State**: Branch `001-mvp`. **所有設計 artifacts 已更新為 BrowserPool 架構**。Constitution v1.3.0。Spec v4。Plan 10 模組。No code written.

**User Notes**:

### 架構重大變更：Multi-tab → BrowserPool（中央集權 + 全權委派）✅ 已更新至所有 artifacts

**問題 1 — 序列化讓 multi-tab 優勢消失**：
Puppeteer research 確認 background tab 的 screenshot/click 不可靠（#3318, #12712），因此 MVP 必須序列化所有 vision 操作。但序列化後 multi-tab 的唯一好處只剩「省 navigate 時間」，不值得整個 ConnectionManager 抽象。

**問題 2 — BoundTools interface 限制 agent 自我修復能力**：
Multi-tab 架構下 session agent 拿到的是 bounded interface（`click(pageId, x, y)`），遇到意外（modal dialog、redirect、element 消失）只能回報錯誤。需要額外 repair agent + unsolved problem queue，上下文傳遞複雜。若 agent 有完整 Chrome instance，可自己截圖分析、retry、關 modal → 可靠度大幅提升。

**問題 3 — 但需要集中管理防止濫用**：
如果每個 agent 自行啟動 Chrome，daemon 無法統一管理流量、監控連線、控制 rate limit。Agent 可能不釋放 Chrome、跳過清理、甚至亂 kill process。

**最終架構：中央集權管理 + 全權委派操作**：

```
Daemon（中央集權）
├── AuthManager
│   └── 管理 Google cookies（1 headed Chrome login → extract cookies → save）
│
├── BrowserPool (max N headless Chrome instances, e.g. N=3)
│   ├── acquire(notebookUrl) → 啟動 headless Chrome + inject cookies + navigate
│   ├── release(instanceId) → 歸還 pool
│   ├── 超時沒歸還 → daemon 強制回收
│   └── Chrome 生命週期完全由 daemon 管理（agent 不能啟動/關閉 Chrome）
│
├── NetworkGate (集中式流量閘門，不在 data path，只管「能不能做」)
│   ├── acquirePermit(notebookId) → throttled 時等待
│   ├── reportAnomaly(429/timeout) → 觸發全域 backoff
│   └── getHealth() → healthy/throttled/disconnected
│
└── Agent Session (per notebook)
    ├── 拿到：完整 Chrome instance（full self-repair 能力）
    ├── 不能：啟動/關閉 Chrome（daemon 管）
    ├── 必須：操作前 acquirePermit()
    └── 靠：prompt + skill 定義約束行為
```

**Cookie sharing 機制**：
- Chrome 對 `userDataDir` 有 SingletonLock，不能共享
- 解法：headed Chrome 登入 → 擷取 Google cookies（SID, HSID, SSID, APISID, __Secure-* on .google.com）→ 儲存到 `~/.nbctl/profiles/cookies.json`
- 每個 headless Chrome instance 啟動後注入 cookies via `BrowserContext.setCookie()`
- 需實測 NotebookLM 是否只靠 cookies（可能有 localStorage/IndexedDB auth state）

**資源管理**：
- Pool max=3 → ~900MB（vs multi-tab ~500MB，差 400MB 可接受）
- 不是每個 notebook 常駐一個 Chrome，需要操作時才 acquire
- Agent 超時未歸還 → daemon 強制回收（防 agent 發瘋不釋放）

**Agent 防線（防 agent 發瘋）**：
1. Skill prompt — 明確操作範圍和禁止事項
2. BrowserPool timeout — agent 超時沒歸還 → daemon 強制回收
3. NetworkGate — 即使 agent 瘋狂操作，gate 擋住異常流量
4. Operation timeout — 單一操作超時直接 kill

**此架構同時解決**：
- Parallel 問題：多個 Chrome instance 天然支援真正 parallel
- Self-repair 問題：agent 有完整 Chrome，可自主診斷修復
- 流量控制問題：NetworkGate 集中管理 rate limit
- 資源控制問題：BrowserPool 管理 Chrome 生命週期，agent 無權自行啟停

**對照 spec 需要更新的 FR**：
- FR-140~144：ConnectionManager → BrowserPool + AuthManager + NetworkGate
- FR-170~175：multi-tab daemon → multi-browser-instance daemon
- FR-171：「跨 notebook parallel」→ BrowserPool 天然支援
- FR-172：「每 tab 獨立 agent session」→ 「每 Chrome instance 獨立 agent session」

---

## 2026-02-12 19:25 — Spec merge complete, branch consolidated to 001-mvp

**Goal**: Merge 002-abstract-cli-notify into 001-mvp as a single unified spec, consolidate branches

**Done**:
- Committed all uncommitted design artifacts on 002-abstract-cli-notify branch (a449f1b)
- Merged 002 spec into 001-mvp/spec.md as unified v3 (7386643): 756 insertions, 533 deletions
- Removed superseded artifacts: `specs/002-abstract-cli-notify/`, `contracts/mcp-tools.md` (f9abd70)
- Moved `001-mvp` branch to current HEAD, deleted `002-abstract-cli-notify` branch
- User reviewed unified spec — approved

**Decisions**:
- Merge (not patch) because no code written yet — single spec is cleaner
- US renumbering: US13=async, US14=notify, US15=skill, US16=adapter, US17=connmgr, US18=skill-param, US19=smart-select (was US14), US20-24=naming (was US15-19)
- FR numbering: keep both ranges (FR-001~051 from 001 + FR-100~184 from 002) for traceability
- Old plan.md / data-model.md kept on disk but considered stale — will be regenerated by speckit

**State**: Branch `001-mvp` at `f9abd70`. Unified spec v3 ready. Old plan/data-model/contracts stale. Ready for speckit pipeline.
