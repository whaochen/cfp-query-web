#!/usr/bin/env python3
"""
本機專用：從「環境部產品碳足跡資訊網」抓取 CFP_P_02 細部資料表格並存為 data/cfp_details.json
（因網站阻擋雲端機房 IP，此腳本需在個人本機環境執行；僅讀取網頁明細，不下載 PDF、不需驗證碼）

前置安裝（僅首次需要）：
  pip install playwright
  playwright install chromium

使用方式：
  python scripts/scrape_details_local.py --limit 5    # 先試抓 5 筆確認欄位正確
  python scripts/scrape_details_local.py              # 續傳抓完所有尚未補齊的項目
"""

from __future__ import annotations

import argparse
import json
import re
import time
import unicodedata
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

TARGET_URL = "https://cfp.moenv.gov.tw/WebPage/WebSites/CoefficientDB.aspx"
ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
FACTORS_PATH = DATA_DIR / "cfp_factors.json"
DETAILS_PATH = DATA_DIR / "cfp_details.json"

# 對應環境部細部資料頁的標準欄位名稱
FIELD_LABELS = [
    "中文名稱",
    "英文名稱",
    "化學式或俗名",
    "碳足跡排放係數數值",
    "數量",
    "生命週期範疇",
    "排除項目",
    "技術描述",
    "生產區域名稱",
    "盤查起迄日",
    "活動數據來源",
    "排放係數來源",
    "碳足跡計算輔導單位名稱",
    "建置單位名稱",
    "是否經第三方查驗證",
    "係數審查結果",
    "公告年份",
    "備註",
    "類別",
]


def normalize_key(text: str) -> str:
    return (
        unicodedata.normalize("NFKC", text)
        .replace("\u3000", " ")
        .strip()
    )


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data: Any) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def parse_detail_table(page) -> dict[str, str]:
    """從環境部細部資料頁的 OchiTrasTable（或 table）擷取所有「揭露項目：內容」。"""
    raw_pairs: list[tuple[str, str]] = page.evaluate(
        """() => {
            const results = [];
            const titles = document.querySelectorAll('.OchiTrasTable .OchiTitle');
            for (const titleEl of titles) {
                const k = (titleEl.innerText || '').replace(/\\s+/g, ' ').replace(/[：:]+$/, '').trim();
                let valEl = titleEl.nextElementSibling;
                while (valEl && !valEl.classList.contains('OchiCell')) {
                    valEl = valEl.nextElementSibling;
                }
                const v = valEl ? (valEl.innerText || '').trim() : '';
                if (k) results.push([k, v]);
            }
            if (results.length > 0) return results;

            const tables = document.querySelectorAll('table');
            for (const table of tables) {
                const rows = table.querySelectorAll('tr');
                for (const row of rows) {
                    const cells = Array.from(row.querySelectorAll('th, td'));
                    for (let i = 0; i + 1 < cells.length; i += 2) {
                        const k = (cells[i].innerText || '').replace(/\\s+/g, ' ').replace(/[：:]+$/, '').trim();
                        const v = (cells[i + 1].innerText || '').trim();
                        if (k) results.push([k, v]);
                    }
                }
            }
            return results;
        }"""
    )

    detail: dict[str, str] = {}
    for k, v in raw_pairs:
        clean_k = re.sub(r"\s+", "", k)
        if any(label in clean_k for label in FIELD_LABELS):
            detail[k] = v
    return detail


def scrape_one_item(page, factor_name: str) -> dict[str, str] | None:
    """透過關鍵字查詢並點進對應的細部資料頁。"""
    page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=30000)

    search_input = page.locator("#ContentPlaceHolder1_CoefficientData_Tab_txt_keyword")
    search_input.wait_for(state="visible", timeout=15000)
    search_input.fill("")
    search_input.fill(factor_name)

    query_btn = page.locator("#ContentPlaceHolder1_CoefficientData_Tab_btnSearch")
    query_btn.click()

    links = page.locator("a[href*='CoefficientData_Tab']")
    links.first.wait_for(timeout=15000)

    count = links.count()
    target_link = None
    norm_target = normalize_key(factor_name)

    for i in range(count):
        txt = (links.nth(i).inner_text() or "").strip()
        if txt == factor_name or normalize_key(txt) == norm_target:
            target_link = links.nth(i)
            break

    if target_link is None:
        return None

    target_link.click()
    page.wait_for_selector(".OchiTrasTable", timeout=15000)
    return parse_detail_table(page)


def main() -> int:
    parser = argparse.ArgumentParser(description="本機抓取環境部 CFP_P_02 細部資料")
    parser.add_argument("--limit", type=int, default=0, help="限制本次最多抓取筆數（0 表示全部）")
    parser.add_argument("--delay", type=float, default=0.8, help="每筆間隔秒數，避免造成伺服器負擔")
    parser.add_argument("--headless", action="store_true", help="使用無頭模式執行（預設顯示視窗方便觀察）")
    args = parser.parse_args()

    if not FACTORS_PATH.exists():
        print(f"找不到 {FACTORS_PATH}，請先執行 sync_cfp.py。")
        return 1

    factors = load_json(FACTORS_PATH, [])
    details: dict[str, dict[str, str]] = load_json(DETAILS_PATH, {})

    pending = [f for f in factors if f["name"] not in details]
    if args.limit > 0:
        pending = pending[: args.limit]

    print(f"CFP_P_02 共 {len(factors)} 筆，已完成細部資料 {len(details)} 筆，本次待抓取 {len(pending)} 筆。")
    if not pending:
        return 0

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=args.headless)
        context = browser.new_context(locale="zh-TW")
        page = context.new_page()

        success = 0
        for idx, item in enumerate(pending, start=1):
            name = item["name"]
            try:
                parsed = scrape_one_item(page, name)
                if parsed:
                    details[name] = parsed
                    success += 1
                    print(f"[{idx}/{len(pending)}] 成功：{name}（{len(parsed)} 欄）")
                else:
                    print(f"[{idx}/{len(pending)}] 未找到明細連結：{name}")
            except PlaywrightTimeoutError:
                print(f"[{idx}/{len(pending)}] 逾時略過：{name}")
            except Exception as exc:
                print(f"[{idx}/{len(pending)}] 失敗：{name} -> {exc}")

            if idx % 10 == 0:
                save_json(DETAILS_PATH, details)

            time.sleep(args.delay)

        save_json(DETAILS_PATH, details)
        browser.close()

    print(f"完成！本次新增 {success} 筆，累計 {len(details)} 筆已存至 {DETAILS_PATH}。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())