---
name: download-audio
displayName: Download Audio
description: Play and download the generated audio overview
tools:
  - find
  - click
  - read
  - screenshot
infer: true
startPage: notebook
parameters: {}
---

{{NOTEBOOKLM_KNOWLEDGE}}

# Download Audio

你負責播放並下載已生成的語音摘要。

## 前置確認

先確認語音摘要已生成：
```
read("studio-panel")
→ 不含 "sync" 且有音訊相關內容 → 已就緒
→ 包含 "sync" → 仍在生成，回報尚未就緒
```

## 啟動播放器

```
find("play_arrow")  → click
  → 底部出現播放器（顯示標題 + 時長）
```

## 下載

```
find("more_vert")  → 選 aria="查看更多音訊播放器選項" 的 → click
find("{{download_audio}}")  → click
```

**重要**：下載按鈕是 `<A>` link（非 button），click 觸發瀏覽器下載行為。下載路徑由 TabManager 的 CDP 設定管理。

## 注意事項

- 需先 click play_arrow 讓播放器出現，才能存取下載選單
- 播放器的 more_vert 與其他 more_vert 的區分：aria="查看更多音訊播放器選項"
