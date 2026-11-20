#!/usr/bin/env python3
"""
本機專用：從「環境部產品碳足跡資訊網」遍歷官方階層目錄（四大類別 → 大類別 → 子類別）
抓取 CFP_P_02 全量 1,188 筆細部資料表格與階層分類，存為 data/cfp_details.json、
同步分類至 data/cfp_factors.json，並輸出異常／缺漏報告至 data/scrape_report.json。

使用方式：
  python scripts/scrape_details_local.py --limit 10 --headless
  python scripts/scrape_details_local.py --workers 4 --headless
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeoutError

TARGET_URL = "https://cfp.moenv.gov.tw/WebPage/WebSites/CoefficientDB.aspx"
ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
FACTORS_PATH = DATA_DIR / "cfp_factors.json"
DETAILS_PATH = DATA_DIR / "cfp_details.json"
METADATA_PATH = DATA_DIR / "metadata.json"
REPORT_PATH = DATA_DIR / "scrape_report.json"

MAJOR_BY_CATEGORY: dict[str, str] = {
    "能資源": "能源類",
    "塑膠原料": "材料類",
    "塑膠製品": "材料類",
    "橡膠原料": "材料類",
    "橡膠製品": "材料類",
    "金屬": "材料類",
    "化學品或氣體等": "材料類",
    "紙": "材料類",
    "纖維": "材料類",
    "玻璃": "材料類",
    "建材": "材料類",
    "化學肥料 ＆ 農藥": "材料類",
    "化學肥料 & 農藥": "材料類",
    "染顏料": "材料類",
    "塗料": "材料類",
    "電機＆電子": "材料類",
    "電機&電子": "材料類",
    "穀豆類及其加工品": "食品類",
    "蔬果類及其加工品": "食品類",
    "肉品及其加工品": "食品類",
    "水產品及其加工品": "食品類",
    "蛋品及其加工品": "食品類",
    "醬油及調味品": "食品類",
    "食用油脂": "食品類",
    "乳品及其加工品": "食品類",
    "飲品": "食品類",
    "運輸服務": "服務類",
    "廢棄物回收處理服務": "服務類",
    "廢棄物處理服務": "服務類",
    "廢水處理服務": "服務類",
    "民生相關": "其他",
    "其他": "其他",
}

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
    "全球暖化潛勢值",
    "類別",
]


def normalize_key(text: str) -> str:
    return unicodedata.normalize("NFKC", str(text or "")).replace("\u3000", " ").strip()


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


async def parse_detail_table(page) -> dict[str, str]:
    """從環境部細部資料頁的 OchiTrasTable（或 table）擷取所有「揭露項目：內容」。"""
    raw_pairs: list[tuple[str, str]] = await page.evaluate(
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

    # 若備註含全球暖化潛勢值引用來源且無獨立欄位，一併擷取標準化欄位
    if not any("全球暖化潛勢值" in k for k in detail):
        remarks = detail.get("備註", "")
        if m := re.search(r"全球暖化潛勢值引用來源[為：:\s]*([^\n。]+)", remarks):
            detail["全球暖化潛勢值引用來源"] = m.group(1).strip()

    return detail


async def extract_tree_leaves(page) -> list[dict[str, str]]:
    """從 CoefficientDB.aspx 擷取所有有效的 Level3 葉節點（大類別 / 中類別 / 子類別 / postback）。"""
    await page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=45000)
    await page.wait_for_selector("#ContentPlaceHolder1_CoefficientData_Tab_pan_Category", timeout=25000)

    leaves: list[dict[str, str]] = await page.evaluate(
        """() => {
            const pan = document.querySelector('#ContentPlaceHolder1_CoefficientData_Tab_pan_Category');
            if (!pan) return [];
            const results = [];
            const headers = pan.querySelectorAll('a.list-group-item[data-bs-toggle="collapse"]');
            for (const header of headers) {
                const catEl = header.querySelector('.fs-5');
                const category = catEl ? catEl.innerText.replace(/\\s+/g, ' ').trim() : (header.getAttribute('title') || '').trim();
                const targetSel = header.getAttribute('href') || '';
                const panel = targetSel.startsWith('#') ? pan.querySelector(targetSel) : header.nextElementSibling;
                if (!panel) continue;
                const cards = panel.querySelectorAll('.card');
                for (const card of cards) {
                    const midEl = card.querySelector('.card-header');
                    const mid = midEl ? midEl.innerText.replace(/\\s+/g, ' ').trim() : '';
                    const links = card.querySelectorAll('a[id*="_lbtn_cc_name_"]');
                    for (const a of links) {
                        if (a.classList.contains('aspNetDisabled')) continue;
                        const href = a.getAttribute('href') || '';
                        if (!href.includes('__doPostBack')) continue;
                        const leaf = (a.innerText || '').replace(/\\s+/g, ' ').trim();
                        const subCategory = mid && leaf && mid !== leaf ? `${mid} / ${leaf}` : (leaf || mid);
                        results.push({
                            category,
                            mid_category: mid,
                            leaf_category: leaf,
                            sub_category: subCategory,
                            postback: href.replace(/^javascript:/i, ''),
                        });
                    }
                }
            }
            return results;
        }"""
    )

    for item in leaves:
        cat = item["category"]
        item["major_category"] = MAJOR_BY_CATEGORY.get(cat, MAJOR_BY_CATEGORY.get(normalize_key(cat), "其他"))
    return leaves


async def scrape_leaf_factors(
    page,
    leaf: dict[str, str],
    details: dict[str, dict[str, str]],
    norm_to_canonical: dict[str, str],
    lock: asyncio.Lock,
    stats: dict[str, int],
    args: argparse.Namespace,
    worker_id: int,
) -> None:
    """打開單一葉節點分類，擷取其下所有係數明細與階層分類。"""
    await page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=45000)
    await page.wait_for_selector("#ContentPlaceHolder1_CoefficientData_Tab_pan_Category", timeout=25000)
    await page.evaluate(leaf["postback"])
    await page.wait_for_selector("a[id*='_lbtn_cd_name_']", timeout=25000)

    factor_links: list[dict[str, str]] = await page.evaluate(
        """() => {
            return Array.from(document.querySelectorAll('a[id*="_lbtn_cd_name_"]')).map((a) => ({
                name: (a.innerText || '').trim(),
                postback: (a.getAttribute('href') || '').replace(/^javascript:/i, ''),
            }));
        }"""
    )

    for idx, fl in enumerate(factor_links):
        if args.limit > 0 and stats["scraped"] >= args.limit:
            return

        raw_name = fl["name"]
        norm_name = normalize_key(raw_name)
        canonical_name = norm_to_canonical.get(norm_name, raw_name)

        async with lock:
            existing = details.get(canonical_name)
            already_complete = (
                existing is not None
                and not args.refresh
                and bool(existing.get("中文名稱"))
                and bool(existing.get("major_category"))
                and bool(existing.get("category"))
                and bool(existing.get("sub_category"))
            )
            if already_complete:
                continue
            # 若已有明細但僅缺分類，直接補上分類即可（省下點進明細頁的時間）
            if existing is not None and not args.refresh and bool(existing.get("中文名稱")):
                existing["major_category"] = leaf["major_category"]
                existing["category"] = leaf["category"]
                existing["sub_category"] = leaf["sub_category"]
                stats["cat_patched"] += 1
                continue

        parsed = None
        for _attempt in range(3):
            try:
                # 確保在該葉節點列表頁上
                if await page.locator("a[id*='_lbtn_cd_name_']").count() == 0:
                    await page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=45000)
                    await page.wait_for_selector("#ContentPlaceHolder1_CoefficientData_Tab_pan_Category", timeout=25000)
                    await page.evaluate(leaf["postback"])
                    await page.wait_for_selector("a[id*='_lbtn_cd_name_']", timeout=25000)

                await page.evaluate(fl["postback"])
                await page.wait_for_selector(".OchiTrasTable", timeout=25000)
                parsed = await parse_detail_table(page)
                if parsed:
                    break
            except Exception:
                await asyncio.sleep(0.8)
                try:
                    await page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=45000)
                    await page.wait_for_selector("#ContentPlaceHolder1_CoefficientData_Tab_pan_Category", timeout=25000)
                    await page.evaluate(leaf["postback"])
                    await page.wait_for_selector("a[id*='_lbtn_cd_name_']", timeout=25000)
                except Exception:
                    pass

        if parsed:
            parsed["major_category"] = leaf["major_category"]
            parsed["category"] = leaf["category"]
            parsed["sub_category"] = leaf["sub_category"]
            async with lock:
                details[canonical_name] = parsed
                stats["scraped"] += 1
                print(
                    f"[+][W{worker_id}] {canonical_name} "
                    f"({leaf['major_category']} > {leaf['category']} > {leaf['sub_category']}) "
                    f"[累計 {len(details)}]"
                )
                if stats["scraped"] % 10 == 0:
                    save_json(DETAILS_PATH, details)

        # 點擊「回上一頁」或重新進葉節點以繼續下一筆
        if idx + 1 < len(factor_links):
            back_btn = page.locator("#ContentPlaceHolder1_CoefficientData_Tab_btnBack")
            if await back_btn.count() > 0:
                try:
                    await back_btn.click()
                    await page.wait_for_selector("a[id*='_lbtn_cd_name_']", timeout=15000)
                except Exception:
                    pass
            await asyncio.sleep(args.delay)


async def scrape_fallback_by_keyword(page, factor_name: str) -> dict[str, str] | None:
    """針對樹狀目錄未命中的極少數項目，改以關鍵字查詢補抓明細。"""
    await page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=45000)
    search_input = page.locator("#ContentPlaceHolder1_CoefficientData_Tab_txt_keyword")
    await search_input.wait_for(state="visible", timeout=20000)
    await search_input.fill("")
    await search_input.fill(factor_name)
    await page.click("#ContentPlaceHolder1_CoefficientData_Tab_btnSearch")

    links = page.locator("a[id*='_lbtn_cd_name_']")
    await links.first.wait_for(timeout=20000)

    count = await links.count()
    norm_target = normalize_key(factor_name)
    target_link = None
    for i in range(count):
        txt = (await links.nth(i).inner_text() or "").strip()
        if txt == factor_name or normalize_key(txt) == norm_target:
            target_link = links.nth(i)
            break
    if target_link is None:
        return None

    await target_link.click()
    await page.wait_for_selector(".OchiTrasTable", timeout=25000)
    return await parse_detail_table(page)


def sync_factors_and_report(factors: list[dict[str, Any]], details: dict[str, dict[str, str]]) -> dict[str, Any]:
    """將階層分類回填至 data/cfp_factors.json，更新 metadata.json，並產出 data/scrape_report.json。"""
    norm_details = {normalize_key(k): v for k, v in details.items()}
    matched_details = 0
    matched_cats = 0
    missing_items: list[dict[str, str]] = []

    for item in factors:
        name = item["name"]
        d = details.get(name) or norm_details.get(normalize_key(name))
        if d:
            matched_details += 1
            if d.get("major_category"):
                item["major_category"] = d["major_category"]
                item["category"] = d.get("category", "")
                item["sub_category"] = d.get("sub_category", "")
                matched_cats += 1
        else:
            missing_items.append({"id": item.get("id", ""), "name": name, "year": item.get("announcement_year", "")})

    save_json(FACTORS_PATH, factors)

    metadata = load_json(METADATA_PATH, {})
    if isinstance(metadata, dict):
        metadata.setdefault("datasets", {}).setdefault("CFP_P_02", {})
        metadata["datasets"]["CFP_P_02"]["total_count"] = len(factors)
        metadata["datasets"]["CFP_P_02"]["details_count"] = matched_details
        metadata["last_checked_at"] = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
        save_json(METADATA_PATH, metadata)

    report = {
        "generated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "cfp_p_02_total": len(factors),
        "cfp_p_02_details_matched": matched_details,
        "cfp_p_02_categories_matched": matched_cats,
        "cfp_p_02_missing_count": len(missing_items),
        "cfp_p_02_missing_items": missing_items,
    }
    save_json(REPORT_PATH, report)
    return report


async def run_async(args: argparse.Namespace) -> int:
    if not FACTORS_PATH.exists():
        print(f"找不到 {FACTORS_PATH}，請先執行 sync_cfp.py。")
        return 1

    factors: list[dict[str, Any]] = load_json(FACTORS_PATH, [])
    details: dict[str, dict[str, str]] = load_json(DETAILS_PATH, {})
    if not isinstance(details, dict):
        details = {}

    norm_to_canonical = {normalize_key(f["name"]): f["name"] for f in factors}

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=args.headless)
        context = await browser.new_context(locale="zh-TW")

        tree_page = await context.new_page()
        leaves = await extract_tree_leaves(tree_page)
        await tree_page.close()
        print(f"CFP_P_02 共 {len(factors)} 筆，官網分類樹共 {len(leaves)} 個有效葉節點，既有明細 {len(details)} 筆。")

        queue: asyncio.Queue[dict[str, str]] = asyncio.Queue()
        for leaf in leaves:
            queue.put_nowait(leaf)

        lock = asyncio.Lock()
        stats = {"scraped": 0, "cat_patched": 0, "leaves_done": 0}

        async def worker(worker_id: int) -> None:
            page = await context.new_page()
            try:
                while not queue.empty():
                    if args.limit > 0 and stats["scraped"] >= args.limit:
                        break
                    try:
                        leaf = queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    try:
                        await scrape_leaf_factors(page, leaf, details, norm_to_canonical, lock, stats, args, worker_id)
                    except Exception as exc:
                        print(f"[!][W{worker_id}] 葉節點失敗 {leaf['category']} > {leaf['sub_category']}: {exc}")
                    async with lock:
                        stats["leaves_done"] += 1
            finally:
                await page.close()

        workers = [asyncio.create_task(worker(i + 1)) for i in range(max(1, args.workers))]
        await asyncio.gather(*workers)
        save_json(DETAILS_PATH, details)

        # Fallback: 針對分類樹未涵蓋到的剩餘項目以關鍵字補抓
        if args.limit == 0:
            norm_details = {normalize_key(k) for k in details}
            still_missing = [f["name"] for f in factors if normalize_key(f["name"]) not in norm_details]
            if still_missing:
                print(f"分類樹掃描完成，尚有 {len(still_missing)} 筆未命中，啟動關鍵字補抓...")
                fb_page = await context.new_page()
                for idx, name in enumerate(still_missing, start=1):
                    parsed = None
                    for _ in range(2):
                        try:
                            parsed = await scrape_fallback_by_keyword(fb_page, name)
                            if parsed:
                                break
                        except Exception:
                            await asyncio.sleep(0.8)
                    if parsed:
                        details[name] = parsed
                        stats["scraped"] += 1
                        print(f"[補抓 {idx}/{len(still_missing)}] 成功：{name}")
                        if idx % 10 == 0:
                            save_json(DETAILS_PATH, details)
                    else:
                        print(f"[補抓 {idx}/{len(still_missing)}] 官網查無：{name}")
                await fb_page.close()
                save_json(DETAILS_PATH, details)

        await browser.close()

    report = sync_factors_and_report(factors, details)
    print(
        f"完成！本次新增明細 {stats['scraped']} 筆、補填分類 {stats['cat_patched']} 筆；"
        f"CFP_P_02 明細涵蓋 {report['cfp_p_02_details_matched']} / {report['cfp_p_02_total']} 筆"
        f"（含階層分類 {report['cfp_p_02_categories_matched']} 筆，缺漏 {report['cfp_p_02_missing_count']} 筆）。"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="本機遍歷官網階層分類抓取 CFP_P_02 全量細部資料")
    parser.add_argument("--limit", type=int, default=0, help="限制本次最多新抓筆數（0 表示全部）")
    parser.add_argument("--workers", type=int, default=4, help="並發瀏覽器分頁數（預設 4）")
    parser.add_argument("--delay", type=float, default=0.25, help="每筆間隔秒數")
    parser.add_argument("--headless", action="store_true", help="使用無頭模式執行")
    parser.add_argument("--refresh", action="store_true", help="重新抓取已存在的項目")
    args = parser.parse_args()
    return asyncio.run(run_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
