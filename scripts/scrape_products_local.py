#!/usr/bin/env python3
"""
本機專用：從「環境部產品碳足跡資訊網」碳標籤產品查詢頁抓取 CFP_P_01 全量清單（含碳標籤＋減碳標籤、
有效＋過期、商品＋服務，約 2,201 筆）與細部資料，更新 data/cfp_products.json、
data/cfp_product_details.json 與 data/metadata.json。

使用方式：
  python scripts/scrape_products_local.py --limit 5 --headless
  python scripts/scrape_products_local.py --workers 4 --headless
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeoutError

TARGET_URL = "https://cfp.moenv.gov.tw/Carbon/WebPage/visitors/FLProductinfo.aspx"
ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
PRODUCTS_PATH = DATA_DIR / "cfp_products.json"
PRODUCT_DETAILS_PATH = DATA_DIR / "cfp_product_details.json"
METADATA_PATH = DATA_DIR / "metadata.json"


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


def parse_footprint_kg(raw: str) -> float | None:
    s = str(raw or "").replace(",", "").strip()
    m = re.search(r"(\d+(?:\.\d+)?)\s*(kg|公斤|g|公克|t|mt|公噸)", s, re.IGNORECASE)
    if not m:
        return None
    val = float(m.group(1))
    unit = m.group(2).lower()
    if unit in ("g", "公克"):
        return round(val / 1000.0, 6)
    if unit in ("t", "mt", "公噸"):
        return round(val * 1000.0, 6)
    return round(val, 6)


def make_product_id(cfpl_code: str) -> str:
    return hashlib.sha1(cfpl_code.encode("utf-8")).hexdigest()[:12]


def build_existing_lookups() -> tuple[dict[str, dict[str, Any]], dict[str, str], dict[str, str]]:
    """從既有 cfp_products.json 建立 code -> item 與 統一編號 查詢表。"""
    existing_by_code: dict[str, dict[str, Any]] = {}
    ban_by_code: dict[str, str] = {}
    ban_by_company: dict[str, str] = {}
    products = load_json(PRODUCTS_PATH, [])
    if isinstance(products, list):
        for item in products:
            code = str(item.get("cfpl_code") or "").strip()
            company = str(item.get("company_name") or "").strip()
            ban = str(item.get("ban") or "").strip()
            if code:
                existing_by_code[code] = item
                if ban:
                    ban_by_code[code] = ban
            if company and ban and company not in ban_by_company:
                ban_by_company[company] = ban
    return existing_by_code, ban_by_code, ban_by_company


async def extract_list_rows(page) -> list[dict[str, str]]:
    """從目前頁面的 #ContentPlaceHolder1_sgv 擷取清單列。"""
    return await page.evaluate(
        """() => {
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
                    label_type: code.toUpperCase().startsWith('R') ? '減碳標籤' : '碳標籤',
                });
            }
            return items;
        }"""
    )


async def collect_all_products_list(page) -> list[dict[str, str]]:
    """將所有條件設為「全部」（不勾選綠色採購）並以每頁 200 筆掃描全量清單（約 2,201 筆）。"""
    await page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=45000)
    await page.wait_for_selector("#ContentPlaceHolder1_sgv", timeout=25000)

    # 確保 標籤類別=全部、產品類型=全部、標籤狀態=全部、綠色採購=不勾選
    await page.click("#ContentPlaceHolder1_rdn_certificateType1")
    await page.click("#ContentPlaceHolder1_rdn_ProductState1")
    await page.click("#ContentPlaceHolder1_rdn_certificateEffect1")
    green_cb = page.locator("#ContentPlaceHolder1_cbx_GreenProcurement")
    if await green_cb.is_checked():
        await green_cb.uncheck()

    await page.click("#ContentPlaceHolder1_btn_search")
    await page.wait_for_function(
        """() => {
            const t = document.querySelector('#ContentPlaceHolder1_lb_datacount')?.innerText || '';
            const m = t.match(/(\\d+)\\s*筆/);
            return m && parseInt(m[1], 10) > 1000;
        }""",
        timeout=45000,
    )

    count_text = (await page.locator("#ContentPlaceHolder1_lb_datacount").inner_text()).strip()
    m = re.search(r"(\d+)\s*筆", count_text)
    expected_total = int(m.group(1)) if m else 0
    print(f"清單掃描【全量（全部類別／商品與服務／有效與過期）】：{count_text}")

    # 切換為每頁 200 筆（約 12 頁）
    if expected_total > 50:
        await page.select_option("#ContentPlaceHolder1_sle_pagesize", "200")
        await page.wait_for_function(
            "() => document.querySelectorAll('#ContentPlaceHolder1_sgv tr').length > 100",
            timeout=45000,
        )

    collected: dict[str, dict[str, str]] = {}
    page_num = 1
    while True:
        rows = await extract_list_rows(page)
        for row in rows:
            code = row["cfpl_code"]
            if code not in collected:
                collected[code] = row

        print(f"  第 {page_num} 頁讀取 {len(rows)} 筆（累計 {len(collected)} / {expected_total} 筆）")
        if expected_total and len(collected) >= expected_total:
            break

        next_btn = page.locator("#ContentPlaceHolder1_UC_Pager_sgv_lbtn_nextpage")
        if await next_btn.count() == 0:
            break
        next_href = await next_btn.get_attribute("href") or ""
        next_cls = await next_btn.get_attribute("class") or ""
        if "aspNetDisabled" in next_cls or "__doPostBack" not in next_href:
            break

        first_before = rows[0]["cfpl_code"] if rows else ""
        paged = False
        for _ in range(2):
            await next_btn.click()
            try:
                await page.wait_for_function(
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
                print(f"  第 {page_num + 1} 頁逾時，重試中...")
        if not paged:
            break
        page_num += 1

    return list(collected.values())


async def parse_detail_page(
    page,
    list_item: dict[str, str],
    ban_by_code: dict[str, str],
    ban_by_company: dict[str, str],
) -> dict[str, str]:
    raw = await page.evaluate(
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

            let footprintCombined = '';
            if (pairs['碳足跡數據/標示單位']) {
                footprintCombined = pairs['碳足跡數據/標示單位'].text.replace(/\\s+/g, ' ').trim();
            }

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
    declared_unit = raw.get("declared_unit") or ""
    if not declared_unit and "/" in footprint_data:
        declared_unit = footprint_data.split("/", 1)[1].strip()

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
        "標籤類別": "減碳標籤" if cfpl_code.upper().startswith("R") else "碳標籤",
        "生命週期各階段比例": raw.get("lifecycle_share") or "",
        "碳排放減量承諾": raw.get("reduction_commitment") or "",
        "明細頁網址": page.url,
    }


async def scrape_one_product(
    page,
    list_item: dict[str, str],
    ban_by_code: dict[str, str],
    ban_by_company: dict[str, str],
) -> dict[str, str] | None:
    cfpl_code = list_item["cfpl_code"]
    await page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=45000)
    await page.wait_for_selector("#ContentPlaceHolder1_tbx_search_CaseNo", timeout=20000)

    # 標籤類別／產品類型／標籤狀態皆設為「全部」，避免過期或減碳標籤查無項目
    await page.click("#ContentPlaceHolder1_rdn_certificateType1")
    await page.click("#ContentPlaceHolder1_rdn_ProductState1")
    await page.click("#ContentPlaceHolder1_rdn_certificateEffect1")
    await page.fill("#ContentPlaceHolder1_tbx_search_CaseNo", cfpl_code)
    await page.click("#ContentPlaceHolder1_btn_search")

    await page.wait_for_function(
        """(targetCode) => {
            const links = Array.from(document.querySelectorAll('#ContentPlaceHolder1_sgv a[id*="btn_ProductNameCh"]'));
            return links.some(a => a.innerText.trim() === targetCode);
        }""",
        arg=cfpl_code,
        timeout=30000,
    )

    target_link = page.locator("#ContentPlaceHolder1_sgv a[id*='btn_ProductNameCh']", has_text=cfpl_code).first
    async with page.expect_navigation(wait_until="domcontentloaded", timeout=60000):
        await target_link.click()

    await page.wait_for_selector("#ContentPlaceHolder1_lb_ProductNameCh", timeout=30000)
    return await parse_detail_page(page, list_item, ban_by_code, ban_by_company)


def sync_products_and_metadata(
    all_items: list[dict[str, str]],
    details: dict[str, dict[str, str]],
    existing_by_code: dict[str, dict[str, Any]],
    ban_by_code: dict[str, str],
    ban_by_company: dict[str, str],
) -> None:
    """整合 2,201 筆清單與細部資料寫入 data/cfp_products.json，並同步更新 data/metadata.json。"""
    merged_list: list[dict[str, Any]] = []
    seen: set[str] = set()

    for item in all_items:
        code = item["cfpl_code"]
        seen.add(code)
        d = details.get(code) or {}
        ex = existing_by_code.get(code) or {}
        company_name = d.get("公司／團體名稱") or item.get("company_name") or ex.get("company_name") or ""
        ban = d.get("統一編號") or ex.get("ban") or ban_by_code.get(code, "") or ban_by_company.get(company_name, "")
        footprint_raw = d.get("碳足跡數據") or item.get("footprint_data") or ex.get("footprint_raw") or ""
        declared_unit = d.get("宣告單位") or ex.get("declared_unit") or ""
        if not declared_unit and "/" in footprint_raw:
            declared_unit = footprint_raw.split("/", 1)[1].strip()
        footprint_kg = ex.get("footprint_kg")
        if footprint_kg is None:
            footprint_kg = parse_footprint_kg(footprint_raw)

        merged_list.append(
            {
                "id": ex.get("id") or make_product_id(code),
                "product_name": d.get("產品名稱") or item.get("product_name") or ex.get("product_name") or "",
                "product_model": d.get("產品型號") or item.get("product_model") or "",
                "product_type": d.get("產品類型") or "",
                "label_type": d.get("標籤類別") or item.get("label_type") or ("減碳標籤" if code.upper().startswith("R") else "碳標籤"),
                "cfpl_code": code,
                "company_name": company_name,
                "ban": ban,
                "footprint_raw": footprint_raw,
                "footprint_kg": footprint_kg,
                "declared_unit": declared_unit,
                "unit_carbon": d.get("單位碳排") or item.get("unit_carbon") or "",
                "pcr_no": d.get("PCR文件編號") or item.get("pcr_no") or "",
                "pcr_name": d.get("PCR文件名稱") or item.get("pcr_name") or "",
                "green_procurement": d.get("綠色採購") or item.get("green_procurement") or "",
                "effective_date": d.get("生效日期") or "",
                "expired_date": d.get("有效期限") or ex.get("expired_date") or "",
                "status": d.get("狀態") or "",
                "info_url": d.get("產品碳足跡相關資訊網址") or "",
            }
        )

    save_json(PRODUCTS_PATH, merged_list)

    metadata = load_json(METADATA_PATH, {})
    if isinstance(metadata, dict):
        metadata.setdefault("datasets", {}).setdefault("CFP_P_01", {})
        metadata["datasets"]["CFP_P_01"]["total_count"] = len(merged_list)
        metadata["datasets"]["CFP_P_01"]["details_count"] = len(details)
        metadata["last_checked_at"] = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
        save_json(METADATA_PATH, metadata)


async def run_async(args: argparse.Namespace) -> int:
    existing_by_code, ban_by_code, ban_by_company = build_existing_lookups()
    details: dict[str, dict[str, str]] = load_json(PRODUCT_DETAILS_PATH, {})
    if not isinstance(details, dict):
        details = {}

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=args.headless)
        context = await browser.new_context(locale="zh-TW")
        list_page = await context.new_page()

        all_items = await collect_all_products_list(list_page)
        await list_page.close()

        # 先同步 2,201 筆基本清單與 metadata
        sync_products_and_metadata(all_items, details, existing_by_code, ban_by_code, ban_by_company)

        pending = [item for item in all_items if args.refresh or item["cfpl_code"] not in details]
        if args.limit > 0:
            pending = pending[: args.limit]

        print(
            f"CFP_P_01 全量清單共 {len(all_items)} 筆，"
            f"已完成細部資料 {len(details)} 筆，"
            f"本次待抓取 {len(pending)} 筆（並發數：{args.workers}）。"
        )
        if not pending:
            await browser.close()
            return 0

        queue: asyncio.Queue[tuple[int, dict[str, str]]] = asyncio.Queue()
        for idx, item in enumerate(pending, start=1):
            queue.put_nowait((idx, item))

        lock = asyncio.Lock()
        stats = {"done": 0, "success": 0, "failed": 0}

        async def worker(worker_id: int) -> None:
            page = await context.new_page()
            try:
                while not queue.empty():
                    try:
                        idx, item = queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break

                    code = item["cfpl_code"]
                    name = item["product_name"]
                    parsed = None
                    last_err = None
                    for attempt in range(3):
                        try:
                            parsed = await scrape_one_product(page, item, ban_by_code, ban_by_company)
                            if parsed:
                                break
                        except Exception as exc:
                            last_err = exc
                            await asyncio.sleep(1.0)

                    async with lock:
                        stats["done"] += 1
                        if parsed:
                            details[code] = parsed
                            stats["success"] += 1
                            print(f"[{stats['done']}/{len(pending)}][W{worker_id}] 成功：{code} {name}（{parsed.get('狀態', '')}）")
                        else:
                            stats["failed"] += 1
                            print(f"[{stats['done']}/{len(pending)}][W{worker_id}] 失敗略過：{code} {name} -> {last_err}")

                        if stats["done"] % 20 == 0:
                            save_json(PRODUCT_DETAILS_PATH, details)

                    await asyncio.sleep(args.delay)
            finally:
                await page.close()

        workers = [asyncio.create_task(worker(i + 1)) for i in range(max(1, args.workers))]
        await asyncio.gather(*workers)

        save_json(PRODUCT_DETAILS_PATH, details)
        sync_products_and_metadata(all_items, details, existing_by_code, ban_by_code, ban_by_company)
        await browser.close()

    print(
        f"完成！本次新增/更新 {stats['success']} 筆，失敗 {stats['failed']} 筆，"
        f"累計 {len(details)} / {len(all_items)} 筆已存至 {PRODUCT_DETAILS_PATH}。"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="本機抓取環境部 CFP_P_01 全量（約 2,201 筆）碳標籤產品與細部資料")
    parser.add_argument("--limit", type=int, default=0, help="限制本次最多抓取筆數（0 表示全部）")
    parser.add_argument("--workers", type=int, default=4, help="並發瀏覽器分頁數（預設 4）")
    parser.add_argument("--delay", type=float, default=0.3, help="每筆間隔秒數")
    parser.add_argument("--headless", action="store_true", help="使用無頭模式執行")
    parser.add_argument("--refresh", action="store_true", help="重新抓取已存在的項目")
    args = parser.parse_args()
    return asyncio.run(run_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
