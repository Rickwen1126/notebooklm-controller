# NotebookLM Agent Daemon - 架構討論筆記

## 背景：現有 notebooklm-skill 的做法

現有的 notebooklm-skill 透過 **Patchright（Playwright 反偵測分支）** 操控 headless Chrome，每次提問都：

1. 啟動 headless Chrome
2. 注入 cookies + 載入 browser profile
3. 導航到 NotebookLM 頁面
4. 用 CSS selector 找到輸入框 → 模擬打字 → 按 Enter
5. 輪詢 DOM 等待回答穩定 → 提取文字
6. 關閉瀏覽器

**限制：**

- 純 DOM 操作（CSS selector），無法處理複雜互動（加入來源、生成語音、新增 notebook）
- 無狀態 — 每次問問題都重新啟動/關閉瀏覽器
- selector 脆弱 — Google UI 一改就壞
- headless 模式下解析度不確定（`no_viewport=True` → 大概 800x600）

## 升級路線分析

### Level 1: 純 DOM Selector（現狀）

快、簡單，但只能做 Q&A，無法擴展。

### Level 2: DOM + 截圖輔助

失敗時截圖供人工/AI 診斷，但操作邏輯仍靠 selector。

### Level 3: 截圖 + Vision 驅動

不依賴 selector，靠「看畫面」決定下一步，抗 UI 變更能力強。

**問題：截圖非常燒上下文（每張 ~1000+ tokens），多步驟操作可能 5-10 張圖。**

## 方案演進

### 方案 A: Subagent 模式

把 iso-browser 指令寫進 subagent prompt，截圖在 subagent 上下文中分析，主對話只拿回文字結果。

**優點：** 上下文隔離，主對話不受影響。

**缺點：** 無狀態 — subagent 跑完就死，每次都要重新認識環境、重新導航。

### 方案 B: 常駐 Agent Daemon（結論方案）

用 Agent SDK 建構一個常駐的代理人程式（daemon），接受主對話的指令，內部自主處理瀏覽器操作與視覺分析。

## 結論方案：常駐 Agent Daemon 架構

```
┌─────────────────┐
│  Main Claude      │  ← 正常對話，上下文乾淨
│  Code Session     │
└───────┬──────────┘
        │  stdin/stdout 或 HTTP
        ▼
┌─────────────────────────────────┐
│  NotebookLM Agent Daemon         │  ← Agent SDK 驅動
│                                  │
│  ┌─ 自己的 Claude 上下文 ──────┐  │
│  │ • 記得當前在哪個 notebook    │  │
│  │ • 記得已有哪些來源           │  │
│  │ • 截圖分析在這裡燒           │  │
│  │ • 可以自己 compact           │  │
│  └─────────────────────────────┘  │
│                                  │
│  Tools:                          │
│  • iso-browser (bash scripts)    │
│  • screenshot → vision           │
│  • file upload                   │
│  └───────────────────────────────┘
└──────────────────────────────────┘
        │
        ▼
┌──────────────┐
│  Chrome       │  ← iso-browser 長駐實例
│  (port 9223)  │
└──────────────┘
```

### 核心優勢

| 面向 | Subagent | Agent Daemon |
|------|----------|-------------|
| 狀態 | 無狀態，每次重新開始 | 有狀態，記得之前做過什麼 |
| 上下文 | 烧在 subagent 裡（但每次丟棄） | 自主管理，可 compact |
| 瀏覽器 | 每次啟動/關閉 | 長駐，搭配 iso-browser |
| 速度 | 冷啟動開銷 | 即時回應 |
| 複雜操作 | 可行但笨拙 | 天然適合多步驟 |

### 主對話側極輕量

```bash
# 主對話只需要：
echo "加入來源 https://..." | notebooklm-daemon
# → "已加入。目前共 5 個來源。"

echo "這個 notebook 講什麼？" | notebooklm-daemon
# → "這個 notebook 包含 React 19 文件..."

echo "生成語音摘要" | notebooklm-daemon
# → "語音生成中... 完成，已存到 /tmp/audio-overview.wav"
```

### 需解決的問題

| 問題 | 方向 |
|------|------|
| Agent SDK 的 agent loop 怎麼做長駐 | HTTP server 或 Unix socket 接收指令，每個指令走一輪 agent loop |
| 上下文爆了怎麼辦 | daemon 自己做 compaction，把舊截圖/操作摘要化 |
| 主對話怎麼跟 daemon 通信 | 最簡單：Bash 調 CLI；進階：本地 HTTP API |
| daemon 崩了怎麼辦 | 狀態存磁碟（當前 notebook、browser port），可恢復 |
| 視覺分析的解析度 | iso-browser 有窗口，所見即所得；或明確設定 viewport |

### 本質差異

```
notebooklm-skill:  Python + Patchright，每次開關瀏覽器，純 DOM，無狀態
Agent Daemon:      Agent SDK + iso-browser，常駐，有視覺，有狀態
```

從「腳本工具」升級成「自主代理服務」。
