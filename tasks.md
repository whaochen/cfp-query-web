# TASKS.md — 品牌升級：導入「晧脈元素庫」[06 C] 徽章與返回總站導覽

請 Antigravity 完成以下品牌與導覽升級（**注意「晧」字務必使用日字旁的「晧」**），完成後建置並 `git push`：

## Task 1：更新瀏覽器分頁標題與網站主標／副標
1. 將 `index.html` 的 `<title>` 更新為：`[06 C] 台灣環境部碳足跡查詢系統｜晧脈元素庫`。
2. 將頁首左側 Logo 區域改為**週期表元素方塊徽章**設計：
   - 元素方塊（取代原本葉子圖示）：左上角小字顯示原子序 `06`、中央粗體顯示元素符號 `C`、底部小字 `Carbon`（延續現有深綠／翡翠綠質感配色）。
   - 主標題：`台灣環境部碳足跡查詢系統`
   - 副標題：`晧脈元素庫 · 環境部 CFP_P_02 & CFP_P_01`

## Task 2：新增「返回晧脈元素庫」跨站導覽按鈕與頁尾宣告
1. 在頁首右側（「更新紀錄」按鈕旁）新增一顆清晰但不搶眼的連結按鈕：**`✦ 返回晧脈元素庫`**，點擊連結至 `https://hao-element-matrix.pages.dev/`（開啟原視窗或新分頁皆可，建議加明確外連／總站圖示）。
2. 在頁面最下方補上精簡頁尾：顯示 `晧脈元素庫 · #06 C 碳足跡與永續系統`、連結回 `https://hao-element-matrix.pages.dev/`，以及資料來源宣告（環境部環境資料開放平臺 CFP_P_02 / CFP_P_01 與產品碳足跡資訊網）。

## Task 3：驗證與推送
1. 確認桌機與手機版頁首不換行爆版、徽章與標題對齊美觀、點擊「返回晧脈元素庫」可正確前往 `https://hao-element-matrix.pages.dev/`。
2. 執行 `npm run build` 確認無誤後，`git add .`、`git commit -m "feat(brand): apply Hao Element Matrix [06 C] badge and hub navigation"` 並 `git push`。