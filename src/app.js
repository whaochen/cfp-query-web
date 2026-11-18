const state = {
  activeTab: "factors",
  metadata: null,
  changelog: null,
  factors: [],
  products: [],
  factorsFuse: null,
  productsFuse: null,
  factorsFilter: {
    query: "",
    year: "",
    unit: "",
    iso: "",
    ghg: "",
    page: 1,
    pageSize: 20,
  },
  productsFilter: {
    query: "",
    validity: "",
    sort: "default",
    page: 1,
    pageSize: 20,
  },
  toastTimer: null,
};

const els = {
  statFactorsCount: document.getElementById("stat-factors-count"),
  statProductsCount: document.getElementById("stat-products-count"),
  statLastSync: document.getElementById("stat-last-sync"),

  tabBtnFactors: document.getElementById("tab-btn-factors"),
  tabBtnProducts: document.getElementById("tab-btn-products"),
  panelFactors: document.getElementById("panel-factors"),
  panelProducts: document.getElementById("panel-products"),

  calcSelectedName: document.getElementById("calc-selected-name"),
  calcQuantity: document.getElementById("calc-quantity"),
  calcUnitLabel: document.getElementById("calc-unit-label"),
  calcCoe: document.getElementById("calc-coe"),
  calcResultKg: document.getElementById("calc-result-kg"),
  calcResultTon: document.getElementById("calc-result-ton"),
  btnCalcReset: document.getElementById("btn-calc-reset"),

  factorsSearch: document.getElementById("factors-search"),
  filterYear: document.getElementById("filter-year"),
  filterUnit: document.getElementById("filter-unit"),
  filterIso: document.getElementById("filter-iso"),
  filterGhg: document.getElementById("filter-ghg"),
  factorsResetFilters: document.getElementById("factors-reset-filters"),
  factorsSummary: document.getElementById("factors-summary"),
  factorsPageSize: document.getElementById("factors-page-size"),
  factorsResults: document.getElementById("factors-results"),
  factorsPagination: document.getElementById("factors-pagination"),

  productsSearch: document.getElementById("products-search"),
  filterValidity: document.getElementById("filter-validity"),
  sortExpired: document.getElementById("sort-expired"),
  productsResetFilters: document.getElementById("products-reset-filters"),
  productsSummary: document.getElementById("products-summary"),
  productsPageSize: document.getElementById("products-page-size"),
  productsResults: document.getElementById("products-results"),
  productsPagination: document.getElementById("products-pagination"),

  btnOpenChangelog: document.getElementById("btn-open-changelog"),
  btnCloseChangelog: document.getElementById("btn-close-changelog"),
  changelogModal: document.getElementById("changelog-modal"),
  changelogBody: document.getElementById("changelog-body"),

  toast: document.getElementById("toast"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateTime(isoString) {
  if (!isoString) return "--";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  return date.toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatNumber(num, maxDecimals = 6) {
  if (num === null || num === undefined || Number.isNaN(num)) return "--";
  const rounded = Number(num.toPrecision(10));
  return rounded.toLocaleString("zh-TW", { maximumFractionDigits: maxDecimals });
}

function parseScopeTokens(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(/[、,，]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((token) => (token.startsWith("類別") ? token : `類別${token}`));
}

function compareScopeToken(a, b) {
  const numA = parseFloat(a.replace(/^類別/, ""));
  const numB = parseFloat(b.replace(/^類別/, ""));
  if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
    return numA - numB;
  }
  return a.localeCompare(b, "zh-Hant");
}

function parseExpiredDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const match = dateStr.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getValidityStatus(expiredDateObj, todayStart) {
  if (!expiredDateObj) {
    return { key: "unknown", label: "日期未明", badgeClass: "" };
  }
  const diffDays = Math.floor((expiredDateObj.getTime() - todayStart.getTime()) / 86400000);
  if (diffDays < 0) {
    return { key: "expired", label: "已到期", badgeClass: "badge-expired" };
  }
  if (diffDays <= 30) {
    return { key: "expiring", label: `即將到期 (${diffDays}天)`, badgeClass: "badge-expiring" };
  }
  return { key: "valid", label: "有效期間內", badgeClass: "badge-valid" };
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
  }
  state.toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2400);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    showToast(`已複製數值：${text}`);
  } catch {
    showToast("複製失敗，請手動選取數值");
  }
}

function switchTab(tabName) {
  state.activeTab = tabName;
  const isFactors = tabName === "factors";

  els.tabBtnFactors.classList.toggle("active", isFactors);
  els.tabBtnFactors.setAttribute("aria-selected", String(isFactors));
  els.panelFactors.hidden = !isFactors;

  els.tabBtnProducts.classList.toggle("active", !isFactors);
  els.tabBtnProducts.setAttribute("aria-selected", String(!isFactors));
  els.panelProducts.hidden = isFactors;
}

function updateCalculator() {
  const qty = parseFloat(els.calcQuantity.value);
  const coe = parseFloat(els.calcCoe.value);
  if (Number.isNaN(qty) || Number.isNaN(coe) || qty < 0 || coe < 0) {
    els.calcResultKg.textContent = "0";
    els.calcResultTon.textContent = "0";
    return;
  }
  const kg = qty * coe;
  const ton = kg / 1000;
  els.calcResultKg.textContent = formatNumber(kg, 6);
  els.calcResultTon.textContent = formatNumber(ton, 8);
}

function loadFactorIntoCalculator(factor) {
  const coeVal = factor.coe_num !== null && factor.coe_num !== undefined ? factor.coe_num : factor.coe;
  els.calcSelectedName.textContent = factor.name || "未命名係數";
  els.calcUnitLabel.textContent = factor.unit || "單位";
  els.calcCoe.value = coeVal ?? "";
  if (!els.calcQuantity.value || Number(els.calcQuantity.value) <= 0) {
    els.calcQuantity.value = "1";
  }
  updateCalculator();
  els.calcQuantity.focus();
  els.calcQuantity.select();
  document.querySelector(".calculator-card")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  showToast(`已帶入「${factor.name}」至試算器`);
}

function populateFactorFilterOptions() {
  const years = new Set();
  const units = new Set();
  const isos = new Set();
  const ghgs = new Set();

  for (const item of state.factors) {
    if (item.announcement_year) years.add(item.announcement_year);
    if (item.unit) units.add(item.unit);
    for (const token of item._isoTokens) isos.add(token);
    for (const token of item._ghgTokens) ghgs.add(token);
  }

  const fillSelect = (selectEl, items, sortFn) => {
    const sorted = Array.from(items).sort(sortFn);
    const fragment = document.createDocumentFragment();
    for (const value of sorted) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      fragment.appendChild(option);
    }
    selectEl.appendChild(fragment);
  };

  fillSelect(els.filterYear, years, (a, b) => b.localeCompare(a));
  fillSelect(els.filterUnit, units, (a, b) => a.localeCompare(b, "zh-Hant"));
  fillSelect(els.filterIso, isos, compareScopeToken);
  fillSelect(els.filterGhg, ghgs, compareScopeToken);
}

function normalizeSearchText(str) {
  return String(str ?? "")
    .normalize("NFKC")
    .replace(/\u3000/g, " ")
    .toLowerCase();
}

function fuzzyMultiKeywordSearch(fuseInstance, allItems, query) {
  const tokens = normalizeSearchText(query).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return allItems;

  let matchedMap = null;
  for (const token of tokens) {
    const currentMap = new Map();

    // 1. 精準子字串包含優先命中（確保短關鍵字如「電力」、「電力碳」100% 命中）
    for (const item of allItems) {
      if (item._searchText.includes(token)) {
        const titleField = item._normName ?? item._normProductName ?? "";
        const score = titleField.includes(token) ? 0 : 0.05;
        currentMap.set(item, score);
      }
    }

    // 2. Fuse.js 模糊容錯輔助命中
    if (fuseInstance) {
      const results = fuseInstance.search(token);
      for (const res of results) {
        if (!currentMap.has(res.item)) {
          currentMap.set(res.item, 0.2 + (res.score ?? 0));
        }
      }
    }

    if (matchedMap === null) {
      matchedMap = currentMap;
    } else {
      const nextMap = new Map();
      for (const [item, prevScore] of matchedMap.entries()) {
        if (currentMap.has(item)) {
          nextMap.set(item, prevScore + currentMap.get(item));
        }
      }
      matchedMap = nextMap;
    }
    if (matchedMap.size === 0) return [];
  }

  return Array.from(matchedMap.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([item]) => item);
}

function getFilteredFactors() {
  const { query, year, unit, iso, ghg } = state.factorsFilter;
  const baseList = fuzzyMultiKeywordSearch(state.factorsFuse, state.factors, query);

  return baseList.filter((item) => {
    if (year && item.announcement_year !== year) return false;
    if (unit && item.unit !== unit) return false;
    if (iso && !item._isoTokens.includes(iso)) return false;
    if (ghg && !item._ghgTokens.includes(ghg)) return false;
    return true;
  });
}

function renderPagination(container, currentPage, totalPages, onPageChange) {
  if (totalPages <= 1) {
    container.innerHTML = "";
    return;
  }

  const pages = [];
  const addPage = (p) => {
    if (!pages.includes(p) && p >= 1 && p <= totalPages) pages.push(p);
  };

  addPage(1);
  for (let p = currentPage - 2; p <= currentPage + 2; p++) addPage(p);
  addPage(totalPages);
  pages.sort((a, b) => a - b);

  const fragment = document.createDocumentFragment();

  const createBtn = (label, targetPage, disabled = false, active = false) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `page-btn${active ? " active" : ""}`;
    btn.textContent = label;
    btn.disabled = disabled;
    if (!disabled && !active) {
      btn.addEventListener("click", () => onPageChange(targetPage));
    }
    return btn;
  };

  fragment.appendChild(createBtn("‹", currentPage - 1, currentPage === 1));

  let prev = 0;
  for (const p of pages) {
    if (prev && p - prev > 1) {
      const span = document.createElement("span");
      span.className = "page-ellipsis";
      span.textContent = "…";
      fragment.appendChild(span);
    }
    fragment.appendChild(createBtn(String(p), p, false, p === currentPage));
    prev = p;
  }

  fragment.appendChild(createBtn("›", currentPage + 1, currentPage === totalPages));

  container.innerHTML = "";
  container.appendChild(fragment);
}

function renderFactors() {
  const filtered = getFilteredFactors();
  const total = filtered.length;
  const { pageSize } = state.factorsFilter;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (state.factorsFilter.page > totalPages) {
    state.factorsFilter.page = totalPages;
  }
  const currentPage = state.factorsFilter.page;
  const startIdx = (currentPage - 1) * pageSize;
  const pageItems = filtered.slice(startIdx, startIdx + pageSize);

  els.factorsSummary.innerHTML = `共找到 <strong>${total.toLocaleString("zh-TW")}</strong> 筆排放係數（目前第 ${currentPage} / ${totalPages} 頁）`;

  if (total === 0) {
    els.factorsResults.innerHTML = `
      <div class="empty-state">
        <p>找不到符合條件的排放係數資料，請嘗試調整關鍵字或篩選條件。</p>
      </div>
    `;
    els.factorsPagination.innerHTML = "";
    return;
  }

  const rowsHtml = pageItems
    .map((item) => {
      const coeDisplay = escapeHtml(item.coe || (item.coe_num ?? "--"));
      const isoTags = item._isoTokens.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
      const ghgTags = item._ghgTokens.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
      const scopeHtml =
        isoTags || ghgTags
          ? `<div class="tag-list">${isoTags}${ghgTags}</div>`
          : `<span class="cell-sub">--</span>`;

      return `
        <tr>
          <td>
            <div class="cell-title">${escapeHtml(item.name)}</div>
            <div class="cell-sub">${escapeHtml(item.department || "未提供單位")}</div>
          </td>
          <td>
            <div class="coe-value">${coeDisplay}</div>
            <div class="cell-sub">kgCO₂e / ${escapeHtml(item.unit || "--")}</div>
          </td>
          <td><span class="tag tag-year">${escapeHtml(item.announcement_year || "--")}</span></td>
          <td>${scopeHtml}</td>
          <td>
            <div class="actions-cell">
              <button type="button" class="btn btn-outline btn-xs" data-action="copy-coe" data-id="${escapeHtml(item.id)}">複製數值</button>
              <button type="button" class="btn btn-soft btn-xs" data-action="calc-coe" data-id="${escapeHtml(item.id)}">試算</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  const cardsHtml = pageItems
    .map((item) => {
      const coeDisplay = escapeHtml(item.coe || (item.coe_num ?? "--"));
      const scopeJoined = [...item._isoTokens, ...item._ghgTokens]
        .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
        .join("");

      return `
        <article class="item-card">
          <div class="item-card-header">
            <h3 class="item-card-title">${escapeHtml(item.name)}</h3>
            <span class="tag tag-year">${escapeHtml(item.announcement_year || "--")}</span>
          </div>
          <div class="item-card-meta">
            <div class="meta-pair">
              <span>排放係數 (kgCO₂e)</span>
              <strong class="coe-value">${coeDisplay}</strong>
            </div>
            <div class="meta-pair">
              <span>宣告單位</span>
              <strong>${escapeHtml(item.unit || "--")}</strong>
            </div>
            <div class="meta-pair" style="grid-column: 1 / -1;">
              <span>建置／提供單位</span>
              <span>${escapeHtml(item.department || "--")}</span>
            </div>
          </div>
          ${scopeJoined ? `<div class="tag-list" style="margin-bottom: 10px;">${scopeJoined}</div>` : ""}
          <div class="item-card-footer">
            <button type="button" class="btn btn-outline btn-xs" data-action="copy-coe" data-id="${escapeHtml(item.id)}">複製數值</button>
            <button type="button" class="btn btn-soft btn-xs" data-action="calc-coe" data-id="${escapeHtml(item.id)}">帶入試算器</button>
          </div>
        </article>
      `;
    })
    .join("");

  els.factorsResults.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width: 34%;">係數名稱與提供單位</th>
            <th style="width: 18%;">碳足跡數值</th>
            <th style="width: 9%;">年份</th>
            <th style="width: 24%;">範疇三類別 (ISO / GHG)</th>
            <th style="width: 15%;">操作</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div class="mobile-cards">${cardsHtml}</div>
  `;

  renderPagination(els.factorsPagination, currentPage, totalPages, (nextPage) => {
    state.factorsFilter.page = nextPage;
    renderFactors();
    els.panelFactors.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function getFilteredProducts() {
  const { query, validity, sort } = state.productsFilter;
  const baseList = fuzzyMultiKeywordSearch(state.productsFuse, state.products, query);

  const list = baseList.filter((item) => {
    if (validity && item._validity.key !== validity) return false;
    return true;
  });

  if (sort === "asc" || sort === "desc") {
    list.sort((a, b) => {
      const ta = a._expiredTime;
      const tb = b._expiredTime;
      if (ta === null && tb === null) return 0;
      if (ta === null) return 1;
      if (tb === null) return -1;
      return sort === "asc" ? ta - tb : tb - ta;
    });
  }

  return list;
}

function renderProducts() {
  const filtered = getFilteredProducts();
  const total = filtered.length;
  const { pageSize } = state.productsFilter;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (state.productsFilter.page > totalPages) {
    state.productsFilter.page = totalPages;
  }
  const currentPage = state.productsFilter.page;
  const startIdx = (currentPage - 1) * pageSize;
  const pageItems = filtered.slice(startIdx, startIdx + pageSize);

  els.productsSummary.innerHTML = `共找到 <strong>${total.toLocaleString("zh-TW")}</strong> 項碳標籤產品（目前第 ${currentPage} / ${totalPages} 頁）`;

  if (total === 0) {
    els.productsResults.innerHTML = `
      <div class="empty-state">
        <p>找不到符合條件的碳標籤產品，請嘗試調整關鍵字或篩選條件。</p>
      </div>
    `;
    els.productsPagination.innerHTML = "";
    return;
  }

  const rowsHtml = pageItems
    .map((item) => {
      const kgText =
        item.footprint_kg !== null && item.footprint_kg !== undefined
          ? `${formatNumber(item.footprint_kg, 4)} kg`
          : "--";
      return `
        <tr>
          <td>
            <div class="cell-title">${escapeHtml(item.product_name)}</div>
            <div class="cell-sub">${escapeHtml(item.company_name || "--")}</div>
          </td>
          <td>
            <div class="mono">${escapeHtml(item.cfpl_code || "--")}</div>
            <div class="cell-sub mono">統編：${escapeHtml(item.ban || "--")}</div>
          </td>
          <td>
            <div class="coe-value">${escapeHtml(kgText)}</div>
            <div class="cell-sub">原始：${escapeHtml(item.footprint_raw || "--")} ／ ${escapeHtml(item.declared_unit || "--")}</div>
          </td>
          <td>
            <div class="mono" style="margin-bottom: 4px;">${escapeHtml(item.expired_date || "--")}</div>
            <span class="badge ${item._validity.badgeClass}">${escapeHtml(item._validity.label)}</span>
          </td>
        </tr>
      `;
    })
    .join("");

  const cardsHtml = pageItems
    .map((item) => {
      const kgText =
        item.footprint_kg !== null && item.footprint_kg !== undefined
          ? `${formatNumber(item.footprint_kg, 4)} kg`
          : "--";
      return `
        <article class="item-card">
          <div class="item-card-header">
            <h3 class="item-card-title">${escapeHtml(item.product_name)}</h3>
            <span class="badge ${item._validity.badgeClass}">${escapeHtml(item._validity.label)}</span>
          </div>
          <div class="item-card-meta">
            <div class="meta-pair" style="grid-column: 1 / -1;">
              <span>廠商／團體名稱</span>
              <strong>${escapeHtml(item.company_name || "--")}</strong>
            </div>
            <div class="meta-pair">
              <span>碳足跡 (kgCO₂e)</span>
              <strong class="coe-value">${escapeHtml(kgText)}</strong>
            </div>
            <div class="meta-pair">
              <span>原始數值 / 單位</span>
              <span>${escapeHtml(item.footprint_raw || "--")} / ${escapeHtml(item.declared_unit || "--")}</span>
            </div>
            <div class="meta-pair">
              <span>證書編號</span>
              <span class="mono">${escapeHtml(item.cfpl_code || "--")}</span>
            </div>
            <div class="meta-pair">
              <span>統一編號 / 到期日</span>
              <span class="mono">${escapeHtml(item.ban || "--")} ・ ${escapeHtml(item.expired_date || "--")}</span>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  els.productsResults.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width: 34%;">產品與廠商名稱</th>
            <th style="width: 20%;">證書與統一編號</th>
            <th style="width: 26%;">碳足跡公斤數與宣告單位</th>
            <th style="width: 20%;">證書有效期限</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div class="mobile-cards">${cardsHtml}</div>
  `;

  renderPagination(els.productsPagination, currentPage, totalPages, (nextPage) => {
    state.productsFilter.page = nextPage;
    renderProducts();
    els.panelProducts.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function renderChangelogModal(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    els.changelogBody.innerHTML = `<p class="empty-state-text">目前尚無同步更新紀錄。</p>`;
    return;
  }

  const renderDatasetBlock = (label, ds) => {
    if (!ds) return "";
    const labelsList = (arr, title) => {
      if (!Array.isArray(arr) || arr.length === 0) return "";
      const lis = arr.map((x) => `<li>${escapeHtml(x)}</li>`).join("");
      return `<details><summary>${title}（顯示前 ${arr.length} 筆）</summary><ul>${lis}</ul></details>`;
    };

    return `
      <div class="changelog-ds">
        <h3>${escapeHtml(label)}</h3>
        <div class="changelog-stats">
          <span>總數: ${ds.total_count ?? 0}</span>
          <span style="color: var(--success);">+${ds.added_count ?? 0}</span>
          <span style="color: var(--warning);">~${ds.updated_count ?? 0}</span>
          <span style="color: var(--danger);">-${ds.removed_count ?? 0}</span>
        </div>
        ${labelsList(ds.added_labels, "檢視新增項目")}
        ${labelsList(ds.updated_labels, "檢視異動項目")}
        ${labelsList(ds.removed_labels, "檢視移除項目")}
      </div>
    `;
  };

  els.changelogBody.innerHTML = entries
    .map(
      (entry) => `
        <section class="changelog-entry">
          <div class="changelog-time">同步時間：${escapeHtml(formatDateTime(entry.synced_at))}</div>
          <div class="changelog-datasets">
            ${renderDatasetBlock("CFP_P_02 排放係數", entry.CFP_P_02)}
            ${renderDatasetBlock("CFP_P_01 碳標籤產品", entry.CFP_P_01)}
          </div>
        </section>
      `
    )
    .join("");
}

async function fetchJson(path) {
  const requestUrl = new URL(path, window.location.href).href;
  const res = await fetch(requestUrl);
  if (!res.ok) {
    const finalUrl = res.url || requestUrl;
    console.error(`資料請求失敗: ${finalUrl} (HTTP ${res.status} ${res.statusText})`);
    throw new Error(`無法載入 ${finalUrl} (HTTP ${res.status})`);
  }
  return res.json();
}

async function openChangelogModal() {
  els.changelogModal.hidden = false;
  if (!state.changelog) {
    try {
      state.changelog = await fetchJson("/data/changelog.json");
    } catch (err) {
      console.error("載入更新紀錄失敗:", err);
      els.changelogBody.innerHTML = `<p class="empty-state-text">無法載入 /data/changelog.json，請稍後再試。</p>`;
      return;
    }
  }
  renderChangelogModal(state.changelog);
}

function closeChangelogModal() {
  els.changelogModal.hidden = true;
}

function bindEvents() {
  els.tabBtnFactors.addEventListener("click", () => switchTab("factors"));
  els.tabBtnProducts.addEventListener("click", () => switchTab("products"));

  els.calcQuantity.addEventListener("input", updateCalculator);
  els.calcCoe.addEventListener("input", updateCalculator);
  els.btnCalcReset.addEventListener("click", () => {
    els.calcSelectedName.textContent = "請由下方列表點選「試算」或直接輸入自訂係數";
    els.calcUnitLabel.textContent = "單位";
    els.calcQuantity.value = "1";
    els.calcCoe.value = "";
    updateCalculator();
  });

  els.factorsSearch.addEventListener("input", (e) => {
    state.factorsFilter.query = e.target.value;
    state.factorsFilter.page = 1;
    renderFactors();
  });
  els.filterYear.addEventListener("change", (e) => {
    state.factorsFilter.year = e.target.value;
    state.factorsFilter.page = 1;
    renderFactors();
  });
  els.filterUnit.addEventListener("change", (e) => {
    state.factorsFilter.unit = e.target.value;
    state.factorsFilter.page = 1;
    renderFactors();
  });
  els.filterIso.addEventListener("change", (e) => {
    state.factorsFilter.iso = e.target.value;
    state.factorsFilter.page = 1;
    renderFactors();
  });
  els.filterGhg.addEventListener("change", (e) => {
    state.factorsFilter.ghg = e.target.value;
    state.factorsFilter.page = 1;
    renderFactors();
  });
  els.factorsPageSize.addEventListener("change", (e) => {
    state.factorsFilter.pageSize = Number(e.target.value) || 20;
    state.factorsFilter.page = 1;
    renderFactors();
  });
  els.factorsResetFilters.addEventListener("click", () => {
    state.factorsFilter.query = "";
    state.factorsFilter.year = "";
    state.factorsFilter.unit = "";
    state.factorsFilter.iso = "";
    state.factorsFilter.ghg = "";
    state.factorsFilter.page = 1;
    els.factorsSearch.value = "";
    els.filterYear.value = "";
    els.filterUnit.value = "";
    els.filterIso.value = "";
    els.filterGhg.value = "";
    renderFactors();
  });

  els.factorsResults.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.getAttribute("data-id");
    const factor = state.factors.find((x) => x.id === id);
    if (!factor) return;

    const action = btn.getAttribute("data-action");
    if (action === "copy-coe") {
      const value = factor.coe || String(factor.coe_num ?? "");
      if (value) copyText(value);
    } else if (action === "calc-coe") {
      loadFactorIntoCalculator(factor);
    }
  });

  els.productsSearch.addEventListener("input", (e) => {
    state.productsFilter.query = e.target.value;
    state.productsFilter.page = 1;
    renderProducts();
  });
  els.filterValidity.addEventListener("change", (e) => {
    state.productsFilter.validity = e.target.value;
    state.productsFilter.page = 1;
    renderProducts();
  });
  els.sortExpired.addEventListener("change", (e) => {
    state.productsFilter.sort = e.target.value;
    state.productsFilter.page = 1;
    renderProducts();
  });
  els.productsPageSize.addEventListener("change", (e) => {
    state.productsFilter.pageSize = Number(e.target.value) || 20;
    state.productsFilter.page = 1;
    renderProducts();
  });
  els.productsResetFilters.addEventListener("click", () => {
    state.productsFilter.query = "";
    state.productsFilter.validity = "";
    state.productsFilter.sort = "default";
    state.productsFilter.page = 1;
    els.productsSearch.value = "";
    els.filterValidity.value = "";
    els.sortExpired.value = "default";
    renderProducts();
  });

  els.btnOpenChangelog.addEventListener("click", openChangelogModal);
  els.btnCloseChangelog.addEventListener("click", closeChangelogModal);
  els.changelogModal.addEventListener("click", (e) => {
    if (e.target === els.changelogModal) closeChangelogModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.changelogModal.hidden) {
      closeChangelogModal();
    }
  });
}

async function init() {
  bindEvents();
  try {
    const [metadata, factorsRaw, productsRaw] = await Promise.all([
      fetchJson("/data/metadata.json"),
      fetchJson("/data/cfp_factors.json"),
      fetchJson("/data/cfp_products.json"),
    ]);

    state.metadata = metadata;
    const p02Count = metadata?.datasets?.CFP_P_02?.total_count ?? factorsRaw.length;
    const p01Count = metadata?.datasets?.CFP_P_01?.total_count ?? productsRaw.length;

    els.statFactorsCount.textContent = `${p02Count.toLocaleString("zh-TW")} 筆`;
    els.statProductsCount.textContent = `${p01Count.toLocaleString("zh-TW")} 筆`;
    els.statLastSync.textContent = formatDateTime(metadata?.last_checked_at);

    state.factors = factorsRaw.map((item) => {
      const _normName = normalizeSearchText(item.name);
      const _normDepartment = normalizeSearchText(item.department);
      const _normUnit = normalizeSearchText(item.unit);
      const _normYear = normalizeSearchText(item.announcement_year);
      return {
        ...item,
        _isoTokens: parseScopeTokens(item.scope3_iso),
        _ghgTokens: parseScopeTokens(item.scope3_ghg),
        _normName,
        _normDepartment,
        _normUnit,
        _normYear,
        _searchText: `${_normName} ${_normDepartment} ${_normUnit} ${_normYear}`,
      };
    });

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    state.products = productsRaw.map((item) => {
      const expiredDateObj = parseExpiredDate(item.expired_date);
      const _normProductName = normalizeSearchText(item.product_name);
      const _normCompanyName = normalizeSearchText(item.company_name);
      const _normCfplCode = normalizeSearchText(item.cfpl_code);
      const _normBan = normalizeSearchText(item.ban);
      return {
        ...item,
        _expiredTime: expiredDateObj ? expiredDateObj.getTime() : null,
        _validity: getValidityStatus(expiredDateObj, todayStart),
        _normProductName,
        _normCompanyName,
        _normCfplCode,
        _normBan,
        _searchText: `${_normProductName} ${_normCompanyName} ${_normCfplCode} ${_normBan}`,
      };
    });

    if (typeof window.Fuse === "function") {
      const fuseBaseOptions = {
        includeScore: true,
        threshold: 0.35,
        ignoreLocation: true,
        minMatchCharLength: 1,
      };
      state.factorsFuse = new window.Fuse(state.factors, {
        ...fuseBaseOptions,
        keys: [
          { name: "_normName", weight: 2 },
          { name: "_normDepartment", weight: 1.2 },
          "_normUnit",
          "_normYear",
        ],
      });
      state.productsFuse = new window.Fuse(state.products, {
        ...fuseBaseOptions,
        keys: [
          { name: "_normProductName", weight: 2 },
          { name: "_normCompanyName", weight: 1.5 },
          "_normCfplCode",
          "_normBan",
        ],
      });
    }

    populateFactorFilterOptions();
    renderFactors();
    renderProducts();
  } catch (err) {
    console.error(err);
    els.factorsSummary.textContent = "資料載入發生錯誤，請確認 data/*.json 是否存在。";
    els.productsSummary.textContent = "資料載入發生錯誤，請確認 data/*.json 是否存在。";
  }
}

init();
