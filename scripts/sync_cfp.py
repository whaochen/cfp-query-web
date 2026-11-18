#!/usr/bin/env python3
"""
環境部「碳足跡排放係數 (CFP_P_02)」與「台灣產品碳足跡資訊 (CFP_P_01)」
開放資料自動同步與異動偵測腳本
資料來源：
- CFP_P_02: https://data.moenv.gov.tw/dataset/detail/CFP_P_02
- CFP_P_01: https://data.moenv.gov.tw/dataset/detail/CFP_P_01
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

API_BASE = "https://data.moenv.gov.tw/api/v2"
PAGE_LIMIT = 1000
TZ_TAIPEI = timezone(timedelta(hours=8))

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
FACTORS_PATH = DATA_DIR / "cfp_factors.json"
PRODUCTS_PATH = DATA_DIR / "cfp_products.json"
METADATA_PATH = DATA_DIR / "metadata.json"
CHANGELOG_PATH = DATA_DIR / "changelog.json"


def get_field(record: dict[str, Any], *candidates: str) -> str:
    """相容環境部 API 不同大小寫欄位名稱。"""
    for key in candidates:
        if key in record and record[key] is not None:
            return str(record[key]).strip()
    lower_map = {k.lower(): v for k, v in record.items()}
    for key in candidates:
        lk = key.lower()
        if lk in lower_map and lower_map[lk] is not None:
            return str(lower_map[lk]).strip()
    return ""


def parse_float(value: str) -> float | None:
    if not value:
        return None
    try:
        return float(value.replace(",", ""))
    except ValueError:
        return None


def parse_footprint_to_kg(value: str) -> float | None:
    """將 CFP_P_01 的碳足跡字串（如 '26.00kg'、'900.00g'）換算為 kg。"""
    if not value:
        return None
    match = re.match(r"^\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(kg|g|公克|公斤)?\s*$", value, re.IGNORECASE)
    if not match:
        return None
    num = parse_float(match.group(1))
    if num is None:
        return None
    unit = (match.group(2) or "").lower()
    if unit in ("g", "公克"):
        return round(num / 1000.0, 6)
    if unit in ("kg", "公斤", ""):
        return num
    return None


def make_id(*parts: str) -> str:
    raw = "|".join(parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def normalize_factor(raw: dict[str, Any]) -> dict[str, Any]:
    """正規化 CFP_P_02（碳足跡排放係數）。"""
    name = get_field(raw, "name", "Name")
    coe_str = get_field(raw, "coe", "Coe")
    unit = get_field(raw, "unit", "Unit")
    department = get_field(raw, "departmentname", "DepartmentName")
    year = get_field(raw, "announcementyear", "AnnouncementYear")
    # 環境部資料集欄位原拼字為 Scpoe3_iso / Scpoe3_ghg，此處同時相容正確拼字
    scope3_iso = get_field(raw, "scpoe3_iso", "Scpoe3_iso", "scope3_iso", "Scope3_iso")
    scope3_ghg = get_field(raw, "scpoe3_ghg", "Scpoe3_ghg", "scope3_ghg", "Scope3_ghg")

    return {
        "id": make_id(name, unit, department, year),
        "name": name,
        "coe": coe_str,
        "coe_num": parse_float(coe_str),
        "unit": unit,
        "department": department,
        "announcement_year": year,
        "scope3_iso": scope3_iso,
        "scope3_ghg": scope3_ghg,
    }


def normalize_product(raw: dict[str, Any]) -> dict[str, Any]:
    """正規化 CFP_P_01（台灣產品碳足跡資訊）。"""
    product_name = get_field(raw, "product_name", "Product_Name")
    cfpl_code = get_field(raw, "cfpl_code", "CFPL_Code")
    company_name = get_field(raw, "company_name", "Company_Name")
    ban = get_field(raw, "ban", "Ban")
    footprint_raw = get_field(raw, "product_carbon_footprint_data", "Product_Carbon_Footprint_Data")
    declared_unit = get_field(raw, "declared_unit", "Declared_Unit")
    expired_date = get_field(raw, "expireddate", "ExpiredDate")

    return {
        "id": make_id(cfpl_code, product_name, company_name),
        "product_name": product_name,
        "cfpl_code": cfpl_code,
        "company_name": company_name,
        "ban": ban,
        "footprint_raw": footprint_raw,
        "footprint_kg": parse_footprint_to_kg(footprint_raw),
        "declared_unit": declared_unit,
        "expired_date": expired_date,
    }


def fetch_all_records(dataset_id: str, api_key: str) -> list[dict[str, Any]]:
    all_records: list[dict[str, Any]] = []
    offset = 0
    endpoint = f"{API_BASE}/{dataset_id}"

    while True:
        params = urllib.parse.urlencode(
            {
                "api_key": api_key,
                "limit": PAGE_LIMIT,
                "offset": offset,
                "sort": "ImportDate desc",
                "format": "json",
            }
        )
        url = f"{endpoint}?{params}"
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "MOENV-CFP-Sync/2.0", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"[{dataset_id}] API HTTP {exc.code}: {body[:300]}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"[{dataset_id}] API 連線失敗: {exc.reason}") from exc

        records = payload.get("records") if isinstance(payload, dict) else payload
        if not isinstance(records, list):
            raise RuntimeError(f"[{dataset_id}] API 回傳格式非預期（找不到 records 陣列）")

        if not records:
            break

        all_records.extend(records)
        if len(records) < PAGE_LIMIT:
            break
        offset += PAGE_LIMIT

    return all_records


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def compute_diff(
    old_items: list[dict[str, Any]],
    new_items: list[dict[str, Any]],
    label_key: str,
) -> dict[str, Any]:
    old_map = {item["id"]: item for item in old_items}
    new_map = {item["id"]: item for item in new_items}

    added_ids = sorted(set(new_map) - set(old_map))
    removed_ids = sorted(set(old_map) - set(new_map))
    common_ids = sorted(set(old_map) & set(new_map))

    updated = []
    for rid in common_ids:
        if old_map[rid] != new_map[rid]:
            updated.append(
                {
                    "id": rid,
                    "label": new_map[rid][label_key],
                    "before": old_map[rid],
                    "after": new_map[rid],
                }
            )

    return {
        "added_count": len(added_ids),
        "updated_count": len(updated),
        "removed_count": len(removed_ids),
        "added_labels": [new_map[rid][label_key] for rid in added_ids[:50]],
        "updated_labels": [item["label"] for item in updated[:50]],
        "removed_labels": [old_map[rid][label_key] for rid in removed_ids[:50]],
    }


def sync_dataset(
    dataset_id: str,
    api_key: str,
    output_path: Path,
    normalizer: Callable[[dict[str, Any]], dict[str, Any]],
    sort_key: Callable[[dict[str, Any]], Any],
    label_key: str,
) -> tuple[bool, int, dict[str, Any], str]:
    raw_records = fetch_all_records(dataset_id, api_key)
    normalized = [normalizer(r) for r in raw_records]
    normalized.sort(key=sort_key)

    data_hash = hashlib.sha256(
        json.dumps(normalized, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()

    old_items = load_json(output_path, [])
    if old_items == normalized:
        return False, len(normalized), {
            "added_count": 0,
            "updated_count": 0,
            "removed_count": 0,
            "added_labels": [],
            "updated_labels": [],
            "removed_labels": [],
        }, data_hash

    diff = compute_diff(old_items, normalized, label_key)
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(normalized, f, ensure_ascii=False, indent=2)
        f.write("\n")

    return True, len(normalized), diff, data_hash


def main() -> int:
    api_key = os.environ.get("MOENV_API_KEY", "").strip()
    if not api_key:
        print("錯誤：請設定環境變數 MOENV_API_KEY", file=sys.stderr)
        return 1

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    now_iso = datetime.now(TZ_TAIPEI).isoformat(timespec="seconds")

    f_changed, f_count, f_diff, f_hash = sync_dataset(
        dataset_id="CFP_P_02",
        api_key=api_key,
        output_path=FACTORS_PATH,
        normalizer=normalize_factor,
        sort_key=lambda x: (
            -(int(x["announcement_year"]) if x["announcement_year"].isdigit() else 0),
            x["name"],
            x["unit"],
            x["department"],
        ),
        label_key="name",
    )

    p_changed, p_count, p_diff, p_hash = sync_dataset(
        dataset_id="CFP_P_01",
        api_key=api_key,
        output_path=PRODUCTS_PATH,
        normalizer=normalize_product,
        sort_key=lambda x: (
            x["expired_date"],
            x["cfpl_code"],
            x["product_name"],
        ),
        label_key="product_name",
    )

    if not f_changed and not p_changed:
        print(f"資料無異動（CFP_P_02: {f_count} 筆；CFP_P_01: {p_count} 筆）。")
        return 0

    existing_meta = load_json(METADATA_PATH, {})
    metadata = {
        "last_checked_at": now_iso,
        "datasets": {
            "CFP_P_02": {
                "title": "碳足跡排放係數",
                "source_url": "https://data.moenv.gov.tw/dataset/detail/CFP_P_02",
                "file": "cfp_factors.json",
                "total_count": f_count,
                "last_synced_at": now_iso if f_changed else existing_meta.get("datasets", {}).get("CFP_P_02", {}).get("last_synced_at", now_iso),
                "sha256": f_hash,
            },
            "CFP_P_01": {
                "title": "台灣產品碳足跡資訊",
                "source_url": "https://data.moenv.gov.tw/dataset/detail/CFP_P_01",
                "file": "cfp_products.json",
                "total_count": p_count,
                "last_synced_at": now_iso if p_changed else existing_meta.get("datasets", {}).get("CFP_P_01", {}).get("last_synced_at", now_iso),
                "sha256": p_hash,
            },
        },
    }
    with METADATA_PATH.open("w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)
        f.write("\n")

    changelog = load_json(CHANGELOG_PATH, [])
    changelog.insert(
        0,
        {
            "synced_at": now_iso,
            "CFP_P_02": {
                "changed": f_changed,
                "total_count": f_count,
                **f_diff,
            },
            "CFP_P_01": {
                "changed": p_changed,
                "total_count": p_count,
                **p_diff,
            },
        },
    )
    changelog = changelog[:30]
    with CHANGELOG_PATH.open("w", encoding="utf-8") as f:
        json.dump(changelog, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(
        f"同步完成 — CFP_P_02: {f_count} 筆 (+{f_diff['added_count']}/~{f_diff['updated_count']}/-{f_diff['removed_count']})；"
        f"CFP_P_01: {p_count} 筆 (+{p_diff['added_count']}/~{p_diff['updated_count']}/-{p_diff['removed_count']})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())