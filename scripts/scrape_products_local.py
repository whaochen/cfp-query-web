#!/usr/bin/env python3
"""
本機專用：從「環境部產品碳足跡資訊網」碳標籤產品查詢頁抓取 CFP_P_01 即時有效清單與細部資料，
並存為 data/cfp_product_details.json。
（因網站為 ASP.NET WebForms 動態頁面且雲端 IP 可能受限，此腳本需於本機執行；不下載附件、不需驗證碼）

前置安裝（僅首次需要）：
  pip install playwright
  playwright install chromium

使用方式：
  python scripts/scrape_products_local.py --limit 5 --headless   # 先試抓 5 筆確認欄位正確
  python scripts/scrape_products_local.py --headless             # 斷點續傳抓完所有有效碳標籤產品
"""

from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

TARGET_URL = "https://cfp.moenv.gov.tw/Carbon/WebPage/visitors/FLProductinfo.aspx"
ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
PRODUCTS_PATH = DATA_DIR / "cfp_products.json"
PRODUCT_DETAILS_PATH = DATA_DIR / "cfp_product_details.json"


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def build_ban_lookup() -> tuple[dict[str, str], dict[str, str]]:
    """從既有的開放資料 cfp_products.json 建立 核定編號/公司名稱 -> 統一編號 查詢表。"""
    by_code: dict[str, str] = {}
    by_company: dict[str, str] = {}
    products = load_json(PRODUCTS_PATH, [])
    if isinstance(products, list):
        for item in products:
            code = str(item.get("cfpl_code") or "").strip()
            company = str(item.get("company_name") or "").strip()
            ban = str(item.get("ban") or "").strip()
            if code and ban:
                by_code[code] = ban
            if company and ban and company not in by_company:
                by_company[company] = ban
    return by_code, by_company


def extract_list_rows(page, label_type: str) -> list[dict[str, str]]:
    """從目前頁面的 #ContentPlaceHolder1_sgv 擷取清單列。"""
    rows = page.evaluate(
        """(labelType) => {
            const table = document.querySelector('#ContentPlaceHolder1_sgv');
            if (!table) return [];
            const trs = Array.from(table.querySelectorAll('tr'));
            const items = [];
            for (let i = 1; i < trs.length; i++) {
                const tds = Array.from(trs[i].querySelectorAll('td'));
                if (tds.length < 8) continue;
                const clean = (el) => (el.innerText || '').replace(/\\s+/g, ' ').trim();
                const code = clean(tds[0]);
                if (!code) continue;
                items.push({
                    cfpl_code: code,
                    product_name: clean(tds[1]),
                    product_model: clean(tds[2]),
                    footprint_data: clean(tds[3]),
                    unit_carbon: clean(tds[4]),
                    pcr_no: clean(tds[5]),
                    pcr_name: clean(tds[6]),
                    company_name: clean(tds[7]),
                    green_procurement: tds[8] ? clean(tds[8]) : '',
                    label_type: labelType,
                });
            }
            return items;
        }""",
        label_type,
    )
    return rows


def collect_valid_product_list(page, limit: int = 0) -> list[dict[str, str]]:
    """收集目前所有有效的「碳標籤」與「減碳標籤」產品清單。"""
    collected: dict[str, dict[str, str]] = {}

    categories = [
        ("碳標籤", "#ContentPlaceHolder1_rdn_certificateType2"),
        ("減碳標籤", "#ContentPlaceHolder1_rdn_certificateType3"),
    ]

    for label_type, radio_selector in categories:
        if limit > 0 and len(collected) >= limit:
            break

        page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector("#ContentPlaceHolder1_sgv", timeout=20000)

        # 預設載入即為「碳標籤 + 有效」；切換為「減碳標籤」時需查詢並等待結果更新為 R 開頭
        if label_type == "減碳標籤":
            page.click(radio_selector)
            page.click("#ContentPlaceHolder1_rdn_certificateEffect2")
            page.click("#ContentPlaceHolder1_btn_search")
            page.wait_for_function(
                """() => {
                    const link = document.querySelector('#ContentPlaceHolder1_sgv_btn_ProductNameCh_0');
                    return link && link.innerText.trim().startsWith('R');
                }""",
                timeout=30000,
            )

        page.wait_for_selector("#ContentPlaceHolder1_lb_datacount", timeout=15000)

        count_text = page.locator("#ContentPlaceHolder1_lb_datacount").inner_text().strip()
        m = re.search(r"(\d+)\s*筆", count_text)
        expected_total = int(m.group(1)) if m else 0
        print(f"清單掃描【{label_type}（有效）】：{count_text}")
        if expected_total == 0:
            continue

        # 切換為每頁 200 筆以減少翻頁次數
        current_size = page.locator("#ContentPlaceHolder1_sle_pagesize").input_value()
        if current_size != "200" and expected_total > 50:
            page.select_option("#ContentPlaceHolder1_sle_pagesize", "200")
            page.wait_for_function(
                "() => document.querySelectorAll('#ContentPlaceHolder1_sgv tr').length > 52",
                timeout=45000,
            )

        page_num = 1
        while True:
            rows = extract_list_rows(page, label_type)
            for row in rows:
                code = row["cfpl_code"]
                if code not in collected:
                    collected[code] = row

            print(f"  第 {page_num} 頁讀取 {len(rows)} 筆（累計 {len(collected)} 筆）")
            if limit > 0 and len(collected) >= limit:
                break

            # 檢查是否有可點擊的「下一頁」
            next_btn = page.locator("#ContentPlaceHolder1_UC_Pager_sgv_lbtn_nextpage")
            if next_btn.count() == 0:
                break
            next_href = next_btn.get_attribute("href") or ""
            next_cls = next_btn.get_attribute("class") or ""
            if "aspNetDisabled" in next_cls or "__doPostBack" not in next_href:
                break

            first_before = rows[0]["cfpl_code"] if rows else ""
            paged = False
            for _attempt in range(2):
                next_btn.click()
                try:
                    page.wait_for_function(
                        """(prevFirst) => {
                            const link = document.querySelector('#ContentPlaceHolder1_sgv_btn_ProductNameCh_0');
                            return link && link.innerText.trim() !== prevFirst;
                        }""",
                        arg=first_before,
                        timeout=45000,
                    )
                    paged = True
                    break
                except PlaywrightTimeoutError:
                    print(f"  第 {page_num + 1} 頁載入逾時，重試中...")
            if not paged:
                break
            page_num += 1

    return list(collected.values())


def parse_detail_page(page, list_item: dict[str, str], ban_by_code: dict[str, str], ban_by_company: dict[str, str]) -> dict[str, str]:
    """從 FLProductinfoView.aspx 擷取完整細部欄位。"""
    raw = page.evaluate(
        """() => {
            const getText = (sel) => {
                const el = document.querySelector(sel);
                return el ? (el.innerText || '').trim() : '';
            };
            const pairs = {};
            document.querySelectorAll('.OchiTitle').forEach((titleEl) => {
                const k = (titleEl.innerText || '').replace(/\\s+/g, ' ').trim();
                let sib = titleEl.nextElementSibling;
                while (sib && !sib.classList.contains('OchiCell')) {
                    sib = sib.nextElementSibling;
                }
                if (!sib || !k) return;
                const a = sib.querySelector('a[href]');
                const text = (sib.innerText || '').trim();
                const href = a ? (a.getAttribute('href') || '').trim() : '';
                pairs[k] = { text, href };
            });

            // 碳足跡數據/標示單位（#ContentPlaceHolder1_lb_CarbonFootDataUnitFunction_V 等整格文字）
            let footprintCombined = '';
            if (pairs['碳足跡數據/標示單位']) {
                footprintCombined = pairs['碳足跡數據/標示單位'].text.replace(/\\s+/g, ' ').trim();
            }

            // 產品碳足跡相關資訊網址
            const urlCell = document.querySelector('#ContentPlaceHolder1_lb_LabelDesc7');
            let infoUrl = '';
            if (urlCell) {
                const link = urlCell.querySelector('a[href]');
                infoUrl = link ? (link.getAttribute('href') || '').trim() : (urlCell.innerText || '').trim();
            } else if (pairs['產品碳足跡相關資訊網址']) {
                infoUrl = pairs['產品碳足跡相關資訊網址'].href || pairs['產品碳足跡相關資訊網址'].text;
            }

            return {
                product_name: getText('#ContentPlaceHolder1_lb_ProductNameCh') || (pairs['產品名稱']?.text || ''),
                product_type: getText('#ContentPlaceHolder1_lb_ProductState_V') || (pairs['產品類型']?.text || ''),
                product_model: getText('#ContentPlaceHolder1_lb_ProductModelCh') || (pairs['產品型號']?.text || ''),
                cert_block: pairs['碳標籤核定']?.text || '',
                company_name: getText('#ContentPlaceHolder1_lb_CompanyNameCh') || (pairs['公司/團體名稱']?.text || ''),
                ban_page: pairs['統一編號']?.text || '',
                info_url: infoUrl,
                footprint_combined: footprintCombined,
                footprint_val: getText('#ContentPlaceHolder1_lb_CarbonFootDataUnitFunction_V'),
                declared_unit: getText('#ContentPlaceHolder1_sp_FunctionUnit'),
                lifecycle_share: getText('#ContentPlaceHolder1_lb_LifeCycleData'),
                pcr_name: getText('#ContentPlaceHolder1_lb_PCRName'),
                pcr_no: getText('#ContentPlaceHolder1_lb_PCRNo'),
                reduction_commitment: getText('#ContentPlaceHolder1_lb_LessCarbonCommitment'),
            };
        }"""
    )

    cert_block = raw.get("cert_block") or ""
    cert_no = ""
    effective_date = ""
    expired_date = ""
    status = ""

    if m := re.search(r"編號\s*[:：]\s*([^\s\n]+)", cert_block):
        cert_no = m.group(1).strip()
    if m := re.search(r"生效日期\s*[:：]\s*([0-9/\-]+)", cert_block):
        effective_date = m.group(1).strip()
    if m := re.search(r"有效期限\s*[:：]\s*([0-9/\-]+)", cert_block):
        expired_date = m.group(1).strip()
    if m := re.search(r"狀態\s*[:：]\s*([^\s\n]+)", cert_block):
        status = m.group(1).strip()

    cfpl_code = cert_no or list_item["cfpl_code"]
    company_name = raw.get("company_name") or list_item.get("company_name", "")
    ban = (
        (raw.get("ban_page") or "").strip()
        or ban_by_code.get(cfpl_code, "")
        or ban_by_company.get(company_name, "")
    )

    footprint_data = list_item.get("footprint_data") or raw.get("footprint_combined") or raw.get("footprint_val") or ""
    declared_unit = raw.get("declared_unit") or list_item.get("declared_unit") or ""

    return {
        "產品名稱": raw.get("product_name") or list_item.get("product_name", ""),
        "產品型號": raw.get("product_model") or list_item.get("product_model", ""),
        "產品類型": raw.get("product_type") or "",
        "碳標籤證書編號": cfpl_code,
        "生效日期": effective_date,
        "有效期限": expired_date,
        "狀態": status,
        "公司／團體名稱": company_name,
        "統一編號": ban,
        "碳足跡數據": footprint_data,
        "宣告單位": declared_unit,
        "產品碳足跡相關資訊網址": raw.get("info_url") or "",
        "單位碳排": list_item.get("unit_carbon", ""),
        "PCR文件編號": raw.get("pcr_no") or list_item.get("pcr_no", ""),
        "PCR文件名稱": raw.get("pcr_name") or list_item.get("pcr_name", ""),
        "綠色採購": list_item.get("green_procurement", ""),
        "標籤類別": list_item.get("label_type", ""),
        "生命週期各階段比例": raw.get("lifecycle_share") or "",
        "碳排放減量承諾": raw.get("reduction_commitment") or "",
        "明細頁網址": page.url,
    }


def scrape_one_product(
    page,
    list_item: dict[str, str],
    ban_by_code: dict[str, str],
    ban_by_company: dict[str, str],
) -> dict[str, str] | None:
    """透過核定編號查詢並點進 FLProductinfoView.aspx 擷取完整明細。"""
    cfpl_code = list_item["cfpl_code"]
    page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_selector("#ContentPlaceHolder1_tbx_search_CaseNo", timeout=15000)

    if list_item.get("label_type") == "減碳標籤" or cfpl_code.startswith("R"):
        page.click("#ContentPlaceHolder1_rdn_certificateType3")
    else:
        page.click("#ContentPlaceHolder1_rdn_certificateType2")

    page.click("#ContentPlaceHolder1_rdn_certificateEffect2")
    page.fill("#ContentPlaceHolder1_tbx_search_CaseNo", cfpl_code)

    with page.expect_response(lambda r: "FLProductinfo.aspx" in r.url and r.status == 200, timeout=20000):
        page.click("#ContentPlaceHolder1_btn_search")

    # 等待表格第一列變成目標核定編號
    page.wait_for_function(
        """(targetCode) => {
            const link = document.querySelector('#ContentPlaceHolder1_sgv_btn_ProductNameCh_0');
            return link && link.innerText.trim() === targetCode;
        }""",
        arg=cfpl_code,
        timeout=30000,
    )

    with page.expect_navigation(wait_until="domcontentloaded", timeout=45000):
        page.click("#ContentPlaceHolder1_sgv_btn_ProductNameCh_0")

    page.wait_for_selector("#ContentPlaceHolder1_lb_ProductNameCh", timeout=25000)
    return parse_detail_page(page, list_item, ban_by_code, ban_by_company)


def main() -> int:
    parser = argparse.ArgumentParser(description="本機抓取環境部 CFP_P_01 有效碳標籤產品與細部資料")
    parser.add_argument("--limit", type=int, default=0, help="限制本次最多抓取筆數（0 表示全部）")
    parser.add_argument("--delay", type=float, default=0.5, help="每筆間隔秒數，避免造成伺服器負擔")
    parser.add_argument("--headless", action="store_true", help="使用無頭模式執行（預設顯示視窗方便觀察）")
    parser.add_argument("--refresh", action="store_true", help="重新抓取已存在的項目")
    args = parser.parse_args()

    ban_by_code, ban_by_company = build_ban_lookup()
    details: dict[str, dict[str, str]] = load_json(PRODUCT_DETAILS_PATH, {})
    if not isinstance(details, dict):
        details = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=args.headless)
        context = browser.new_context(locale="zh-TW")
        page = context.new_page()

        all_items = collect_valid_product_list(page, limit=0 if args.refresh else 0)
        pending = [
            item for item in all_items
            if args.refresh or item["cfpl_code"] not in details
        ]
        if args.limit > 0:
            pending = pending[: args.limit]

        print(
            f"有效碳標籤清單共 {len(all_items)} 筆，"
            f"已完成細部資料 {len(details)} 筆，"
            f"本次待抓取 {len(pending)} 筆。"
        )
        if not pending:
            browser.close()
            return 0

        success = 0
        for idx, item in enumerate(pending, start=1):
            code = item["cfpl_code"]
            name = item["product_name"]
            try:
                parsed = scrape_one_product(page, item, ban_by_code, ban_by_company)
                if parsed:
                    details[code] = parsed
                    success += 1
                    print(f"[{idx}/{len(pending)}] 成功：{code} {name}（型號：{parsed.get('產品型號', '')}）")
                else:
                    print(f"[{idx}/{len(pending)}] 未取得明細：{code} {name}")
            except PlaywrightTimeoutError:
                print(f"[{idx}/{len(pending)}] 逾時略過：{code} {name}")
            except Exception as exc:
                print(f"[{idx}/{len(pending)}] 失敗：{code} {name} -> {exc}")

            if idx % 10 == 0:
                save_json(PRODUCT_DETAILS_PATH, details)

            time.sleep(args.delay)

        save_json(PRODUCT_DETAILS_PATH, details)
        browser.close()

    print(f"完成！本次新增/更新 {success} 筆，累計 {len(details)} 筆已存至 {PRODUCT_DETAILS_PATH}。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
