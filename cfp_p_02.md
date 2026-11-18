# 環境部碳足跡查詢系統：CFP_P_02 + CFP_P_01 架構與交接指南

本文件為 **GitHub + Cloudflare + Antigravity** 專案交接規格，資料核心採用環境部環境資料開放平臺兩大資料集：
- [碳足跡排放係數（CFP_P_02）](https://data.moenv.gov.tw/dataset/detail/CFP_P_02)：共約 1,188 項（能資源、原物料、運輸等排放係數）
- [台灣產品碳足跡資訊（CFP_P_01）](https://data.moenv.gov.tw/dataset/detail/CFP_P_01)：共約 953 項（有效期限內之碳標籤產品資訊）

## 1. 系統分工與資料流

1. **資料來源層（環境部 Open Data API）**
   - `CFP_P_02` 端點：`https://data.moenv.gov.tw/api/v2/CFP_P_02`
   - `CFP_P_01` 端點：`https://data.moenv.gov.tw/api/v2/CFP_P_01`
   - 分頁與格式：`limit=1000`、`offset=0, 1000...`、`format=json`
2. **自動同步層（GitHub Actions + `sync_cfp.py`）**
   - 每週一台北時間 10:00（及支援手動觸發）呼叫兩支 API 抓取全量資料。
   - 分別比對 `data/cfp_factors.json` 與 `data/cfp_products.json`，有新增、異動或移除時自動更新 JSON、`metadata.json` 與 `changelog.json` 並 commit 推送。
3. **網站與代管層（Antigravity + Cloudflare Pages）**
   - GitHub 收到新 commit 後，Cloudflare Pages 自動重新建置並發布靜態查詢網站。
   - 兩份 JSON 合計約數百 KB，可直接於瀏覽器端進行即時模糊搜尋與多維度篩選，免維護後端資料庫。

## 2. GitHub 專案目錄結構建議

```text
cfp-query-web/
├── .github/
│   └── workflows/
│       └── sync-cfp.yml          # 由本次產出之 sync-cfp.yml 放入此處
├── scripts/
│   └── sync_cfp.py               # 由本次產出之 sync_cfp.py 放入此處
├── data/
│   ├── cfp_factors.json          # CFP_P_02 正規化係數資料
│   ├── cfp_products.json         # CFP_P_01 正規化碳標籤產品資料
│   ├── metadata.json             # 雙資料集總筆數、最後同步時間、SHA-256
│   └── changelog.json            # 最近 30 次雙資料集異動紀錄
└── src/                          # 交由 Antigravity 開發前端查詢介面
```

## 3. 輸出資料格式

### A. 排放係數（`data/cfp_factors.json`，來自 `CFP_P_02`）

`sync_cfp.py` 會將環境部原始欄位（含原 API 拼字 `Scpoe3_iso` / `Scpoe3_ghg`）正規化為以下結構：

| 欄位名稱 | 型態 | 說明 | 範例 |
| :--- | :--- | :--- | :--- |
| `id` | string | 12 碼唯一識別碼 | `"a1b2c3d4e5f6"` |
| `name` | string | 係數名稱 | `"電力碳足跡(2022)"` |
| `coe` | string | 原始碳足跡數值（kgCO2e） | `"0.6058"` |
| `coe_num` | number \| null | 數值化欄位（供排序與計算） | `0.6058` |
| `unit` | string | 宣告單位 | `"度(kwh)"` |
| `department` | string | 建置／提供單位 | `"環境部氣候變遷署"` |
| `announcement_year` | string | 公告年份 | `"2025"` |
| `scope3_iso` | string | ISO 14064-1 範疇三適用類別 | `"類別4.2、4.5、5.1、5.2"` |
| `scope3_ghg` | string | GHG Protocol 範疇三適用類別 | `"類別3、8、10、11、13"` |

### B. 碳標籤產品（`data/cfp_products.json`，來自 `CFP_P_01`）

| 欄位名稱 | 型態 | 說明 | 範例 |
| :--- | :--- | :--- | :--- |
| `id` | string | 12 碼唯一識別碼 | `"9f8e7d6c5b4a"` |
| `product_name` | string | 產品名稱 | `"烤酥油(18 L)"` |
| `cfpl_code` | string | 碳標籤證書編號 | `"R2101507009"` |
| `company_name` | string | 公司／團體名稱 | `"台灣糖業股份有限公司小港廠"` |
| `ban` | string | 統一編號 | `"85006125"` |
| `footprint_raw` | string | 原始碳足跡數據 | `"26.00kg"` |
| `footprint_kg` | number \| null | 自動換算為 kg 之數值（支援 kg/g） | `26.0` |
| `declared_unit` | string | 宣告單位 | `"每桶(18公升)"` |
| `expired_date` | string | 證書到期日 | `"2026/12/08"` |

## 4. 部署前置步驟

1. 前往[環境部環境資料開放平臺](https://data.moenv.gov.tw/)註冊會員並取得免費 `api_key`。
2. 在 GitHub Repository 的 **Settings → Secrets and variables → Actions** 新增 Secret：
   - Name: `MOENV_API_KEY`
   - Value: 您的環境部 API Key
3. 至 GitHub **Actions** 頁面手動執行一次 **Sync MOENV CFP Datasets (CFP_P_01 & CFP_P_02)**，即可產生初始 `data/cfp_factors.json` 與 `data/cfp_products.json`。
4. 至 Cloudflare Pages 連結此 GitHub Repository，設定建置輸出目錄後即可完成自動部署。

## 5. 交給 Antigravity 的開發規格提示

> 請讀取 `data/cfp_factors.json`、`data/cfp_products.json` 與 `data/metadata.json`，建置一個靜態網頁查詢系統（部署於 Cloudflare Pages）：
>
> 1. **雙分頁切換**：「排放係數查詢（CFP_P_02）」與「碳標籤產品查詢（CFP_P_01）」。
> 2. **排放係數分頁**：支援關鍵字搜尋（`name`、`department`）、依公告年份／宣告單位／ISO 14064-1／GHG Protocol 篩選，並內建排放量試算器（活動數據 × `coe_num`）。
> 3. **碳標籤產品分頁**：支援關鍵字搜尋（`product_name`、`company_name`、`cfpl_code`、`ban`）、依到期日排序，並標示證書有效期限與換算後公斤數（`footprint_kg`）。
> 4. **資料狀態列**：頁面頂部顯示 `metadata.json` 中兩資料集之總筆數與最後同步時間，並提供連結查閱 `changelog.json` 的近期更新項目。