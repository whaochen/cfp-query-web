const state = {
  activeTab: "combined",
  lifecycleStage: "",
  combinedQuery: "",
  currentPrintPayload: null,
  metadata: null,
  changelog: null,
  details: {},
  detailsNormalizedMap: new Map(),
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

  tabBtnCombined: document.getElementById("tab-btn-combined"),
  tabBtnFactors: document.getElementById("tab-btn-factors"),
  tabBtnProducts: document.getElementById("tab-btn-products"),
  panelCombined: document.getElementById("panel-combined"),
  panelFactors: document.getElementById("panel-factors"),
  panelProducts: document.getElementById("panel-products"),

  lifecycleGuide: document.getElementById("lifecycle-guide"),
  lifecycleStages: document.getElementById("lifecycle-stages"),
  lifecycleTip: document.getElementById("lifecycle-tip"),
  btnClearStage: document.getElementById("btn-clear-stage"),

  combinedSearch: document.getElementById("combined-search"),
  combinedResetFilters: document.getElementById("combined-reset-filters"),
  combinedResults: document.getElementById("combined-results"),

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

  detailModal: document.getElementById("detail-modal"),
  detailModalTitle: document.getElementById("detail-modal-title"),
  detailModalBody: document.getElementById("detail-modal-body"),
  btnExportPdf: document.getElementById("btn-export-pdf"),
  btnCloseDetail: document.getElementById("btn-close-detail"),
  printArea: document.getElementById("print-area"),

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

async function copyText(text, successMessage) {
  let copied = false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = false;
    }
  }
  if (!copied) {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      copied = document.execCommand("copy");
      textarea.remove();
    } catch {
      copied = false;
    }
  }
  if (copied) {
    showToast(successMessage || `已複製數值：${text}`);
  } else {
    showToast("複製失敗，請手動選取內容");
  }
}

function switchTab(tabName) {
  state.activeTab = tabName;
  const isCombined = tabName === "combined";
  const isFactors = tabName === "factors";
  const isProducts = tabName === "products";

  els.tabBtnCombined.classList.toggle("active", isCombined);
  els.tabBtnCombined.setAttribute("aria-selected", String(isCombined));
  els.panelCombined.hidden = !isCombined;

  els.tabBtnFactors.classList.toggle("active", isFactors);
  els.tabBtnFactors.setAttribute("aria-selected", String(isFactors));
  els.panelFactors.hidden = !isFactors;

  els.tabBtnProducts.classList.toggle("active", isProducts);
  els.tabBtnProducts.setAttribute("aria-selected", String(isProducts));
  els.panelProducts.hidden = !isProducts;

  els.lifecycleGuide.hidden = isProducts;
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

const LIFECYCLE_STAGES = [
  {
    id: "raw_material",
    title: "原料取得",
    desc: "原物料、化學品、農產品、包材、再生料",
    tip: "盤查提示：原物料與包材係數的系統邊界多為「搖籃到大門 (Cradle-to-Gate)」，引用時請確認是否已含上游運輸，避免與運輸階段重複計算。",
  },
  {
    id: "manufacturing",
    title: "製造與能源",
    desc: "電力、蒸氣、固定源燃料、工業用水",
    tip: "盤查提示：能源與公用流體請留意區分「直接燃燒排放（範疇一）」與「電力／蒸氣外購及上游開採（範疇二／範疇三類別 3）」之邊界差異。",
  },
  {
    id: "transport",
    title: "配送與運輸",
    desc: "公路／水路／鐵路／空運、移動源燃料",
    tip: "盤查提示：運輸服務係數多以「延噸公里 (t-km)」或「延人公里 (pkm)」為宣告單位，移動源燃料則多為「公升 (L)」，換算活動數據時請核對單位。",
  },
  {
    id: "use",
    title: "使用階段",
    desc: "產品耗能、耗材與維護",
    tip: "盤查提示：使用階段係數需搭配產品壽命、耗電量或耗材更換頻率進行情境假設，並留意服務類項目之時間／人次基準。",
  },
  {
    id: "eol",
    title: "廢棄與回收",
    desc: "事業廢棄物掩埋／焚化、廢水與回收處理服務",
    tip: "盤查提示：廢棄物處理係數通常不包含運送至處理廠的運輸排放，且回收再生料應依循「截斷法 (Cut-off)」或「系統擴張」原則避免重複扣減。",
  },
];

function getLifecycleStageMeta(stageId) {
  return LIFECYCLE_STAGES.find((s) => s.id === stageId) || null;
}

function matchesLifecycleStage(factor, stageId) {
  if (!stageId) return true;
  const text = `${factor.name || ""} ${factor.unit || ""} ${factor.department || ""}`;
  const iso = factor._isoTokens || [];
  const ghg = factor._ghgTokens || [];

  const isEol =
    iso.some((t) => t.includes("4.4") || t.includes("5.3")) ||
    ghg.some((t) => t === "類別5" || t === "類別12") ||
    /廢棄物|掩埋|焚化|廢水|污水|資源化|回收處理|堆肥|污泥/.test(text);

  const isTransport =
    iso.some((t) => ["類別3.1", "類別3.2", "類別3.3", "類別3.4", "類別3.5"].includes(t)) ||
    ghg.some((t) => ["類別4", "類別6", "類別7", "類別9"].includes(t)) ||
    /tkm|pkm|TEU-km|延噸公里|延人公里|貨運|海運|空運|鐵路|高鐵|捷運|公車|計程車|卡車|貨車|航空|船舶|運輸/.test(text);

  const isManufacturing =
    ghg.includes("類別3") ||
    iso.includes("類別4.3") ||
    /電力|電網|蒸氣|蒸汽|自來水|工業用水|純水|天然氣|柴油|汽油|重油|燃料油|液化石油氣|煤炭|鍋爐|壓縮空氣|冷凍|度\(kwh\)/.test(text);

  const isUse =
    iso.some((t) => ["類別4.5", "類別5.1", "類別5.2"].includes(t)) ||
    ghg.some((t) => ["類別8", "類別11", "類別13"].includes(t)) ||
    /使用階段|維護|清潔|洗滌|設備|照明|空調|影印|列印|餐飲|住宿|旅遊|每人每餐/.test(text);

  if (stageId === "eol") return isEol;
  if (stageId === "transport") return isTransport;
  if (stageId === "manufacturing") return isManufacturing;
  if (stageId === "use") return isUse;
  if (stageId === "raw_material") {
    return !isEol && !isTransport && !isManufacturing && !isUse;
  }
  return true;
}

function getFactorBoundaryTag(factor) {
  const detail = findFactorDetail(factor.name);
  if (!detail) return "";
  const raw = pickDetailField(detail, ["生命週期範疇(系統邊界)", "生命週期範疇"]);
  if (!raw) return "";
  return raw.replace(/\s*\([^)]*\)\s*/g, "").trim() || raw;
}

function renderLifecycleGuide() {
  if (!els.lifecycleStages) return;
  els.lifecycleStages.innerHTML = LIFECYCLE_STAGES.map((stage) => {
    const active = state.lifecycleStage === stage.id;
    return `
      <button
        type="button"
        class="lifecycle-btn${active ? " active" : ""}"
        data-stage="${stage.id}"
        aria-pressed="${String(active)}"
      >
        <span class="lifecycle-btn-title">${escapeHtml(stage.title)}</span>
        <span class="lifecycle-btn-desc">${escapeHtml(stage.desc)}</span>
      </button>
    `;
  }).join("");

  const activeMeta = getLifecycleStageMeta(state.lifecycleStage);
  els.btnClearStage.hidden = !activeMeta;
  if (activeMeta) {
    els.lifecycleTip.textContent = activeMeta.tip;
    els.lifecycleTip.hidden = false;
  } else {
    els.lifecycleTip.textContent = "";
    els.lifecycleTip.hidden = true;
  }
}

function setLifecycleStage(stageId) {
  state.lifecycleStage = state.lifecycleStage === stageId ? "" : stageId;
  state.factorsFilter.page = 1;
  renderLifecycleGuide();
  renderFactors();
  renderCombined();
}

function buildMrvPrompt(keyword, unit, boundary, geoYear) {
  const kw = (keyword || "").trim() || "（未輸入關鍵字）";
  const unitText = (unit || "").trim() || "未指定";
  const boundaryText = (boundary || "").trim() || "未指定";
  const geoYearText = (geoYear || "").trim() || "未指定";

  return `我正在執行碳盤查／產品碳足跡係數查找，請嚴格依循 5-Tier 資料來源優先序與 MRV（可量測、可報告、可查證）原則協助查找「${kw}」的排放係數：

【已確認條件與查核軌跡】
- 查詢品項：${kw}
- 功能／宣告單位：${unitText}
- 預期系統邊界：${boundaryText}
- 地理與時間範疇：${geoYearText}
- 查核紀錄：已於台灣環境部「碳足跡排放係數 (CFP_P_02, Tier 1)」及「台灣產品碳足跡資訊 (CFP_P_01, Tier 2)」直接搜尋「${kw}」，均無完全符合項目。

【請依序協助】
1. Tier 1/2 同義詞複查建議：先列出台灣環境部資料庫中可能使用的正式學名、化學名或近似材質關鍵字，方便我回系統二次確認。
2. Tier 3–5 接力查找：若 Tier 1/2 確實未收錄，請依序檢索 Tier 3（GHG Protocol 認可第三方 LCA 資料庫，如 Ecoinvent、DEFRA、SimaPro、IDEA、US LCI）→ Tier 4（供應商公開 PCF / ESG / LCA 報告）→ Tier 5（國際同儕審查學術文獻）。
3. MRV 稽核輸出格式：請列出確切數值與物理單位、涵蓋溫室氣體範疇、系統邊界、地理／時間範疇、GWP 版本（AR5/AR6）、來源 Tier 層級、可點擊原文網址，以及跳過 Tier 1/2 的查核理由說明（Audit Trail）；若需單位換算或邊界調整，請明確列出計算步驟。`;
}

function renderMrvPromptCard(keyword) {
  const initialPrompt = buildMrvPrompt(keyword, "", "", "");
  return `
    <section class="mrv-prompt-card" data-mrv-keyword="${escapeHtml(keyword || "")}">
      <div class="mrv-prompt-header">
        <h3>找不到？產生 MRV 查詢指令交給您的 AI</h3>
        <p>環境部 Tier 1 / Tier 2 資料庫無符合項目時，可選填以下條件並一鍵複製符合 MRV 與 5-Tier 稽核軌跡的 Prompt，交由 ChatGPT、Claude 或 Gemini 接力查找。</p>
      </div>
      <div class="mrv-fields-grid">
        <div class="mrv-field">
          <label>功能／宣告單位（選填）</label>
          <input type="text" class="mrv-unit-input" placeholder="例如：1 kg、1 kWh、1 t-km" />
        </div>
        <div class="mrv-field">
          <label>預期系統邊界（選填）</label>
          <select class="mrv-boundary-input">
            <option value="">未指定</option>
            <option value="搖籃到大門 (Cradle-to-Gate)">搖籃到大門 (Cradle-to-Gate)</option>
            <option value="搖籃到墳墓 (Cradle-to-Grave)">搖籃到墳墓 (Cradle-to-Grave)</option>
            <option value="大門到大門 (Gate-to-Gate)">大門到大門 (Gate-to-Gate)</option>
            <option value="能源上游／燃燒全生命週期 (WTW)">能源上游／燃燒全生命週期 (WTW)</option>
          </select>
        </div>
        <div class="mrv-field">
          <label>地理與目標年份（選填）</label>
          <input type="text" class="mrv-geoyear-input" placeholder="例如：台灣 / 2024" />
        </div>
      </div>
      <textarea class="mrv-prompt-preview" readonly aria-label="MRV 查詢 Prompt 預覽">${escapeHtml(initialPrompt)}</textarea>
      <div class="mrv-prompt-actions">
        <span class="mrv-prompt-note">零後端成本｜保留完整 Audit Trail 供查證留存</span>
        <button type="button" class="btn btn-primary btn-sm mrv-copy-btn">一鍵複製 Prompt</button>
      </div>
    </section>
  `;
}

function bindMrvCardEvents(container) {
  const card = container.querySelector(".mrv-prompt-card");
  if (!card) return;
  const keyword = card.getAttribute("data-mrv-keyword") || "";
  const unitInput = card.querySelector(".mrv-unit-input");
  const boundaryInput = card.querySelector(".mrv-boundary-input");
  const geoYearInput = card.querySelector(".mrv-geoyear-input");
  const preview = card.querySelector(".mrv-prompt-preview");
  const copyBtn = card.querySelector(".mrv-copy-btn");

  const syncPreview = () => {
    preview.value = buildMrvPrompt(keyword, unitInput.value, boundaryInput.value, geoYearInput.value);
  };

  unitInput.addEventListener("input", syncPreview);
  boundaryInput.addEventListener("change", syncPreview);
  geoYearInput.addEventListener("input", syncPreview);
  copyBtn.addEventListener("click", () => {
    copyText(preview.value, "已複製 MRV Tier 3–5 查詢 Prompt");
  });
}

function getFilteredFactors(overrideQuery = null) {
  const query = overrideQuery !== null ? overrideQuery : state.factorsFilter.query;
  const { year, unit, iso, ghg } = state.factorsFilter;
  const baseList = fuzzyMultiKeywordSearch(state.factorsFuse, state.factors, query);

  return baseList.filter((item) => {
    if (!matchesLifecycleStage(item, state.lifecycleStage)) return false;
    if (overrideQuery === null) {
      if (year && item.announcement_year !== year) return false;
      if (unit && item.unit !== unit) return false;
      if (iso && !item._isoTokens.includes(iso)) return false;
      if (ghg && !item._ghgTokens.includes(ghg)) return false;
    }
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

function buildFactorResultsMarkup(items) {
  const rowsHtml = items
    .map((item) => {
      const coeDisplay = escapeHtml(item.coe || (item.coe_num ?? "--"));
      const boundary = getFactorBoundaryTag(item);
      const boundaryTag = boundary ? `<span class="tag tag-boundary">${escapeHtml(boundary)}</span>` : "";
      const isoTags = item._isoTokens.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
      const ghgTags = item._ghgTokens.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
      const scopeHtml =
        boundaryTag || isoTags || ghgTags
          ? `<div class="tag-list">${boundaryTag}${isoTags}${ghgTags}</div>`
          : `<span class="cell-sub">--</span>`;

      return `
        <tr>
          <td>
            <div class="cell-title">
              <button type="button" class="cell-title-btn" data-action="detail-factor" data-id="${escapeHtml(item.id)}">${escapeHtml(item.name)}</button>
            </div>
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
              <button type="button" class="btn btn-outline btn-xs" data-action="detail-factor" data-id="${escapeHtml(item.id)}">細部資料</button>
              <button type="button" class="btn btn-outline btn-xs" data-action="copy-coe" data-id="${escapeHtml(item.id)}">複製</button>
              <button type="button" class="btn btn-soft btn-xs" data-action="calc-coe" data-id="${escapeHtml(item.id)}">試算</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  const cardsHtml = items
    .map((item) => {
      const coeDisplay = escapeHtml(item.coe || (item.coe_num ?? "--"));
      const boundary = getFactorBoundaryTag(item);
      const boundaryTag = boundary ? `<span class="tag tag-boundary">${escapeHtml(boundary)}</span>` : "";
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
          ${boundaryTag || scopeJoined ? `<div class="tag-list" style="margin-bottom: 10px;">${boundaryTag}${scopeJoined}</div>` : ""}
          <div class="item-card-footer">
            <button type="button" class="btn btn-outline btn-xs" data-action="detail-factor" data-id="${escapeHtml(item.id)}">細部資料</button>
            <button type="button" class="btn btn-outline btn-xs" data-action="copy-coe" data-id="${escapeHtml(item.id)}">複製數值</button>
            <button type="button" class="btn btn-soft btn-xs" data-action="calc-coe" data-id="${escapeHtml(item.id)}">帶入試算器</button>
          </div>
        </article>
      `;
    })
    .join("");

  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width: 34%;">係數名稱與提供單位</th>
            <th style="width: 18%;">碳足跡數值</th>
            <th style="width: 9%;">年份</th>
            <th style="width: 24%;">系統邊界／範疇三類別</th>
            <th style="width: 15%;">操作</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div class="mobile-cards">${cardsHtml}</div>
  `;
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
      ${renderMrvPromptCard(state.factorsFilter.query)}
    `;
    bindMrvCardEvents(els.factorsResults);
    els.factorsPagination.innerHTML = "";
    return;
  }

  els.factorsResults.innerHTML = buildFactorResultsMarkup(pageItems);

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

function buildProductResultsMarkup(items) {
  const rowsHtml = items
    .map((item) => {
      const kgText =
        item.footprint_kg !== null && item.footprint_kg !== undefined
          ? `${formatNumber(item.footprint_kg, 4)} kg`
          : "--";
      return `
        <tr>
          <td>
            <div class="cell-title">
              <button type="button" class="cell-title-btn" data-action="detail-product" data-row-id="${escapeHtml(item._rowId)}">${escapeHtml(item.product_name)}</button>
            </div>
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
          <td>
            <div class="actions-cell">
              <button type="button" class="btn btn-outline btn-xs" data-action="detail-product" data-row-id="${escapeHtml(item._rowId)}">細部資料</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  const cardsHtml = items
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
          <div class="item-card-footer">
            <button type="button" class="btn btn-outline btn-xs" data-action="detail-product" data-row-id="${escapeHtml(item._rowId)}">細部資料</button>
          </div>
        </article>
      `;
    })
    .join("");

  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width: 31%;">產品與廠商名稱</th>
            <th style="width: 19%;">證書與統一編號</th>
            <th style="width: 24%;">碳足跡公斤數與宣告單位</th>
            <th style="width: 16%;">證書有效期限</th>
            <th style="width: 10%;">操作</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div class="mobile-cards">${cardsHtml}</div>
  `;
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
      ${renderMrvPromptCard(state.productsFilter.query)}
    `;
    bindMrvCardEvents(els.productsResults);
    els.productsPagination.innerHTML = "";
    return;
  }

  els.productsResults.innerHTML = buildProductResultsMarkup(pageItems);

  renderPagination(els.productsPagination, currentPage, totalPages, (nextPage) => {
    state.productsFilter.page = nextPage;
    renderProducts();
    els.panelProducts.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function renderCombined() {
  if (!els.combinedResults) return;
  const query = state.combinedQuery.trim();
  const factorsMatched = getFilteredFactors(query);
  const productsMatched = query
    ? fuzzyMultiKeywordSearch(state.productsFuse, state.products, query)
    : state.lifecycleStage
      ? []
      : state.products;

  if (factorsMatched.length === 0 && productsMatched.length === 0) {
    els.combinedResults.innerHTML = `
      <div class="empty-state">
        <p>在 Tier 1 排放係數與 Tier 2 碳標籤產品中皆找不到符合「${escapeHtml(query || "目前條件")}」的項目。</p>
      </div>
      ${renderMrvPromptCard(query)}
    `;
    bindMrvCardEvents(els.combinedResults);
    return;
  }

  const previewLimit = 8;
  const factorSlice = factorsMatched.slice(0, previewLimit);
  const productSlice = productsMatched.slice(0, previewLimit);

  const tier1Html = `
    <section class="combined-section" aria-label="Tier 1 排放係數結果">
      <div class="combined-section-header">
        <div class="combined-section-title-group">
          <span class="tier-badge tier-badge-1">Tier 1｜CFP_P_02</span>
          <h3>環境部排放係數（共 ${factorsMatched.length.toLocaleString("zh-TW")} 筆）</h3>
          <span class="tier-hint">盤查係數引用（適用 ISO 14064-1 / ISO 14067 計算）</span>
        </div>
        ${
          factorsMatched.length > 0
            ? `<button type="button" class="btn btn-outline btn-xs" data-action="goto-factors">前往排放係數分頁（完整篩選與試算） →</button>`
            : ""
        }
      </div>
      ${
        factorSlice.length > 0
          ? buildFactorResultsMarkup(factorSlice)
          : `<p class="empty-state-text">此條件下無符合的 Tier 1 排放係數。</p>`
      }
    </section>
  `;

  const tier2Hint = state.lifecycleStage && !query
    ? `<p class="empty-state-text">已選取生命週期階段篩選（主要對應 Tier 1 排放係數）；若要對標碳標籤產品，請輸入關鍵字或切換至「碳標籤產品查詢」分頁。</p>`
    : `<p class="empty-state-text">此條件下無符合的 Tier 2 碳標籤產品。</p>`;

  const tier2Html = `
    <section class="combined-section" aria-label="Tier 2 碳標籤產品結果">
      <div class="combined-section-header">
        <div class="combined-section-title-group">
          <span class="tier-badge tier-badge-2">Tier 2｜CFP_P_01</span>
          <h3>台灣碳標籤產品（共 ${productsMatched.length.toLocaleString("zh-TW")} 筆）</h3>
          <span class="tier-hint">綠色採購對標／產品碳足跡參考（引用前請留意證書效期）</span>
        </div>
        ${
          productsMatched.length > 0
            ? `<button type="button" class="btn btn-outline btn-xs" data-action="goto-products">前往碳標籤產品分頁（效期篩選與排序） →</button>`
            : ""
        }
      </div>
      ${productSlice.length > 0 ? buildProductResultsMarkup(productSlice) : tier2Hint}
    </section>
  `;

  els.combinedResults.innerHTML = tier1Html + tier2Html;
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
  const res = await fetch(requestUrl, { cache: "no-cache" });
  if (!res.ok) {
    const finalUrl = res.url || requestUrl;
    console.error(`資料請求失敗: ${finalUrl} (HTTP ${res.status} ${res.statusText})`);
    throw new Error(`無法載入 ${finalUrl} (HTTP ${res.status})`);
  }
  return res.json();
}

async function fetchOptionalJson(path, fallbackValue) {
  const requestUrl = new URL(path, window.location.href).href;
  try {
    const res = await fetch(requestUrl, { cache: "no-cache" });
    if (!res.ok) return fallbackValue;
    return await res.json();
  } catch {
    return fallbackValue;
  }
}

function findFactorDetail(name) {
  if (!name || !state.details || typeof state.details !== "object") return null;
  if (state.details[name]) return state.details[name];
  const norm = normalizeSearchText(name);
  return state.detailsNormalizedMap.get(norm) || null;
}

function pickDetailField(detail, candidates) {
  if (!detail) return "";
  for (const key of candidates) {
    if (detail[key] !== undefined && detail[key] !== null && String(detail[key]).trim() !== "") {
      return String(detail[key]).trim();
    }
  }
  const normalizedEntries = Object.entries(detail).map(([k, v]) => [k.replace(/\s+/g, ""), v]);
  for (const key of candidates) {
    const cleanTarget = key.replace(/\s+/g, "");
    const found = normalizedEntries.find(([k]) => k.includes(cleanTarget));
    if (found && found[1] !== undefined && found[1] !== null && String(found[1]).trim() !== "") {
      return String(found[1]).trim();
    }
  }
  return "";
}

function formatDetailCellHtml(value, preLine = false) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return `<span class="detail-empty">--</span>`;
  }
  const text = escapeHtml(String(value).trim());
  if (preLine) {
    return `<div class="detail-pre-line">${text}</div>`;
  }
  return text.replace(/\n/g, "<br>");
}

function extractGwpSource(detail, remarks) {
  const direct = pickDetailField(detail, ["全球暖化潛勢值引用來源", "GWP引用來源", "全球暖化潛勢值"]);
  if (direct) return direct;
  if (remarks) {
    const match = remarks.match(/全球暖化潛勢值引用來源[為：:\s]*([^\n。]+)/);
    if (match && match[1]) return match[1].trim();
  }
  return "";
}

function formatScope3Summary(factor, detail) {
  const isoDetail = detail ? pickDetailField(detail, ["範疇三盤查適用類別(依循ISO14064-1)", "ISO14064-1"]) : "";
  const ghgDetail = detail ? pickDetailField(detail, ["範疇三盤查適用類別(依循GHG Protocol)", "GHG Protocol"]) : "";
  const isoVal = isoDetail || factor._isoTokens.join("、") || factor.scope3_iso || "--";
  const ghgVal = ghgDetail || factor._ghgTokens.join("、") || factor.scope3_ghg || "--";
  return `ISO 14064-1：${isoVal} ／ GHG Protocol：${ghgVal}`;
}

function buildFactorPrintRows(factor, detail) {
  if (detail) {
    const remarks = pickDetailField(detail, ["備註"]);
    const coeVal = pickDetailField(detail, ["碳足跡排放係數數值", "碳足跡數值"]) || (factor.coe || String(factor.coe_num ?? ""));
    const unitVal = pickDetailField(detail, ["數量", "宣告單位"]) || (factor.unit ? `1 ${factor.unit}` : "");
    return [
      ["中文名稱", pickDetailField(detail, ["中文名稱"]) || factor.name],
      ["英文名稱", pickDetailField(detail, ["英文名稱"])],
      ["化學式或俗名", pickDetailField(detail, ["化學式或俗名"])],
      ["碳足跡排放係數數值 (kgCO₂e/宣告單位)", coeVal],
      ["數量", unitVal],
      ["生命週期範疇 (系統邊界)", pickDetailField(detail, ["生命週期範疇(系統邊界)", "生命週期範疇"])],
      ["排除項目", pickDetailField(detail, ["排除項目"])],
      ["技術描述", pickDetailField(detail, ["技術描述"])],
      ["生產區域名稱", pickDetailField(detail, ["生產區域名稱", "生產區域"])],
      ["盤查起迄日", pickDetailField(detail, ["盤查起迄日"])],
      ["活動數據來源", pickDetailField(detail, ["活動數據來源"])],
      ["排放係數來源", pickDetailField(detail, ["排放係數來源"])],
      ["碳足跡計算輔導單位名稱", pickDetailField(detail, ["碳足跡計算輔導單位名稱", "輔導單位"])],
      ["建置單位名稱", pickDetailField(detail, ["建置單位名稱", "建置單位"]) || factor.department],
      ["是否經第三方查驗證", pickDetailField(detail, ["是否經第三方查驗證", "第三方查驗證"])],
      ["係數審查結果", pickDetailField(detail, ["係數審查結果", "審查結果"])],
      ["公告年份", pickDetailField(detail, ["公告年份"]) || factor.announcement_year],
      ["備註", remarks],
      ["全球暖化潛勢值引用來源", extractGwpSource(detail, remarks)],
      ["範疇三適用類別（ISO 14064-1 / GHG Protocol）", formatScope3Summary(factor, detail)],
    ];
  }

  return [
    ["中文名稱", factor.name],
    ["碳足跡排放係數數值 (kgCO₂e/宣告單位)", factor.coe || String(factor.coe_num ?? "--")],
    ["宣告單位", factor.unit],
    ["建置單位名稱", factor.department],
    ["公告年份", factor.announcement_year],
    ["範疇三適用類別（ISO 14064-1 / GHG Protocol）", formatScope3Summary(factor, null)],
  ];
}

function renderDetailTable(rows) {
  const rowsHtml = rows
    .map((row) => {
      if (row.type === "pair") {
        return `
          <tr>
            <th>${escapeHtml(row.label1)}</th>
            <td>${row.html1 ?? formatDetailCellHtml(row.value1, Boolean(row.preLine1))}</td>
            <th>${escapeHtml(row.label2)}</th>
            <td>${row.html2 ?? formatDetailCellHtml(row.value2, Boolean(row.preLine2))}</td>
          </tr>
        `;
      }
      return `
        <tr class="detail-row-single">
          <th>${escapeHtml(row.label)}</th>
          <td colspan="3">${row.html ?? formatDetailCellHtml(row.value, Boolean(row.preLine))}</td>
        </tr>
      `;
    })
    .join("");

  return `<div class="detail-table-wrap"><table class="detail-table"><tbody>${rowsHtml}</tbody></table></div>`;
}

function openFactorDetailModal(factor) {
  const detail = findFactorDetail(factor.name);
  els.detailModalTitle.textContent = `排放係數細部資料｜${factor.name || "未命名項目"}`;

  if (detail) {
    const remarks = pickDetailField(detail, ["備註"]);
    const gwpSource = extractGwpSource(detail, remarks);
    const scopeSummary = formatScope3Summary(factor, detail);
    const coeVal = pickDetailField(detail, ["碳足跡排放係數數值", "碳足跡數值"]) || (factor.coe || String(factor.coe_num ?? ""));
    const unitVal = pickDetailField(detail, ["數量", "宣告單位"]) || (factor.unit ? `1 ${factor.unit}` : "");
    const rows = [
      { type: "single", label: "中文名稱", value: pickDetailField(detail, ["中文名稱"]) || factor.name },
      { type: "single", label: "英文名稱", value: pickDetailField(detail, ["英文名稱"]) },
      { type: "single", label: "化學式或俗名", value: pickDetailField(detail, ["化學式或俗名"]) },
      { type: "pair", label1: "碳足跡數值", value1: coeVal, label2: "數量", value2: unitVal },
      { type: "single", label: "生命週期範疇", value: pickDetailField(detail, ["生命週期範疇(系統邊界)", "生命週期範疇"]) },
      { type: "single", label: "排除項目", value: pickDetailField(detail, ["排除項目"]), preLine: true },
      { type: "single", label: "技術描述", value: pickDetailField(detail, ["技術描述"]), preLine: true },
      { type: "pair", label1: "生產區域", value1: pickDetailField(detail, ["生產區域名稱", "生產區域"]), label2: "盤查起迄日", value2: pickDetailField(detail, ["盤查起迄日"]) },
      { type: "single", label: "活動數據來源", value: pickDetailField(detail, ["活動數據來源"]) },
      { type: "single", label: "排放係數來源", value: pickDetailField(detail, ["排放係數來源"]) },
      { type: "pair", label1: "輔導單位", value1: pickDetailField(detail, ["碳足跡計算輔導單位名稱", "輔導單位"]), label2: "建置單位", value2: pickDetailField(detail, ["建置單位名稱", "建置單位"]) || factor.department },
      { type: "pair", label1: "第三方查驗證", value1: pickDetailField(detail, ["是否經第三方查驗證", "第三方查驗證"]), label2: "審查結果", value2: pickDetailField(detail, ["係數審查結果", "審查結果"]) },
      { type: "single", label: "公告年份", value: pickDetailField(detail, ["公告年份"]) || factor.announcement_year },
      { type: "single", label: "備註", value: remarks, preLine: true },
      { type: "single", label: "全球暖化潛勢值引用來源", value: gwpSource },
      { type: "single", label: "範疇三類別", value: scopeSummary },
    ];
    els.detailModalBody.innerHTML = renderDetailTable(rows);
  } else {
    const coeText = factor.coe || (factor.coe_num ?? "--");
    const noticeHtml = `<div class="detail-notice">目前尚未取得此筆係數之環境部網頁明細（<code>data/cfp_details.json</code> 尚無對應紀錄），以下為開放資料提供的 7 項基本欄位：</div>`;
    const rows = [
      { type: "single", label: "中文名稱", value: factor.name },
      { type: "pair", label1: "碳足跡數值 (kgCO₂e)", value1: coeText, label2: "宣告單位", value2: factor.unit },
      { type: "pair", label1: "建置／提供單位", value1: factor.department, label2: "公告年份", value2: factor.announcement_year },
      { type: "pair", label1: "ISO 範疇三類別", value1: factor._isoTokens.join("、") || factor.scope3_iso, label2: "GHG 範疇三類別", value2: factor._ghgTokens.join("、") || factor.scope3_ghg },
    ];
    els.detailModalBody.innerHTML = noticeHtml + renderDetailTable(rows);
  }

  state.currentPrintPayload = {
    docTitle: `碳係數明細-${factor.name || "未命名項目"}`,
    headerOrg: "環境部環境資料開放平臺 CFP_P_02／產品碳足跡資訊網",
    headerTitle: `排放係數細部資料：${factor.name || "未命名項目"}`,
    sourceNote: "資料來源：環境部環境資料開放平臺 CFP_P_02／產品碳足跡資訊網",
    rows: buildFactorPrintRows(factor, detail),
  };
  els.btnExportPdf.hidden = false;
  els.detailModal.hidden = false;
}

function openProductDetailModal(product) {
  els.detailModalTitle.textContent = `碳標籤產品細部資料｜${product.product_name || "未命名產品"}`;
  const kgText =
    product.footprint_kg !== null && product.footprint_kg !== undefined
      ? `${formatNumber(product.footprint_kg, 4)} kgCO₂e`
      : "--";
  const validityHtml = `<span class="mono">${escapeHtml(product.expired_date || "--")}</span> <span class="badge ${product._validity.badgeClass}">${escapeHtml(product._validity.label)}</span>`;

  const rows = [
    { type: "single", label: "產品名稱", value: product.product_name },
    { type: "pair", label1: "碳標籤證書編號", value1: product.cfpl_code, label2: "統一編號", value2: product.ban },
    { type: "single", label: "公司／團體名稱", value: product.company_name },
    { type: "pair", label1: "原始碳足跡數據", value1: product.footprint_raw, label2: "換算後公斤數", value2: kgText },
    { type: "pair", label1: "宣告單位", value1: product.declared_unit, label2: "證書有效期限", html2: validityHtml },
  ];

  state.currentPrintPayload = {
    docTitle: `碳標籤產品明細-${product.product_name || "未命名產品"}`,
    headerOrg: "環境部環境資料開放平臺 CFP_P_01／台灣產品碳足跡資訊",
    headerTitle: `碳標籤產品細部資料：${product.product_name || "未命名產品"}`,
    sourceNote: "資料來源：環境部環境資料開放平臺 CFP_P_01／台灣產品碳足跡資訊網",
    rows: [
      ["產品名稱", product.product_name],
      ["碳標籤證書編號", product.cfpl_code],
      ["統一編號", product.ban],
      ["公司／團體名稱", product.company_name],
      ["原始碳足跡數據", product.footprint_raw],
      ["換算後公斤數", kgText],
      ["宣告單位", product.declared_unit],
      ["證書有效期限", `${product.expired_date || "--"}（${product._validity.label}）`],
    ],
  };

  els.detailModalBody.innerHTML = renderDetailTable(rows);
  els.btnExportPdf.hidden = false;
  els.detailModal.hidden = false;
}

function closeDetailModal() {
  els.detailModal.hidden = true;
  els.btnExportPdf.hidden = true;
  state.currentPrintPayload = null;
}

function exportCurrentDetailPdf() {
  const payload = state.currentPrintPayload;
  if (!payload || !els.printArea) return;

  const exportTime = formatDateTime(new Date().toISOString());
  const rowsHtml = payload.rows
    .map(
      ([label, val]) => `
        <tr>
          <td class="print-col-label">${escapeHtml(label)}</td>
          <td class="print-col-value">${escapeHtml(val && String(val).trim() ? String(val).trim() : "--")}</td>
        </tr>
      `
    )
    .join("");

  els.printArea.innerHTML = `
    <div class="print-doc-header">
      <div class="print-doc-org">${escapeHtml(payload.headerOrg)}</div>
      <h1 class="print-doc-title">${escapeHtml(payload.headerTitle)}</h1>
    </div>
    <table class="print-table">
      <thead>
        <tr>
          <th class="print-col-label">揭露項目</th>
          <th class="print-col-value">內容</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div class="print-doc-footer">
      <span>${escapeHtml(payload.sourceNote)}</span>
      <span>匯出時間：${escapeHtml(exportTime)}</span>
    </div>
  `;

  const prevTitle = document.title;
  document.title = payload.docTitle;
  const restoreTitle = () => {
    document.title = prevTitle;
  };
  window.addEventListener("afterprint", restoreTitle, { once: true });
  window.print();
  setTimeout(restoreTitle, 1500);
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

function handleFactorAction(btn) {
  const id = btn.getAttribute("data-id");
  const factor = state.factors.find((x) => x.id === id);
  if (!factor) return;

  const action = btn.getAttribute("data-action");
  if (action === "detail-factor") {
    openFactorDetailModal(factor);
  } else if (action === "copy-coe") {
    const value = factor.coe || String(factor.coe_num ?? "");
    if (value) copyText(value);
  } else if (action === "calc-coe") {
    loadFactorIntoCalculator(factor);
  }
}

function bindEvents() {
  els.tabBtnCombined.addEventListener("click", () => switchTab("combined"));
  els.tabBtnFactors.addEventListener("click", () => switchTab("factors"));
  els.tabBtnProducts.addEventListener("click", () => switchTab("products"));

  els.lifecycleStages.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-stage]");
    if (!btn) return;
    setLifecycleStage(btn.getAttribute("data-stage"));
  });

  els.btnClearStage.addEventListener("click", () => {
    state.lifecycleStage = "";
    state.factorsFilter.page = 1;
    renderLifecycleGuide();
    renderFactors();
    renderCombined();
  });

  els.combinedSearch.addEventListener("input", (e) => {
    state.combinedQuery = e.target.value;
    renderCombined();
  });

  els.combinedResetFilters.addEventListener("click", () => {
    state.combinedQuery = "";
    state.lifecycleStage = "";
    els.combinedSearch.value = "";
    renderLifecycleGuide();
    renderCombined();
    renderFactors();
  });

  els.combinedResults.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (action === "goto-factors") {
      state.factorsFilter.query = state.combinedQuery;
      state.factorsFilter.page = 1;
      els.factorsSearch.value = state.combinedQuery;
      switchTab("factors");
      renderFactors();
      return;
    }
    if (action === "goto-products") {
      state.productsFilter.query = state.combinedQuery;
      state.productsFilter.page = 1;
      els.productsSearch.value = state.combinedQuery;
      switchTab("products");
      renderProducts();
      return;
    }
    if (action === "detail-product") {
      const rowId = btn.getAttribute("data-row-id");
      const product = state.products.find((x) => x._rowId === rowId);
      if (product) openProductDetailModal(product);
      return;
    }
    handleFactorAction(btn);
  });

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
    state.lifecycleStage = "";
    els.factorsSearch.value = "";
    els.filterYear.value = "";
    els.filterUnit.value = "";
    els.filterIso.value = "";
    els.filterGhg.value = "";
    renderLifecycleGuide();
    renderFactors();
    renderCombined();
  });

  els.factorsResults.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    handleFactorAction(btn);
  });

  els.productsResults.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    if (btn.getAttribute("data-action") !== "detail-product") return;
    const rowId = btn.getAttribute("data-row-id");
    const product = state.products.find((x) => x._rowId === rowId);
    if (product) openProductDetailModal(product);
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

  els.btnExportPdf.addEventListener("click", exportCurrentDetailPdf);
  els.btnCloseDetail.addEventListener("click", closeDetailModal);
  els.detailModal.addEventListener("click", (e) => {
    if (e.target === els.detailModal) closeDetailModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!els.detailModal.hidden) {
        closeDetailModal();
      } else if (!els.changelogModal.hidden) {
        closeChangelogModal();
      }
    }
  });
}

async function init() {
  bindEvents();
  try {
    const [metadata, factorsRaw, productsRaw, detailsRaw] = await Promise.all([
      fetchJson("/data/metadata.json"),
      fetchJson("/data/cfp_factors.json"),
      fetchJson("/data/cfp_products.json"),
      fetchOptionalJson("/data/cfp_details.json", {}),
    ]);

    state.metadata = metadata;
    state.details = detailsRaw && typeof detailsRaw === "object" && !Array.isArray(detailsRaw) ? detailsRaw : {};
    state.detailsNormalizedMap = new Map(
      Object.entries(state.details).map(([k, v]) => [normalizeSearchText(k), v])
    );
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

    state.products = productsRaw.map((item, idx) => {
      const expiredDateObj = parseExpiredDate(item.expired_date);
      const _normProductName = normalizeSearchText(item.product_name);
      const _normCompanyName = normalizeSearchText(item.company_name);
      const _normCfplCode = normalizeSearchText(item.cfpl_code);
      const _normBan = normalizeSearchText(item.ban);
      const _normDeclaredUnit = normalizeSearchText(item.declared_unit);
      return {
        ...item,
        _rowId: String(idx),
        _expiredTime: expiredDateObj ? expiredDateObj.getTime() : null,
        _validity: getValidityStatus(expiredDateObj, todayStart),
        _normProductName,
        _normCompanyName,
        _normCfplCode,
        _normBan,
        _normDeclaredUnit,
        _searchText: `${_normProductName} ${_normCompanyName} ${_normCfplCode} ${_normBan} ${_normDeclaredUnit}`,
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
    renderLifecycleGuide();
    renderCombined();
    renderFactors();
    renderProducts();
  } catch (err) {
    console.error(err);
    if (els.combinedResults) {
      els.combinedResults.innerHTML = `<div class="empty-state"><p>資料載入發生錯誤，請確認 data/*.json 是否存在。</p></div>`;
    }
    els.factorsSummary.textContent = "資料載入發生錯誤，請確認 data/*.json 是否存在。";
    els.productsSummary.textContent = "資料載入發生錯誤，請確認 data/*.json 是否存在。";
  }
}

init();
