import { config } from './config.js';
import { sleep, randomBetween } from './util.js';
import { extractTaxonomyPath } from './taxonomy.js';
import {
  emptyShipping,
  extractPdpShippingDom,
  mergeShippingPreferComplete,
  normalizeShippingEntry,
} from './shippingExtract.js';
import { waitIfCaptchaBlocking } from './captchaWait.js';
import { parseSoldCountFromDisplayText, pickMaxSoldFromVendidoTexts } from './soldParse.js';

/** Limites para extração no router PDP (passados ao `page.evaluate`). */
function pdpRouterEvaluateLimits() {
  return {
    maxReviews: config.reviewSampleMaxCount,
    maxTextChars: config.reviewSampleMaxText,
    maxPhotosPerReview: config.reviewSampleMaxPhotos,
    maxSkuOffers: config.pdpSkuOffersMax,
  };
}

/** @param {string} s */
function splitTaxonomyParts(s) {
  const t = String(s ?? '').trim();
  if (!t) return [];
  return t.split(/\s*>\s*/).map((x) => x.trim()).filter(Boolean);
}

/**
 * Unifica breadcrumb DOM, taxonomia da listagem e categorias do router (__MODERN_ROUTER_DATA__).
 * Mais segmentos ganha; em empate: router > DOM > listagem.
 * @param {string} domTax
 * @param {string} listingTax
 * @param {unknown} routerCats
 */
function mergePdpTaxonomy(domTax, listingTax, routerCats) {
  const dom = splitTaxonomyParts(domTax);
  const list = splitTaxonomyParts(listingTax);
  const rtr = Array.isArray(routerCats)
    ? routerCats.map((x) => String(x).trim()).filter(Boolean)
    : [];
  /** @type {{ parts: string[]; pri: number }[]} */
  const cand = [
    { parts: list, pri: 1 },
    { parts: dom, pri: 2 },
    { parts: rtr, pri: 3 },
  ];
  cand.sort((x, y) => {
    if (y.parts.length !== x.parts.length) return y.parts.length - x.parts.length;
    return y.pri - x.pri;
  });
  const best = cand[0].parts;
  if (!best.length) return '';
  return best.join(' > ');
}

function pickBestRow(rows) {
  if (!rows.length) return null;
  const scored = rows.map((r) => {
    let score = 0;
    if (r.preco_atual) score += 3;
    if (r.preco_original) score += 1;
    if (r.nota_avaliacao) score += 2;
    if (r.total_vendas) score += 2;
    if (r.link_imagem) score += 1;
    if (r.link_do_produto) score += 1;
    if (r.nome) score += 1;
    return { r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].r;
}

function dedupeLatestBySku(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!r?.sku) continue;
    m.set(String(r.sku), r);
  }
  return Array.from(m.values());
}

/**
 * Enriquece linha legado (ex.: sniffer) com shop/reviews/variantes do router.
 * Não altera preco_atual, preco_original, discount, sku, nome, etc. vindos de `best`.
 * @param {Record<string, unknown>} best
 * @param {Record<string, unknown> | null} routerRow
 */
function enrichLegacyRowFromRouter(best, routerRow) {
  if (!routerRow) return;
  const sn = String(routerRow.shop_name ?? '').trim();
  if (sn) best.shop_name = sn;
  const sl = String(routerRow.shop_logo ?? '').trim();
  if (sl) best.shop_logo = sl;
  const sid = String(routerRow.seller_id ?? '').trim();
  if (sid) best.seller_id = sid;
  const slink = String(routerRow.shop_link ?? '').trim();
  if (slink) best.shop_link = slink;
  if (routerRow.sold_from_pdp_dom === true) {
    best.total_vendas = String(routerRow.total_vendas ?? '');
    if (routerRow.product_sold_count != null && Number.isFinite(Number(routerRow.product_sold_count))) {
      best.product_sold_count = Math.max(0, Math.floor(Number(routerRow.product_sold_count)));
    } else {
      best.product_sold_count = null;
    }
    best.sold_from_pdp_dom = true;
    best.sold_source = 'pdp_dom';
  } else {
    const tv = String(routerRow.total_vendas ?? '').trim();
    if (tv) best.total_vendas = tv;
    const psc = routerRow.product_sold_count;
    if (psc != null && Number.isFinite(Number(psc))) {
      best.product_sold_count = Math.floor(Number(psc));
    }
    if (routerRow.sold_source) best.sold_source = String(routerRow.sold_source);
  }
  for (const key of ['shop_product_count', 'shop_review_count', 'shop_sold_count']) {
    const raw = routerRow[key];
    if (raw != null && raw !== '') {
      const n = Number(raw);
      if (Number.isFinite(n)) best[key] = n;
    }
  }
  const rc = String(routerRow.rating_count ?? '').trim();
  if (rc) best.rating_count = rc;
  const rd = routerRow.rating_distribution;
  if (rd != null && typeof rd === 'object') {
    const empty = Array.isArray(rd) ? rd.length === 0 : Object.keys(rd).length === 0;
    if (!empty) {
      try {
        best.rating_distribution = JSON.parse(JSON.stringify(rd));
      } catch {
        /* ignorar */
      }
    }
  }
  const rv = routerRow.variants;
  if (Array.isArray(rv) && rv.length > 0) {
    const bv = best.variants;
    if (!Array.isArray(bv) || bv.length === 0) {
      try {
        best.variants = JSON.parse(JSON.stringify(rv));
      } catch {
        /* ignorar */
      }
    }
  }
  if (routerRow.shipping && typeof routerRow.shipping === 'object') {
    const base =
      best.shipping && typeof best.shipping === 'object'
        ? normalizeShippingEntry(best.shipping)
        : emptyShipping();
    best.shipping = mergeShippingPreferComplete(base, routerRow.shipping);
  }
  const rs = routerRow.review_samples;
  if (Array.isArray(rs) && rs.length) {
    try {
      best.review_samples = JSON.parse(JSON.stringify(rs));
    } catch {
      /* ignorar */
    }
  }
  if (routerRow.product_video && typeof routerRow.product_video === 'object') {
    try {
      best.product_video = JSON.parse(JSON.stringify(routerRow.product_video));
    } catch {
      /* ignorar */
    }
  }
  if (Array.isArray(routerRow.product_properties) && routerRow.product_properties.length) {
    try {
      best.product_properties = JSON.parse(JSON.stringify(routerRow.product_properties));
    } catch {
      /* ignorar */
    }
  }
  if (Array.isArray(routerRow.sku_offers) && routerRow.sku_offers.length) {
    try {
      best.sku_offers = JSON.parse(JSON.stringify(routerRow.sku_offers));
    } catch {
      /* ignorar */
    }
  }
  const tvMirror = String(best.total_vendas ?? '').trim();
  if (tvMirror) best.sold_text = tvMirror;
  if (best.product_sold_count != null && Number.isFinite(Number(best.product_sold_count))) {
    best.sold_count = Math.max(0, Math.floor(Number(best.product_sold_count)));
  } else {
    best.sold_count = null;
  }
}

/**
 * Se o router deixou `shipping.text` vazio/unknown, tenta ler frete no DOM (PDP).
 * @param {import('puppeteer').Page} page
 * @param {Record<string, unknown> | null} routerRow
 */
/**
 * Log diagnóstico: tenta achar o primeiro nó cujo innerText (normalizado) iguala o texto vencedor.
 * @param {import('puppeteer').Page} page
 * @param {string} productUrl
 * @param {string} winningText
 */
async function logPdpSoldSelectedElementHtml(page, productUrl, winningText) {
  const t = String(winningText || '').replace(/\s+/g, ' ').trim();
  const product_url = String(productUrl || '').trim() || '(unknown)';
  if (!t || !page) {
    console.log('[sold selected html]', { product_url, html: null });
    return;
  }
  const html = await page.evaluate((target) => {
    const norm = (s) => (s && String(s).replace(/\s+/g, ' ').trim()) || '';
    const tgt = String(target).replace(/\s+/g, ' ').trim();
    for (const el of document.querySelectorAll('*')) {
      if (norm(/** @type {Element} */ (el).innerText) === tgt) {
        return /** @type {Element} */ (el).outerHTML || null;
      }
    }
    return null;
  }, t);
  console.log('[sold selected html]', { product_url, html: html && String(html).length > 0 ? String(html) : null });
}

/**
 * Vendas na PDP: texto(s) visível(is) no DOM = fonte oficial (não sobrescrever com router depois).
 * Vários nós podem ter "vendido(s)" — usa o maior valor parseado.
 * @param {Record<string, unknown> | null} row
 * @param {string | string[] | null | undefined} pdp_sold_dom_input um texto ou todos os candidatos do DOM
 * @param {{ product_url?: string; raw_dom_texts?: string[] } | null | undefined} [log]
 */
function applyPdpDomSold(row, pdp_sold_dom_input, log) {
  if (!row || typeof row !== 'object') return null;
  const list = Array.isArray(pdp_sold_dom_input)
    ? pdp_sold_dom_input.map((s) => String(s).trim()).filter(Boolean)
    : pdp_sold_dom_input != null && String(pdp_sold_dom_input).trim()
      ? [String(pdp_sold_dom_input).trim()]
      : [];
  if (!list.length) return null;
  const product_url = String(
    log?.product_url || row?.link_do_produto || row?.product_url || ''
  )
    .trim() || '(unknown)';
  const routerBefore = String(row.total_vendas ?? '').trim();
  const pick = pickMaxSoldFromVendidoTexts(list);
  const raw = log && Array.isArray(log.raw_dom_texts) ? log.raw_dom_texts : [];
  console.log('[sold candidates]', pick.candidates);
  console.log('[sold selected]', pick.best);
  console.log('[sold candidates]', {
    product_url,
    candidates: pick.candidates.map((c) => ({ text: c.text, value: c.value })),
  });
  console.log('[sold selected]', { product_url, selected: pick.best });
  console.log('[sold raw texts]', { product_url, texts: raw });
  row.total_vendas = pick.winningText;
  if (pick.count != null && Number.isFinite(pick.count)) {
    row.product_sold_count = pick.count;
  } else {
    row.product_sold_count = null;
  }
  row.sold_from_pdp_dom = true;
  row.sold_source = 'pdp_dom';
  console.log('[sold source]', {
    source: 'pdp_dom',
    dom_text: pick.winningText,
    parsed_value: row.product_sold_count,
    router_value: routerBefore,
  });
  return pick;
}

/**
 * Só quando **não** há texto "vendido" no DOM da PDP. Usa sold_count do router (product_model) já em `row.total_vendas`.
 * @param {Record<string, unknown> | null} row
 */
function applyPdpRouterSoldFallback(row) {
  if (!row || typeof row !== 'object') return;
  const routerValue = String(row.total_vendas ?? '').trim();
  let n = null;
  if (routerValue) {
    if (/^\d+$/.test(routerValue)) {
      n = parseInt(routerValue, 10);
    } else {
      n = parseSoldCountFromDisplayText(routerValue);
    }
  }
  row.sold_from_pdp_dom = false;
  row.sold_source = 'router_fallback';
  if (n !== null && Number.isFinite(n)) {
    row.product_sold_count = Math.max(0, Math.floor(n));
  } else {
    row.product_sold_count = null;
  }
  console.log('[sold source]', {
    source: 'router_fallback',
    dom_text: null,
    parsed_value: row.product_sold_count,
    router_value: routerValue,
  });
}

async function mergeDomShippingIntoRouterRow(page, routerRow) {
  if (!routerRow || typeof routerRow !== 'object') return;
  const sh = routerRow.shipping;
  if (
    sh &&
    typeof sh === 'object' &&
    String(sh.text || '').trim() &&
    String(sh.text) !== 'unknown'
  ) {
    return;
  }
  const dom = await extractPdpShippingDom(page);
  if (!dom) return;
  const base =
    routerRow.shipping && typeof routerRow.shipping === 'object'
      ? normalizeShippingEntry(routerRow.shipping)
      : emptyShipping();
  routerRow.shipping = mergeShippingPreferComplete(base, dom);
}

/**
 * PDP: __MODERN_ROUTER_DATA__ → components_map (product_info) → preços (opcional), loja, review_model, variantes.
 * `preco_atual` pode ficar vazio; loja/reviews/variantes vêm quando `product_info` existe.
 * @param {{ maxReviews?: number; maxTextChars?: number; maxPhotosPerReview?: number; maxSkuOffers?: number }} sampleLimits
 * @returns {Promise<{ row: Record<string, unknown> | null; diag: Record<string, unknown>; pdp_sold_dom_candidates: string[]; pdp_sold_raw_texts: string[] }>}
 */
function extractPdpPricesFromRouter(page, sampleLimits) {
  return page.evaluate((limitsArg) => {
    const L = {
      maxReviews: Math.max(0, Math.min(50, Number(limitsArg?.maxReviews ?? 5))),
      maxTextChars: Math.max(0, Math.min(8000, Number(limitsArg?.maxTextChars ?? 320))),
      maxPhotosPerReview: Math.max(0, Math.min(20, Number(limitsArg?.maxPhotosPerReview ?? 2))),
      maxSkuOffers: Math.max(0, Math.min(500, Number(limitsArg?.maxSkuOffers ?? 120))),
    };
    /** @type {Record<string, unknown>} */
    const diag = {
      found_modern_script: false,
      parsed_json: false,
      found_loader_data: false,
      found_components_map: false,
      component_types: /** @type {string[]} */ ([]),
      selected_component_type: /** @type {string | null} */ (null),
      found_product_info: false,
      has_shop_name: false,
      has_shop_logo: false,
      has_review_model: false,
      has_rating_count: false,
      has_rating_distribution: false,
      has_variants: false,
      has_product_sold_count: false,
      has_categories: false,
      has_delivery_estimate: false,
      has_review_samples: false,
      has_product_video: false,
      has_sku_offers: false,
      sku_offers_count: 0,
      product_id: '',
    };

    /**
     * Todos os nós: innerText com "vendido" (cobertura máxima; dedupe por string).
     * `raw` = lista bruta pré-dedupe; `candidates` = strings únicas para o parser.
     */
    function collectPdpSoldDomData() {
      const MAX_LEN = 32_000;
      const allTexts = Array.from(document.querySelectorAll('*'))
        .map((el) => (el && el.innerText != null ? String(el.innerText).replace(/\s+/g, ' ').trim() : ''))
        .filter(Boolean)
        .filter((text) => text.length <= MAX_LEN)
        .filter((text) => text.toLowerCase().includes('vendido'));
      const seen = new Set();
      /** @type {string[]} */
      const cands = [];
      for (const t of allTexts) {
        if (seen.has(t)) continue;
        seen.add(t);
        cands.push(t);
      }
      return { candidates: cands, raw: allTexts };
    }
    function pdpSoldDomFields() {
      const d = collectPdpSoldDomData();
      return { pdp_sold_dom_candidates: d.candidates, pdp_sold_raw_texts: d.raw };
    }

    const el = document.querySelector('script#__MODERN_ROUTER_DATA__');
    if (!el?.textContent?.trim()) {
      return { row: null, diag, ...pdpSoldDomFields() };
    }
    diag.found_modern_script = true;

    let router;
    try {
      router = JSON.parse(el.textContent);
      diag.parsed_json = true;
    } catch {
      return { row: null, diag, ...pdpSoldDomFields() };
    }
    const ld = router.loaderData;
    if (!ld || typeof ld !== 'object') {
      return { row: null, diag, ...pdpSoldDomFields() };
    }
    diag.found_loader_data = true;

    let pageConfig = null;
    for (const key of Object.keys(ld)) {
      const chunk = ld[key];
      if (chunk && typeof chunk === 'object' && chunk.page_config?.components_map) {
        pageConfig = chunk.page_config;
        break;
      }
    }
    if (!pageConfig?.components_map) {
      return { row: null, diag, ...pdpSoldDomFields() };
    }
    diag.found_components_map = true;

    for (const v of Object.values(pageConfig.components_map)) {
      if (v && typeof v === 'object') {
        const t = /** @type {Record<string, unknown>} */ (v);
        const ct = t.component_type ?? t.componentType;
        if (ct != null && String(ct).trim() !== '') {
          /** @type {string[]} */ (diag.component_types).push(String(ct).trim());
        }
      }
    }

    /** @type {{ component_type?: string; componentType?: string; component_data?: Record<string, unknown> } | null} */
    let comp = null;
    for (const v of Object.values(pageConfig.components_map)) {
      if (v && typeof v === 'object') {
        const t = /** @type {{ component_type?: string; componentType?: string }} */ (v);
        if (t.component_type === 'product_info' || t.componentType === 'product_info') {
          comp = /** @type {typeof comp} */ (v);
          diag.selected_component_type = 'product_info';
          break;
        }
      }
    }
    if (!comp?.component_data) {
      return { row: null, diag, ...pdpSoldDomFields() };
    }

    const cd = /** @type {Record<string, unknown>} */ (comp.component_data);
    const pinfo = /** @type {Record<string, unknown> | undefined} */ (
      cd.product_info ?? cd.productInfo
    );
    if (!pinfo || typeof pinfo !== 'object') {
      return { row: null, diag, ...pdpSoldDomFields() };
    }
    diag.found_product_info = true;

    function dedupeConsecutiveParts(parts) {
      const out = [];
      for (const p of parts) {
        const s = String(p).trim();
        if (!s) continue;
        if (out.length && out[out.length - 1].toLowerCase() === s.toLowerCase()) continue;
        out.push(s);
      }
      return out;
    }

    /**
     * @param {unknown} raw
     * @param {number} [depth]
     * @returns {string[]}
     */
    function flattenCategoryRaw(raw, depth) {
      const d = depth || 0;
      if (d > 14) return [];
      if (raw == null) return [];
      if (typeof raw === 'string') {
        const s = raw.trim();
        if (!s) return [];
        if (s.includes('>')) {
          return s
            .split(/\s*>\s*/)
            .map((x) => x.trim())
            .filter(Boolean);
        }
        return [s];
      }
      if (Array.isArray(raw)) {
        const out = [];
        for (const item of raw) {
          if (item == null) continue;
          if (typeof item === 'string') {
            const t = item.trim();
            if (t) out.push(t);
          } else if (typeof item === 'object') {
            const o = /** @type {Record<string, unknown>} */ (item);
            const nested =
              o.category_path ??
              o.categoryPath ??
              o.path ??
              o.children ??
              o.itemListElement;
            if (nested != null) {
              out.push(...flattenCategoryRaw(nested, d + 1));
            } else {
              const name =
                o.category_name ??
                o.categoryName ??
                o.name ??
                o.title ??
                o.category_name_en ??
                o.categoryNameEn ??
                '';
              const n = String(name).trim();
              if (n) out.push(n);
            }
          }
        }
        return dedupeConsecutiveParts(out);
      }
      if (typeof raw === 'object') {
        const o = /** @type {Record<string, unknown>} */ (raw);
        const paths = [
          o.category_path,
          o.categoryPath,
          o.path,
          o.breadcrumb,
          o.breadcrumb_list,
          o.breadcrumbList,
          o.categories,
          o.itemListElement,
        ];
        for (const p of paths) {
          const inner = flattenCategoryRaw(p, d + 1);
          if (inner.length) return inner;
        }
        const leaf =
          o.category_name ??
          o.categoryName ??
          o.name ??
          o.title ??
          '';
        const n = String(leaf).trim();
        return n ? [n] : [];
      }
      return [];
    }

    /**
     * @param {Record<string, unknown> | null | undefined} pinfoObj
     * @param {Record<string, unknown> | null | undefined} pmObj
     * @param {Record<string, unknown> | null | undefined} cdObj
     * @returns {unknown[]}
     */
    function collectCategorySources(pinfoObj, pmObj, cdObj) {
      /** @type {unknown[]} */
      const out = [];
      function pushKeys(obj, keys) {
        if (!obj || typeof obj !== 'object') return;
        const o = /** @type {Record<string, unknown>} */ (obj);
        for (const k of keys) {
          if (o[k] != null) out.push(o[k]);
        }
      }
      pushKeys(pmObj, [
        'category_path',
        'categoryPath',
        'category_path_list',
        'categoryPathList',
        'category',
        'product_category',
        'productCategory',
        'category_info',
        'categoryInfo',
        'breadcrumb',
      ]);
      pushKeys(pinfoObj, [
        'category_path',
        'categoryPath',
        'category_info',
        'categoryInfo',
        'breadcrumb_category',
        'breadcrumbCategory',
        'product_category',
        'productCategory',
        'category_detail',
        'categoryDetail',
      ]);
      pushKeys(cdObj, [
        'category_info',
        'categoryInfo',
        'breadcrumb',
        'category_path',
        'categoryPath',
      ]);
      return out;
    }

    /**
     * @param {Record<string, unknown>} pinfoObj
     * @param {Record<string, unknown> | undefined} pmObj
     * @param {Record<string, unknown>} cdObj
     * @param {Record<string, unknown> | null} componentsMap
     * @returns {string[]}
     */
    function bestCategorySegments(pinfoObj, pmObj, cdObj, componentsMap) {
      let best = [];
      for (const src of collectCategorySources(pinfoObj, pmObj, cdObj)) {
        const seg = flattenCategoryRaw(src);
        if (seg.length > best.length) best = seg;
      }
      if (componentsMap && typeof componentsMap === 'object') {
        for (const v of Object.values(componentsMap)) {
          if (!v || typeof v !== 'object') continue;
          const t = /** @type {Record<string, unknown>} */ (v);
          const ct = String(t.component_type ?? t.componentType ?? '');
          if (!/breadcrumb|category/i.test(ct)) continue;
          const cdata = t.component_data;
          if (!cdata || typeof cdata !== 'object') continue;
          for (const src of collectCategorySources(
            /** @type {Record<string, unknown>} */ (cdata),
            null,
            null
          )) {
            const seg = flattenCategoryRaw(src);
            if (seg.length > best.length) best = seg;
          }
        }
      }
      return dedupeConsecutiveParts(best);
    }

    const pmModel = /** @type {Record<string, unknown> | undefined} */ (
      pinfo.product_model ?? pinfo.productModel
    );
    const productId = pmModel
      ? String(pmModel.product_id ?? pmModel.productId ?? '').trim()
      : '';
    const nome = pmModel ? String(pmModel.name ?? '').trim() : '';

    const categorySegments = bestCategorySegments(
      /** @type {Record<string, unknown>} */ (pinfo),
      pmModel,
      cd,
      /** @type {Record<string, unknown> | null} */ (pageConfig.components_map ?? null)
    );
    diag.has_categories = categorySegments.length > 0;

    let totalVendasStr = '';
    if (pmModel && typeof pmModel === 'object') {
      const rawSold = pmModel.sold_count ?? pmModel.soldCount;
      if (rawSold != null && String(rawSold).trim() !== '') {
        totalVendasStr = String(rawSold).trim();
      }
    }

    const ogImg = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';

    function shopLogoUrlFromSeller(raw) {
      if (raw == null) return '';
      if (typeof raw === 'string') return String(raw).trim();
      if (typeof raw === 'object') {
        const o = /** @type {Record<string, unknown>} */ (raw);
        const ul = o.url_list ?? o.urlList;
        if (Array.isArray(ul) && ul[0] != null) return String(ul[0]).trim();
        const u = o.url ?? o.uri ?? o.src;
        if (u != null) return String(u).trim();
      }
      return '';
    }

    const sm = /** @type {Record<string, unknown> | undefined} */ (
      pinfo.seller_model ?? pinfo.sellerModel
    );
    let shopName = '';
    let shopLogo = '';
    if (sm && typeof sm === 'object') {
      shopName = String(sm.shop_name ?? sm.shopName ?? '').trim();
      shopLogo = shopLogoUrlFromSeller(sm.shop_logo ?? sm.shopLogo);
    }

    // shop_info vem no mesmo component_data que product_info (irmão), não dentro de product_info.
    const sinfo = /** @type {Record<string, unknown> | undefined} */ (
      cd.shop_info ??
        cd.shopInfo ??
        pinfo.shop_info ??
        pinfo.shopInfo
    );
    let sellerId = '';
    let shopLink = '';
    /** @type {number | null} */
    let shopProductCount = null;
    /** @type {number | null} */
    let shopReviewCount = null;
    /** @type {number | null} */
    let shopSoldCount = null;
    if (sinfo && typeof sinfo === 'object') {
      sellerId = String(sinfo.seller_id ?? sinfo.sellerId ?? '').trim();
      shopLink = String(sinfo.shop_link ?? sinfo.shopLink ?? '').trim();
      const osp =
        sinfo.on_sell_product_count ??
        sinfo.onSellProductCount ??
        sinfo.display_on_sell_product_count ??
        sinfo.displayOnSellProductCount;
      if (osp != null && String(osp).trim() !== '') {
        const n = Number(osp);
        if (Number.isFinite(n)) shopProductCount = n;
      }
      const src = sinfo.review_count ?? sinfo.reviewCount;
      if (src != null && String(src).trim() !== '') {
        const n = Number(src);
        if (Number.isFinite(n)) shopReviewCount = n;
      }
      const ssc =
        sinfo.sold_count ??
        sinfo.soldCount ??
        sinfo.global_sold_count ??
        sinfo.globalSoldCount;
      if (ssc != null && String(ssc).trim() !== '') {
        const n = Number(ssc);
        if (Number.isFinite(n)) shopSoldCount = n;
      }
    }
    if (!sellerId && pmModel && typeof pmModel === 'object') {
      sellerId = String(pmModel.seller_id ?? pmModel.sellerId ?? '').trim();
    }

    /** @type {{ name: string; value: string }[]} */
    const variants = [];
    function pushVariant(propName, val) {
      const n = String(propName ?? '').trim();
      const v = String(val ?? '').trim();
      if (n && v) variants.push({ name: n, value: v });
    }
    if (pmModel && typeof pmModel === 'object') {
      const saleProps = pmModel.sale_properties ?? pmModel.saleProperties;
      if (Array.isArray(saleProps)) {
        for (const sp of saleProps) {
          if (!sp || typeof sp !== 'object') continue;
          const pr = /** @type {Record<string, unknown>} */ (sp);
          const propName =
            pr.prop_name ??
            pr.propName ??
            pr.property_name ??
            pr.propertyName ??
            pr.name ??
            '';
          const values =
            pr.sale_prop_values ??
            pr.salePropValues ??
            pr.prop_values ??
            pr.propValues ??
            [];
          if (Array.isArray(values)) {
            for (const vv of values) {
              if (!vv || typeof vv !== 'object') continue;
              const m = /** @type {Record<string, unknown>} */ (vv);
              const val =
                m.prop_value ??
                m.propValue ??
                m.property_value ??
                m.propertyValue ??
                m.name ??
                '';
              pushVariant(propName, val);
            }
          }
        }
      }
    }

    /** @type {{ name: string; values: string[] }[]} */
    const productPropertiesStructured = [];
    /** @type {Record<string, unknown> | null} */
    let productVideo = null;
    /** @type {Record<string, unknown>[]} */
    const skuOffers = [];
    if (pmModel && typeof pmModel === 'object') {
      const salePropsStruct = pmModel.sale_properties ?? pmModel.saleProperties;
      if (Array.isArray(salePropsStruct)) {
        for (const sp of salePropsStruct) {
          if (!sp || typeof sp !== 'object') continue;
          const pr = /** @type {Record<string, unknown>} */ (sp);
          const propName = String(
            pr.prop_name ?? pr.propName ?? pr.property_name ?? pr.propertyName ?? pr.name ?? ''
          ).trim();
          const valsRaw =
            pr.sale_prop_values ?? pr.salePropValues ?? pr.prop_values ?? pr.propValues ?? [];
          /** @type {string[]} */
          const vals = [];
          if (Array.isArray(valsRaw)) {
            for (const vv of valsRaw) {
              if (!vv || typeof vv !== 'object') continue;
              const m = /** @type {Record<string, unknown>} */ (vv);
              const pv = String(
                m.prop_value ?? m.propValue ?? m.property_value ?? m.propertyValue ?? m.name ?? ''
              ).trim();
              if (pv && !vals.includes(pv)) vals.push(pv);
            }
          }
          if (propName && vals.length) productPropertiesStructured.push({ name: propName, values: vals });
        }
      }

      const pm = /** @type {Record<string, unknown>} */ (pmModel);
      const rawVid =
        pm.video ??
        pm.video_info ??
        pm.videoInfo ??
        pm.main_video ??
        pm.mainVideo ??
        pm.product_video ??
        pm.productVideo;
      if (rawVid && typeof rawVid === 'object') {
        const vo = /** @type {Record<string, unknown>} */ (rawVid);
        const u = String(
          vo.play_url ??
            vo.playUrl ??
            vo.url ??
            vo.video_url ??
            vo.videoUrl ??
            vo.download_url ??
            ''
        ).trim();
        const poster = String(
          vo.cover_url ?? vo.coverUrl ?? vo.poster ?? vo.thumbnail ?? vo.thumb_url ?? ''
        ).trim();
        if (u && /^https?:\/\//i.test(u)) {
          productVideo =
            poster && /^https?:\/\//i.test(poster) ? { url: u, poster } : { url: u };
        }
      } else if (typeof rawVid === 'string' && /^https?:\/\//i.test(rawVid.trim())) {
        productVideo = { url: rawVid.trim() };
      }

      if (L.maxSkuOffers > 0) {
        const skus = pm.skus;
        if (Array.isArray(skus)) {
          let n = 0;
          for (const sr of skus) {
            if (n >= L.maxSkuOffers) break;
            if (!sr || typeof sr !== 'object') continue;
            const s = /** @type {Record<string, unknown>} */ (sr);
            const sid = String(s.sku_id ?? s.skuId ?? '').trim();
            if (!sid) continue;
            /** @type {Record<string, unknown>} */
            const row = { sku_id: sid };
            const sale = s.sale_price_decimal ?? s.salePriceDecimal ?? s.sale_price ?? s.salePrice;
            if (sale != null && String(sale).trim() !== '') row.sale_price = String(sale).trim();
            const origin =
              s.origin_price_decimal ?? s.originPriceDecimal ?? s.origin_price ?? s.originPrice;
            if (origin != null && String(origin).trim() !== '') {
              row.origin_price = String(origin).trim();
            }
            const st = s.stock ?? s.quantity ?? s.available_quantity ?? s.availableQuantity;
            if (st != null && String(st).trim() !== '') {
              const q = Number(st);
              if (Number.isFinite(q)) row.stock = q;
            }
            const av = s.is_available ?? s.isAvailable ?? s.in_stock ?? s.inStock;
            if (typeof av === 'boolean') row.available = av;
            skuOffers.push(row);
            n += 1;
          }
        }
      }
    }
    diag.has_product_video = productVideo != null;
    diag.has_sku_offers = skuOffers.length > 0;
    diag.sku_offers_count = skuOffers.length;

    const rm = /** @type {Record<string, unknown> | undefined} */ (
      pinfo.review_model ?? pinfo.reviewModel
    );
    let ratingCountStr = '';
    let overallScoreStr = '';
    /** @type {unknown} */
    let ratingDist = null;
    if (rm && typeof rm === 'object') {
      const rc = rm.product_review_count ?? rm.productReviewCount;
      if (rc != null && String(rc).trim() !== '') ratingCountStr = String(rc).trim();
      const os = rm.product_overall_score ?? rm.productOverallScore;
      if (os != null && String(os).trim() !== '') overallScoreStr = String(os).trim();
      const dist =
        rm.rating_distribution ??
        rm.ratingDistribution ??
        rm.review_star_rating_distribution ??
        rm.reviewStarRatingDistribution ??
        rm.star_rating_distribution ??
        rm.starRatingDistribution;
      if (dist != null && typeof dist === 'object') {
        ratingDist = dist;
      }
    }

    const rinfo = /** @type {Record<string, unknown> | undefined} */ (
      pinfo.review_info ?? pinfo.reviewInfo
    );
    if (rinfo && typeof rinfo === 'object') {
      const rr = /** @type {Record<string, unknown> | undefined} */ (
        rinfo.review_ratings ?? rinfo.reviewRatings
      );
      if (rr && typeof rr === 'object') {
        const res = rr.rating_result ?? rr.ratingResult;
        if (res != null && typeof res === 'object') {
          const emptyRes = Array.isArray(res) ? res.length === 0 : Object.keys(res).length === 0;
          if (!emptyRes) ratingDist = res;
        }
      }
    }

    /**
     * @param {Record<string, unknown> | null | undefined} obj
     * @returns {unknown[]}
     */
    function collectReviewArraysFromObj(obj) {
      if (!obj || typeof obj !== 'object') return [];
      const o = /** @type {Record<string, unknown>} */ (obj);
      const keys = [
        'review_list',
        'reviewList',
        'reviews',
        'review_items',
        'reviewItems',
        'feed_review_list',
        'feedReviewList',
        'product_review_list',
        'productReviewList',
        'latest_review_list',
        'latestReviewList',
        'oec_review_list',
        'oecReviewList',
      ];
      for (const k of keys) {
        const v = o[k];
        if (Array.isArray(v) && v.length) return v;
      }
      return [];
    }

    /**
     * @param {Record<string, unknown> | null | undefined} rm
     * @param {Record<string, unknown> | null | undefined} rinfo
     * @param {Record<string, unknown>} pinfoObj
     * @returns {unknown[]}
     */
    function firstReviewArrayFromSources(rm, rinfo, pinfoObj) {
      for (const src of [rm, rinfo, pinfoObj]) {
        const arr = collectReviewArraysFromObj(src);
        if (arr.length) return arr;
      }
      return [];
    }

    /**
     * @param {unknown} it
     * @returns {Record<string, unknown> | null}
     */
    function mapOneReviewSample(it) {
      if (!it || typeof it !== 'object') return null;
      const o = /** @type {Record<string, unknown>} */ (it);
      const textRaw =
        o.review_text ??
        o.reviewText ??
        o.content ??
        o.text ??
        o.comment ??
        o.main_text ??
        o.mainText ??
        '';
      let text = String(textRaw).replace(/\s+/g, ' ').trim();
      if (L.maxTextChars > 0 && text.length > L.maxTextChars) {
        text = text.slice(0, L.maxTextChars);
      }
      const ratingRaw =
        o.review_rating ??
        o.reviewRating ??
        o.rating ??
        o.star ??
        o.score;
      let rating = null;
      if (ratingRaw != null && String(ratingRaw).trim() !== '') {
        const n = Number(ratingRaw);
        if (Number.isFinite(n)) rating = n;
      }
      const skuRaw = o.sku_id ?? o.skuId ?? o.product_sku_id ?? o.productSkuId ?? '';
      const sku_id = String(skuRaw).trim();

      /** @type {string[]} */
      const photos = [];
      function pushUrl(u) {
        if (photos.length >= L.maxPhotosPerReview) return;
        const s = String(u ?? '').trim();
        if (s && /^https?:\/\//i.test(s)) photos.push(s);
      }

      const mediaList = o.media ?? o.medias ?? o.images ?? o.image_list ?? o.imageList ?? o.picture_list ?? o.pictureList;
      if (Array.isArray(mediaList)) {
        for (const m of mediaList) {
          if (photos.length >= L.maxPhotosPerReview) break;
          if (typeof m === 'string') pushUrl(m);
          else if (m && typeof m === 'object') {
            const mm = /** @type {Record<string, unknown>} */ (m);
            const u =
              mm.url ??
              mm.uri ??
              mm.src ??
              (Array.isArray(mm.thumb_url_list) ? mm.thumb_url_list[0] : null) ??
              (Array.isArray(mm.thumbUrlList) ? mm.thumbUrlList[0] : null);
            pushUrl(u);
          }
        }
      }
      const urlList = o.url_list ?? o.urlList;
      if (Array.isArray(urlList)) {
        for (const u of urlList) pushUrl(u);
      }

      if (!text && !photos.length && !sku_id && rating == null) return null;
      /** @type {Record<string, unknown>} */
      const row = { text, photos };
      if (sku_id) row.sku_id = sku_id;
      if (rating != null) row.rating = rating;
      return row;
    }

    /** @type {Record<string, unknown>[]} */
    let reviewSamples = [];
    if (L.maxReviews > 0) {
      const rawList = firstReviewArrayFromSources(
        rm && typeof rm === 'object' ? /** @type {Record<string, unknown>} */ (rm) : null,
        rinfo && typeof rinfo === 'object' ? /** @type {Record<string, unknown>} */ (rinfo) : null,
        /** @type {Record<string, unknown>} */ (pinfo)
      );
      for (const it of rawList) {
        if (reviewSamples.length >= L.maxReviews) break;
        const m = mapOneReviewSample(it);
        if (m) reviewSamples.push(m);
      }
    }
    diag.has_review_samples = reviewSamples.length > 0;

    function realPriceDescImpliesFree(rawText) {
      const s = String(rawText ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      return (
        s.includes('gratis') ||
        s.includes('free') ||
        s.includes('sem frete') ||
        s.includes('envio gratis')
      );
    }

    function numOrNull(v) {
      if (v == null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }

    /**
     * @param {Record<string, unknown> | null | undefined} root
     */
    function extractDeliveryDaysFromLogisticNode(root) {
      if (!root || typeof root !== 'object') return { min: null, max: null };
      const m = /** @type {Record<string, unknown>} */ (root);
      const lm = m.logistic_model ?? m.logisticModel;
      /** @type {Record<string, unknown>[]} */
      const candidates = [];
      candidates.push(m);
      if (lm && typeof lm === 'object') candidates.push(/** @type {Record<string, unknown>} */ (lm));

      let minD = null;
      let maxD = null;
      for (const c of candidates) {
        const tryMin =
          c.delivery_min_days ??
          c.deliveryMinDays ??
          c.min_delivery_days ??
          c.minDeliveryDays ??
          c.delivery_min_day ??
          c.deliveryMinDay ??
          c.lead_time_min ??
          c.leadTimeMin ??
          c.eta_min_days ??
          c.etaMinDays;
        const tryMax =
          c.delivery_max_days ??
          c.deliveryMaxDays ??
          c.max_delivery_days ??
          c.maxDeliveryDays ??
          c.delivery_max_day ??
          c.deliveryMaxDay ??
          c.lead_time_max ??
          c.leadTimeMax ??
          c.eta_max_days ??
          c.etaMaxDays;
        const n1 = numOrNull(tryMin);
        const n2 = numOrNull(tryMax);
        if (n1 != null) minD = n1;
        if (n2 != null) maxD = n2;
        if (minD != null || maxD != null) break;
      }
      if (minD != null && maxD != null && minD > maxD) {
        const t = minD;
        minD = maxD;
        maxD = t;
      }
      return { min: minD, max: maxD };
    }

    /**
     * @param {Record<string, unknown>} pinfoObj
     * @param {Record<string, unknown> | null} plFirst
     */
    function extractDeliveryDaysFromSources(pinfoObj, plFirst) {
      if (plFirst) {
        const r = extractDeliveryDaysFromLogisticNode(plFirst);
        if (r.min != null || r.max != null) return r;
      }
      return extractDeliveryDaysFromLogisticNode(pinfoObj);
    }

    function collectLogisticListsFromPinfo(pinfoObj) {
      if (!pinfoObj || typeof pinfoObj !== 'object') return [];
      const pi = /** @type {Record<string, unknown>} */ (pinfoObj);
      const keys = [
        'promotion_logistic_list',
        'promotionLogisticList',
        'logistic_list',
        'logisticList',
        'logistics_service_list',
        'logisticsServiceList',
        'shipping_option_list',
        'shippingOptionList',
        'product_logistic_list',
        'productLogisticList',
      ];
      for (const k of keys) {
        const v = pi[k];
        if (Array.isArray(v) && v.length) return v;
      }
      return [];
    }

    /**
     * @param {Record<string, unknown>} pl
     */
    function resolveFeeBlock(pl) {
      let fee = pl.shippingFee ?? pl.shipping_fee;
      if (fee && typeof fee === 'object') return /** @type {Record<string, unknown>} */ (fee);
      const lm = pl.logistic_model ?? pl.logisticModel;
      if (lm && typeof lm === 'object') {
        const l = /** @type {Record<string, unknown>} */ (lm);
        fee = l.shipping_fee ?? l.shippingFee ?? l.fee;
        if (fee && typeof fee === 'object') return /** @type {Record<string, unknown>} */ (fee);
      }
      const svc = pl.logistic_service ?? pl.logisticService ?? pl.shipping_service ?? pl.shippingService;
      if (svc && typeof svc === 'object') {
        const s = /** @type {Record<string, unknown>} */ (svc);
        fee = s.shipping_fee ?? s.shipping_fee ?? s.fee;
        if (fee && typeof fee === 'object') return /** @type {Record<string, unknown>} */ (fee);
      }
      return null;
    }

    /**
     * @param {Record<string, unknown> | null} fee
     */
    function extractShipTextFromFee(fee) {
      if (!fee || typeof fee !== 'object') return '';
      const f = /** @type {Record<string, unknown>} */ (fee);
      const rd =
        f.real_price_desc ??
        f.realPriceDesc ??
        f.price_desc ??
        f.priceDesc ??
        f.fee_desc ??
        f.display_text ??
        f.displayText ??
        '';
      return String(rd).trim();
    }

    /**
     * @param {Record<string, unknown>} pl
     */
    function extractEtaHintFromPl(pl) {
      const lm = pl.logistic_model ?? pl.logisticModel;
      /** @type {Record<string, unknown>[]} */
      const nodes = [pl];
      if (lm && typeof lm === 'object') nodes.push(/** @type {Record<string, unknown>} */ (lm));
      for (const n of nodes) {
        const h =
          n.delivery_eta_text ??
          n.deliveryEtaText ??
          n.eta_text ??
          n.etaText ??
          n.delivery_time_desc ??
          n.deliveryTimeDesc ??
          n.shipping_text ??
          n.shippingText ??
          n.lead_time_text ??
          n.leadTimeText ??
          '';
        const s = String(h).trim();
        if (s) return s;
      }
      return '';
    }

    /**
     * @param {Record<string, unknown>} pl
     * @param {{ min: number | null; max: number | null }} dd
     */
    function buildShippingFromPlEntry(pl, dd) {
      const freeRaw = pl.freeShipping ?? pl.free_shipping;
      const fee = resolveFeeBlock(pl);
      let shipPrice = 0;
      let shipText = '';
      if (fee && typeof fee === 'object') {
        const ff = /** @type {Record<string, unknown>} */ (fee);
        const rp = ff.real_price ?? ff.realPrice;
        if (rp != null && String(rp).trim() !== '') {
          const n = Number(rp);
          if (Number.isFinite(n)) shipPrice = n;
        }
        shipText = extractShipTextFromFee(fee);
      }
      if (!shipText) shipText = extractEtaHintFromPl(pl);
      const origRaw = pl.originalShippingFee ?? pl.original_shipping_fee;
      /** @type {number | null} */
      let originalPrice = null;
      if (origRaw != null && origRaw !== '') {
        const n = Number(origRaw);
        if (Number.isFinite(n)) originalPrice = n;
      }
      const delName = pl.deliveryName ?? pl.delivery_name;
      const et = /** @type {Record<string, unknown> | undefined} */ (pl.event_tracking ?? pl.eventTracking);
      let shipType = '';
      if (et && typeof et === 'object') {
        const st = et.shipping_type ?? et.shippingType;
        if (st != null) shipType = String(st).trim();
      }
      let isFree = freeRaw === true || freeRaw === 1 || freeRaw === '1';
      if (!isFree && shipPrice === 0 && shipText && realPriceDescImpliesFree(shipText)) isFree = true;

      if (!shipText || shipText === 'unknown') {
        if (freeRaw === true || freeRaw === 1 || freeRaw === '1' || isFree) {
          shipText = 'Frete grátis';
          isFree = true;
        } else if (shipPrice > 0) {
          shipText = `R$ ${shipPrice.toFixed(2).replace('.', ',')}`;
        } else {
          shipText = 'unknown';
        }
      }

      return {
        price: isFree ? 0 : shipPrice,
        is_free: isFree,
        text: shipText,
        original_price: originalPrice,
        delivery_name: delName != null ? String(delName).trim() : '',
        shipping_type: shipType,
        delivery_min_days: dd.min,
        delivery_max_days: dd.max,
      };
    }

    function extractPinfoShippingHint(pinfoObj) {
      if (!pinfoObj || typeof pinfoObj !== 'object') return '';
      const pi = /** @type {Record<string, unknown>} */ (pinfoObj);
      const keys = [
        'shipping_summary',
        'shippingSummary',
        'delivery_text',
        'deliveryText',
        'logistic_text',
        'logisticText',
      ];
      for (const k of keys) {
        const v = pi[k];
        if (v != null && String(v).trim()) return String(v).trim();
      }
      return '';
    }

    const logisticEntries = collectLogisticListsFromPinfo(/** @type {Record<string, unknown>} */ (pinfo));
    /** @type {Record<string, unknown> | null} */
    let plFirst =
      logisticEntries[0] && typeof logisticEntries[0] === 'object'
        ? /** @type {Record<string, unknown>} */ (logisticEntries[0])
        : null;
    const deliveryDays = extractDeliveryDaysFromSources(
      /** @type {Record<string, unknown>} */ (pinfo),
      plFirst
    );
    diag.has_delivery_estimate = deliveryDays.min != null || deliveryDays.max != null;

    /** @type {Record<string, unknown> | null} */
    let shippingObj = null;
    if (logisticEntries.length) {
      /** @type {Record<string, unknown> | null} */
      let best = null;
      for (const entry of logisticEntries) {
        if (!entry || typeof entry !== 'object') continue;
        const pl = /** @type {Record<string, unknown>} */ (entry);
        const built = buildShippingFromPlEntry(pl, deliveryDays);
        if (built.text !== 'unknown') {
          shippingObj = built;
          break;
        }
        if (!best) best = built;
      }
      if (!shippingObj) shippingObj = best;
    }
    if (!shippingObj) {
      shippingObj = {
        price: null,
        is_free: false,
        text: 'unknown',
        original_price: null,
        delivery_name: '',
        shipping_type: '',
        delivery_min_days: deliveryDays.min,
        delivery_max_days: deliveryDays.max,
      };
    }
    if (shippingObj.text === 'unknown') {
      const hint = extractPinfoShippingHint(/** @type {Record<string, unknown>} */ (pinfo));
      if (hint) shippingObj = { ...shippingObj, text: hint };
    }

    let preco_atual = '';
    let preco_original = '';
    let skuId = '';
    let discount_format = '';
    let discount_decimal = '';
    const pm = /** @type {Record<string, unknown> | undefined} */ (
      pinfo.promotion_model ?? pinfo.promotionModel
    );
    const ppp = pm
      ? /** @type {Record<string, unknown> | undefined} */ (
          pm.promotion_product_price ?? pm.promotionProductPrice
        )
      : undefined;
    const min = ppp
      ? /** @type {Record<string, unknown> | undefined} */ (ppp.min_price ?? ppp.minPrice)
      : undefined;
    if (min && typeof min === 'object') {
      const sale = min.sale_price_decimal ?? min.salePriceDecimal;
      if (sale != null && String(sale).trim() !== '') {
        preco_atual = String(sale).trim();
        const origin = min.origin_price_decimal ?? min.originPriceDecimal;
        preco_original =
          origin != null && String(origin).trim() !== '' ? String(origin).trim() : '';
        skuId = String(min.sku_id ?? min.skuId ?? '').trim();
        discount_format = String(min.discount_format ?? min.discountFormat ?? '').trim();
        discount_decimal = String(min.discount_decimal ?? min.discountDecimal ?? '').trim();
      }
    }
    if (!skuId && pmModel && typeof pmModel === 'object') {
      const skus = pmModel.skus;
      if (Array.isArray(skus) && skus[0] && typeof skus[0] === 'object') {
        const s0 = /** @type {Record<string, unknown>} */ (skus[0]);
        skuId = String(s0.sku_id ?? s0.skuId ?? '').trim();
      }
    }

    diag.product_id = productId;
    diag.has_shop_name = shopName !== '';
    diag.has_shop_logo = shopLogo !== '';
    diag.has_review_model = !!(rm && typeof rm === 'object');
    diag.has_rating_count = ratingCountStr !== '';
    if (ratingDist != null && typeof ratingDist === 'object') {
      const empty = Array.isArray(ratingDist)
        ? ratingDist.length === 0
        : Object.keys(ratingDist).length === 0;
      diag.has_rating_distribution = !empty;
    } else {
      diag.has_rating_distribution = false;
    }
    diag.has_variants = variants.length > 0;
    diag.has_product_sold_count = totalVendasStr !== '';

    const row = {
      product_id: productId,
      sku_id: skuId,
      nome,
      preco_atual,
      preco_original,
      discount_format,
      discount_decimal,
      link_imagem: ogImg.trim(),
      total_vendas: totalVendasStr,
      shop_name: shopName,
      shop_logo: shopLogo,
      seller_id: sellerId,
      shop_link: shopLink,
      shop_product_count: shopProductCount,
      shop_review_count: shopReviewCount,
      shop_sold_count: shopSoldCount,
      nota_avaliacao: overallScoreStr,
      rating_count: ratingCountStr,
      rating_distribution: ratingDist,
      variants,
      shipping: shippingObj,
      categories: categorySegments,
      review_samples: reviewSamples,
      product_video: productVideo,
      product_properties: productPropertiesStructured,
      sku_offers: skuOffers,
    };
    return { row, diag, ...pdpSoldDomFields() };
  }, sampleLimits);
}

/**
 * Logs mínimos para depuração do router no ramo sniffer (Node).
 * @param {Record<string, unknown>} diag
 * @param {string} [skuHint]
 */
function logPdpRouterSnifferDiag(diag, skuHint) {
  const fp = diag.found_product_info === true;
  console.info(`[pdp-router] found_product_info=${fp}`);
  console.info(`[pdp-router] has_shop_name=${diag.has_shop_name === true}`);
  console.info(`[pdp-router] has_shop_logo=${diag.has_shop_logo === true}`);
  console.info(`[pdp-router] has_review_model=${diag.has_review_model === true}`);
  console.info(`[pdp-router] has_rating_count=${diag.has_rating_count === true}`);
  console.info(`[pdp-router] has_rating_distribution=${diag.has_rating_distribution === true}`);
  console.info(`[pdp-router] has_variants=${diag.has_variants === true}`);
  console.info(`[pdp-router] has_product_sold_count=${diag.has_product_sold_count === true}`);
  console.info(`[pdp-router] has_categories=${diag.has_categories === true}`);
  console.info(`[pdp-router] has_delivery_estimate=${diag.has_delivery_estimate === true}`);
  console.info(`[pdp-router] has_review_samples=${diag.has_review_samples === true}`);
  console.info(`[pdp-router] has_product_video=${diag.has_product_video === true}`);
  console.info(`[pdp-router] has_sku_offers=${diag.has_sku_offers === true}`);
  const soc = diag.sku_offers_count;
  console.info(`[pdp-router] sku_offers_count=${typeof soc === 'number' ? soc : 0}`);
  const pid = String(diag.product_id || skuHint || '').trim() || '(empty)';
  console.info(`[pdp-router] product_id=${pid}`);
  const types = Array.isArray(diag.component_types) ? diag.component_types : [];
  console.info(`[pdp-router] component_types=${JSON.stringify(types)}`);
  const sel = diag.selected_component_type != null ? String(diag.selected_component_type) : '';
  console.info(`[pdp-router] selected_component_type=${sel || '(none)'}`);
}

/**
 * Abre a PDP por URL (sem voltar pela listagem — evita reordenação do grid).
 * Usa JSON interceptado + complemento no DOM + breadcrumb.
 */
/**
 * @param {{ onCaptchaBlockingFirstSeen?: () => void }} [diag] opcional (ULTRA_SAFE_DIAGNOSTIC)
 */
export async function scrapeProductDetail(page, pdpUrl, taxonomiaFallback, sniffer, diag = null) {
  sniffer.drainBuffer();

  await page.goto(pdpUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitIfCaptchaBlocking(page, {
    enabled: config.captchaWaitEnabled,
    maxWaitMs: config.captchaMaxWaitMs,
    onBlockingFirstSeen: diag?.onCaptchaBlockingFirstSeen,
  });

  // Espera conteúdo principal; não falha o fluxo se o seletor mudar.
  await page
    .waitForSelector('h1, [data-e2e="product_title"], main, [class*="product"]', {
      timeout: 28_000,
    })
    .catch(() => {});

  await sleep(randomBetween(1800, 3200));
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 20_000 }).catch(() => {});

  const coleta = new Date().toISOString();
  const taxonomiaDom = (await extractTaxonomyPath(page, taxonomiaFallback)) || taxonomiaFallback || '';

  const fromNet = dedupeLatestBySku(sniffer.drainBuffer());
  const best = pickBestRow(fromNet);

  if (best && best.sku) {
    const pUrl = page.url().split('#')[0];
    console.info('[pdp] source=sniffer', {
      sku: best.sku,
      url: pUrl,
    });
    const {
      row: routerForEnrich,
      diag: routerDiag,
      pdp_sold_dom_candidates: domSoldSniffer,
      pdp_sold_raw_texts: rawSniffer,
    } = await extractPdpPricesFromRouter(page, pdpRouterEvaluateLimits());
    if (routerForEnrich) {
      const hasDom = Array.isArray(domSoldSniffer) && domSoldSniffer.length > 0;
      if (hasDom) {
        applyPdpDomSold(routerForEnrich, domSoldSniffer, {
          product_url: pUrl,
          raw_dom_texts: Array.isArray(rawSniffer) ? rawSniffer : [],
        });
        await logPdpSoldSelectedElementHtml(page, pUrl, String(routerForEnrich.total_vendas || ''));
      } else {
        applyPdpRouterSoldFallback(routerForEnrich);
      }
    }
    await mergeDomShippingIntoRouterRow(page, routerForEnrich);
    logPdpRouterSnifferDiag(routerDiag, String(best.sku || ''));
    enrichLegacyRowFromRouter(best, routerForEnrich);
    const taxonomia = mergePdpTaxonomy(
      taxonomiaDom,
      String(best.taxonomia || ''),
      routerForEnrich && Array.isArray(routerForEnrich.categories) ? routerForEnrich.categories : []
    );
    return {
      ...best,
      taxonomia: taxonomia || best.taxonomia || '',
      link_do_produto: best.link_do_produto || page.url().split('#')[0],
      data_coleta: coleta,
    };
  }

  const url = page.url().split('#')[0];
  const mHint = url.match(/(\d{10,})/g);
  const urlProductHint = mHint?.length ? mHint[mHint.length - 1] : '';
  const {
    row: routerRow,
    diag: routerDiagPdp,
    pdp_sold_dom_candidates: domSoldPdp,
    pdp_sold_raw_texts: rawPdp,
  } = await extractPdpPricesFromRouter(page, pdpRouterEvaluateLimits());
  if (routerRow) {
    const hasDom = Array.isArray(domSoldPdp) && domSoldPdp.length > 0;
    if (hasDom) {
      applyPdpDomSold(routerRow, domSoldPdp, {
        product_url: url,
        raw_dom_texts: Array.isArray(rawPdp) ? rawPdp : [],
      });
      await logPdpSoldSelectedElementHtml(page, url, String(routerRow.total_vendas || ''));
    } else {
      applyPdpRouterSoldFallback(routerRow);
    }
  }
  await mergeDomShippingIntoRouterRow(page, routerRow);
  logPdpRouterSnifferDiag(routerDiagPdp, urlProductHint);
  const taxonomiaMerged = mergePdpTaxonomy(
    taxonomiaDom,
    taxonomiaFallback || '',
    routerRow && Array.isArray(routerRow.categories) ? routerRow.categories : []
  );
  if (routerRow?.preco_atual) {
    let sku = String(routerRow.product_id || '').trim();
    if (!sku) {
      const mUrl = url.match(/(\d{10,})/g);
      if (mUrl?.length) sku = mUrl[mUrl.length - 1];
    }
    if (sku) {
      const skuId = String(routerRow.sku_id || '').trim() || sku;
      const v = routerRow.variants;
      console.info('[pdp] source=router', {
        sku,
        url,
        enrichment: {
          shop_name: Boolean(String(routerRow.shop_name || '').trim()),
          shop_logo: Boolean(String(routerRow.shop_logo || '').trim()),
          categories: Array.isArray(routerRow.categories) && routerRow.categories.length > 0,
          product_sold: Boolean(String(routerRow.total_vendas || '').trim()),
          rating_count: Boolean(String(routerRow.rating_count || '').trim()),
          rating_distribution: routerRow.rating_distribution != null,
          variants: Array.isArray(v) && v.length > 0,
          variants_len: Array.isArray(v) ? v.length : 0,
          review_samples: Array.isArray(routerRow.review_samples) ? routerRow.review_samples.length : 0,
          has_product_video: Boolean(
            routerRow.product_video && typeof routerRow.product_video === 'object'
          ),
          product_properties: Array.isArray(routerRow.product_properties)
            ? routerRow.product_properties.length
            : 0,
          sku_offers: Array.isArray(routerRow.sku_offers) ? routerRow.sku_offers.length : 0,
        },
      });
      return {
        sku,
        sku_id: skuId,
        nome: routerRow.nome || '',
        preco_atual: routerRow.preco_atual,
        preco_original: routerRow.preco_original || '',
        nota_avaliacao: String(routerRow.nota_avaliacao || '').trim(),
        rating_count: String(routerRow.rating_count || '').trim(),
        rating_distribution: routerRow.rating_distribution ?? null,
        total_vendas: String(routerRow.total_vendas ?? '').trim(),
        product_sold_count:
          routerRow.product_sold_count != null && Number.isFinite(Number(routerRow.product_sold_count))
            ? Math.floor(Number(routerRow.product_sold_count))
            : null,
        sold_text: String(routerRow.total_vendas ?? '').trim(),
        sold_count:
          routerRow.product_sold_count != null && Number.isFinite(Number(routerRow.product_sold_count))
            ? Math.floor(Number(routerRow.product_sold_count))
            : null,
        sold_from_pdp_dom: routerRow.sold_from_pdp_dom === true,
        sold_source: String(routerRow.sold_source || ''),
        taxonomia: taxonomiaMerged,
        link_do_produto: url,
        link_imagem: routerRow.link_imagem || '',
        shop_name: routerRow.shop_name || '',
        shop_logo: routerRow.shop_logo || '',
        seller_id: String(routerRow.seller_id ?? '').trim(),
        shop_link: String(routerRow.shop_link ?? '').trim(),
        shop_product_count: routerRow.shop_product_count,
        shop_review_count: routerRow.shop_review_count,
        shop_sold_count: routerRow.shop_sold_count,
        variants: Array.isArray(routerRow.variants) ? routerRow.variants : [],
        shipping: routerRow.shipping && typeof routerRow.shipping === 'object' ? routerRow.shipping : undefined,
        review_samples: Array.isArray(routerRow.review_samples) ? routerRow.review_samples : [],
        product_video:
          routerRow.product_video && typeof routerRow.product_video === 'object'
            ? routerRow.product_video
            : null,
        product_properties: Array.isArray(routerRow.product_properties) ? routerRow.product_properties : [],
        sku_offers: Array.isArray(routerRow.sku_offers) ? routerRow.sku_offers : [],
        data_coleta: coleta,
      };
    }
    console.info('[pdp] router_skipped', {
      reason: 'no_sku_after_router',
      url,
      had_precoatual: true,
    });
  } else {
    console.info('[pdp] router_skipped', {
      reason: routerRow ? 'no_precoatual' : 'no_router_payload',
      url,
    });
  }

  const dom = await page.evaluate(() => {
    const title =
      document.querySelector('h1')?.textContent?.trim() ||
      document.querySelector('[data-e2e="product_title"]')?.textContent?.trim() ||
      '';

    const prices = [];
    document.querySelectorAll('[class*="price" i], [data-e2e*="price" i], strong, span').forEach((el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 52 && /R\$|\$\s?\d|[\d.,]+\s*R\$|^\d+[.,]\d{2}/.test(t)) prices.push(t);
    });
    const preco_atual = prices[0] || '';
    const preco_original = prices.length > 1 ? prices[1] : '';

    const MAX_LEN = 32_000;
    const allSold = Array.from(document.querySelectorAll('*'))
      .map((el) => (el && el.innerText != null ? String(el.innerText).replace(/\s+/g, ' ').trim() : ''))
      .filter(Boolean)
      .filter((text) => text.length <= MAX_LEN)
      .filter((text) => text.toLowerCase().includes('vendido'));
    const soldSeen = new Set();
    /** @type {string[]} */
    const soldCands = [];
    for (const t of allSold) {
      if (soldSeen.has(t)) continue;
      soldSeen.add(t);
      soldCands.push(t);
    }

    let rating = '';
    document.querySelectorAll('[class*="rating" i], [class*="review" i], [aria-label*="star" i]').forEach((el) => {
      const t = (el.textContent || el.getAttribute('aria-label') || '').trim();
      if (t && /\d+[.,]\d+/.test(t) && t.length < 24) rating = t;
    });

    const ogImg = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
    const img =
      ogImg ||
      document.querySelector('img[src*="tiktok" i], img[src*="ttcdn" i]')?.getAttribute('src') ||
      '';

    return {
      title,
      preco_atual,
      preco_original,
      soldCands,
      allSold,
      rating,
      img,
    };
  });

  let sku = '';
  const m = url.match(/(\d{10,})/g);
  if (m?.length) sku = m[m.length - 1];

  console.info('[pdp] source=dom', { sku, url });

  const allSold = Array.isArray(dom.allSold) ? dom.allSold : [];
  const pickDom = pickMaxSoldFromVendidoTexts(Array.isArray(dom.soldCands) ? dom.soldCands : []);
  console.log('[sold candidates]', pickDom.candidates);
  console.log('[sold selected]', pickDom.best);
  console.log('[sold candidates]', {
    product_url: url,
    candidates: pickDom.candidates.map((c) => ({ text: c.text, value: c.value })),
  });
  console.log('[sold selected]', { product_url: url, selected: pickDom.best });
  console.log('[sold raw texts]', { product_url: url, texts: allSold });
  const stDom = String(pickDom.winningText || '').trim();
  const pscDomN = pickDom.count;
  console.log('[sold source]', {
    source: stDom ? 'pdp_dom' : 'none',
    dom_text: stDom || null,
    parsed_value: pscDomN,
    router_value: null,
  });
  await logPdpSoldSelectedElementHtml(page, url, stDom);

  return {
    sku,
    nome: dom.title,
    preco_atual: dom.preco_atual,
    preco_original: dom.preco_original,
    nota_avaliacao: dom.rating,
    total_vendas: stDom,
    product_sold_count: pscDomN,
    sold_text: stDom,
    sold_count: pscDomN,
    sold_from_pdp_dom: Boolean(stDom),
    sold_source: stDom ? 'pdp_dom' : 'none',
    taxonomia: taxonomiaMerged,
    link_do_produto: url,
    link_imagem: dom.img,
    review_samples: Array.isArray(routerRow?.review_samples) ? routerRow.review_samples : [],
    product_video:
      routerRow?.product_video && typeof routerRow.product_video === 'object'
        ? routerRow.product_video
        : null,
    product_properties: Array.isArray(routerRow?.product_properties) ? routerRow.product_properties : [],
    sku_offers: Array.isArray(routerRow?.sku_offers) ? routerRow.sku_offers : [],
    data_coleta: coleta,
  };
}
