# 技術研究報告：NotebookLM Controller MVP

**Date**: 2026-02-07
**Feature Branch**: `001-mvp`

## 1. 語言與框架選擇

### Decision: TypeScript + Node.js

**Rationale**:
- Agent SDK (`@anthropic-ai/claude-agent-sdk`) 提供 TypeScript SDK
- MCP SDK (`@modelcontextprotocol/sdk`) 為 TypeScript 原生
- puppeteer-core 為 Node.js 生態系標準 CDP 工具
- 統一語言減少維護成本

**Alternatives considered**:
- Python：有 Agent SDK Python 版本，但 MCP TypeScript SDK 更成熟，
  且 puppeteer-core 只有 Node.js 版本（Python 替代品 Playwright 可行但非首選）

## 2. Agent SDK

### Decision: `@anthropic-ai/claude-agent-sdk` V2 API

**Key findings**:
- V2 API 提供 `unstable_v2_createSession` / `unstable_v2_resumeSession`
  明確的 session 生命週期管理，適合 daemon 架構
- 每個 session 獨立上下文，可自動 compact
- 支援 1M token context window（beta）

**Architecture pattern**:
```
Daemon process
├── Session Manager: Map<notebookId, SessionId>
├── 每個 notebook 一個 agent session
├── session.send() 發送指令，session.stream() 取得結果
└── 切換 notebook 時暫存/恢復 session
```

**Known limitations**:
- V2 API 為 unstable preview，API 可能變更
- 每次 query() (V1) 有 ~12 秒冷啟動；V2 persistent session 可緩解
- Vision 分析每張截圖 ~1000+ tokens

**Mitigation**:
- 使用 V2 session 避免冷啟動
- 截圖分析在 daemon 隔離上下文中消耗，不影響主對話
- SDK 自動 compact 處理 token 限制

## 3. Browser Automation

### Decision: puppeteer-core 連接 iso-browser Chrome

**Rationale**:
- puppeteer-core 可連接既有 Chrome instance（不捆綁 Chromium）
- 透過 `puppeteer.connect({ browserWSEndpoint })` 連接 iso-browser
- CDP 提供完整的截圖、點擊、輸入、滾動能力
- 比 Playwright 更輕量，Chrome-specific 即可

**Connection pattern**:
```typescript
// 查詢 Chrome WebSocket endpoint
// GET http://127.0.0.1:19223/json/version → { webSocketDebuggerUrl: "ws://..." }
const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
```

**Alternatives considered**:
- Playwright：更重，跨瀏覽器能力此專案不需要
- chrome-remote-interface：太低階，API 不便

## 4. MCP Server

### Decision: `@modelcontextprotocol/sdk` v1.x, stdio transport, 內嵌於 daemon

**Key findings**:
- `McpServer` 高階 API 簡單定義 tools
- Stdio transport 透過 stdin/stdout JSON-RPC 通訊
- 可與 HTTP server 共存於同一程序（注意 stdout 只能用於 MCP）
- 透過 closure 直接共用 daemon 狀態

**Critical gotcha**:
- stdio transport 下 **禁止 console.log()**，只能用 console.error()
- Tool schema 用 plain object + Zod，不用 `z.object()` 包裝
- import path 需加 `.js` 後綴

## 5. Content Pipeline

### Decision: repomix + Readability + pdf-parse

**repoToText**: `repomix` npm 套件
- 有完整 Node.js 程式化 API（非僅 CLI）
- 支援 XML/Markdown/JSON/Plain text 輸出
- 內建 token 計算（Tiktoken）
- 自動尊重 .gitignore，偵測 binary 與敏感資料
- `--compress` 模式用 Tree-sitter 減少 ~70% tokens

**urlToText**: `@mozilla/readability` + `jsdom`
- Mozilla Readability 擷取文章主體
- jsdom 解析 HTML DOM
- 可搭配 puppeteer-core 處理需要 JS 渲染的頁面

**pdfToText**: `pdf-parse` 或 `pdf2json`
- pdf-parse：簡單直接，適合文字 PDF
- 複雜排版 PDF 可用 `pdfjs-dist`

## 6. HTTP Server

### Decision: Fastify

**Rationale**:
- 高效能（比 Express 快 2-3x）
- 內建 JSON schema validation
- 良好的 TypeScript 支援
- 輕量，適合 daemon 場景

**Alternatives considered**:
- Express：更重，此專案不需其龐大的 middleware 生態
- Hono：較新，生態系尚不穩定

## 7. State Persistence

### Decision: JSON 檔案 + 單一寫入鎖

**Rationale**:
- Notebook Registry 資料量小（最多 20 個 notebook 的元資料）
- JSON 檔案人類可讀，便於除錯
- 單一 daemon 程序，不需要 SQLite 級別的並行控制
- 寫入時使用 atomic write（寫到 temp 再 rename）

**Storage location**: `~/.nbctl/` 目錄
- `~/.nbctl/state.json`：Notebook Registry + active notebook
- `~/.nbctl/cache/<notebook-id>/`：per-notebook 來源元資料、artifacts 紀錄
- `~/.nbctl/logs/`：操作日誌

## 8. CLI Framework

### Decision: Commander.js

**Rationale**:
- Node.js CLI 標準框架
- 支援子命令（start, stop, status, list, open, close, use, add, add-all, exec, login）
- 內建 help generation
- 輕量，零配置

## 9. 測試框架

### Decision: Vitest

**Rationale**:
- 與 Vite 生態系一致
- 原生 TypeScript 支援，無需額外配置
- Jest 相容 API，學習成本低
- 內建 mock 功能

## 10. 技術風險與緩解

| 風險 | 影響 | 緩解策略 |
|------|------|----------|
| Agent SDK V2 API unstable | API 可能變更 | 封裝 adapter layer，隔離 SDK 依賴 |
| NotebookLM UI 更新破壞 agent | 操作失敗 | Vision-based 而非 selector-based；失敗時回報截圖 |
| 截圖 token 消耗大 | 上下文爆炸 | SDK 自動 compact；限制單次操作截圖數 |
| Chrome CDP 連線不穩 | 操作中斷 | 重連機制 + idle 心跳檢查 |
| stdio MCP + HTTP 共存 | stdout 衝突 | 嚴格禁止 console.log，全面使用 stderr |
