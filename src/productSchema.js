/**
 * Modelo canónico alinhado ao produtos.json de referência (sem lifecycle worker).
 */

import {
  emptyShipping,
  mergeShippingPreferComplete,
  normalizeShippingEntry,
} from './shippingExtract.js';

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function str(v) {
  if (v == null) return '';
  return String(v).trim();
}

/** Ordem de confiança em conflitos (PDP > rede > SSR); empate favorece o incoming (passagem mais recente). */
const PROVENANCE_RANK = { pdp: 3, listing_network: 2, category_ssr: 1 };

function provenanceRank(p) {
  const k = str(p);
  return PROVENANCE_RANK[k] || 0;
}

function maxRankFromChain(chain) {
  let m = 0;
  for (const part of String(chain || '').split('|')) {
    const r = provenanceRank(part.trim());
    if (r > m) m = r;
  }
  return m;
}

function incomingWinsConflict(prevChain, incomingProv) {
  const ir = provenanceRank(incomingProv);
  const pr = maxRankFromChain(prevChain);
  /** SSR nunca ganha de listing_network ou PDP já presentes na cadeia (ordem de execução irrelevante). */
  if (str(incomingProv) === 'category_ssr' && pr >= provenanceRank('listing_network')) {
    return false;
  }
  if (ir > pr) return true;
  if (ir < pr) return false;
  return true;
}

function unionDedupedStrings(prevArr, incArr) {
  const out = [];
  const seen = new Set();
  for (const arr of [prevArr, incArr]) {
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      const s = str(raw);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function onlyUncategorized(arr) {
  return Array.isArray(arr) && arr.length === 1 && str(arr[0]) === 'uncategorized';
}

function mergeCategoriesField(prevArr, incArr, prevChain, incomingProv) {
  const p = Array.isArray(prevArr) ? [...prevArr] : [];
  const i = Array.isArray(incArr) ? [...incArr] : [];
  if (!i.length) return p;
  if (!p.length) return i;
  if (onlyUncategorized(i) && !onlyUncategorized(p)) return p;
  if (onlyUncategorized(p) && !onlyUncategorized(i)) return i;
  if (!incomingWinsConflict(prevChain, incomingProv)) return p;
  return unionDedupedStrings(p, i);
}

function mergeNumericNoZeroDowngrade(prev, inc, prevChain, incomingProv) {
  const p = Number(prev);
  const i = Number(inc);
  const pOk = Number.isFinite(p) && p !== 0;
  const iOk = Number.isFinite(i) && i !== 0;
  if (!iOk) return Number.isFinite(p) ? p : 0;
  if (!pOk) return i;
  if (Math.abs(i - p) < 1e-9) return p;
  return incomingWinsConflict(prevChain, incomingProv) ? i : p;
}

function mergeSalesCount(prev, inc, prevChain, incomingProv) {
  const p = Number(prev);
  const i = Number(inc);
  const pOk = Number.isFinite(p);
  const iOk = Number.isFinite(i);
  if (!iOk) return pOk ? p : 0;
  if (!pOk) return Math.max(0, i);
  if (i === 0 && p > 0) return p;
  if (Math.abs(i - p) < 1e-9) return p;
  return incomingWinsConflict(prevChain, incomingProv) ? i : p;
}

/**
 * Preço atual: listing_network válido substitui sempre; SSR não substitui após network/PDP na cadeia.
 */
function mergePriceCurrent(prev, inc, prevChain, incomingProv) {
  const p = Number(prev);
  const i = Number(inc);
  const pOk = Number.isFinite(p) && p > 0;
  const iOk = Number.isFinite(i) && i > 0;
  if (!iOk) return pOk ? p : 0;
  if (str(incomingProv) === 'listing_network') return i;
  if (!pOk) return i;
  if (Math.abs(i - p) < 1e-9) return p;
  return incomingWinsConflict(prevChain, incomingProv) ? i : p;
}

function mergePriceOriginal(prev, inc, prevChain, incomingProv) {
  const pN = prev == null || prev === '' ? 0 : num(prev);
  const iN = inc == null || inc === '' ? 0 : num(inc);
  const pOk = Number.isFinite(pN) && pN > 0;
  const iOk = Number.isFinite(iN) && iN > 0;
  if (!iOk) return pOk ? pN : null;
  if (!pOk) return iN;
  if (Math.abs(iN - pN) < 1e-9) return pN;
  return incomingWinsConflict(prevChain, incomingProv) ? iN : pN;
}

function mergeDiscount(prev, inc, prevChain, incomingProv) {
  const p = Number(prev);
  const i = Number(inc);
  const pOk = Number.isFinite(p) && p > 0;
  const iOk = Number.isFinite(i) && i > 0;
  if (!iOk) {
    if (i === 0 && pOk) return p;
    return pOk ? p : 0;
  }
  if (!pOk) return Math.max(0, i);
  if (Math.abs(i - p) < 1e-9) return p;
  return incomingWinsConflict(prevChain, incomingProv) ? i : p;
}

function mergeStringScalar(prevVal, incVal, prevChain, incomingProv) {
  const p = str(prevVal);
  const i = str(incVal);
  if (!i) return p;
  if (!p) return i;
  if (i === p) return p;
  return incomingWinsConflict(prevChain, incomingProv) ? i : p;
}

function mergeRatingCount(prev, inc, prevChain, incomingProv) {
  if (inc == null || inc === '') {
    return prev == null || prev === '' ? null : num(prev);
  }
  if (prev == null || prev === '') return num(inc);
  const pN = num(prev);
  const iN = num(inc);
  if (iN === pN) return pN;
  if (iN === 0 && pN > 0) return pN;
  return incomingWinsConflict(prevChain, incomingProv) ? iN : pN;
}

function mergeRankPosition(prev, inc, prevChain, incomingProv) {
  const p = num(prev);
  const i = num(inc);
  if (!i || i <= 0) return p > 0 ? p : 0;
  if (!p || p <= 0) return i;
  if (i === p) return p;
  return incomingWinsConflict(prevChain, incomingProv) ? i : p;
}

/** @returns {import('./productSchema.js').CanonicalProduct} */
export function emptyProduct() {
  return {
    product_id: '',
    sku_id: '',
    name: '',
    price_current: 0,
    price_original: null,
    price_history: [],
    discount: 0,
    sales_count: 0,
    normalized_sales: 0,
    score: 0,
    completeness_score: 0,
    rating: 0,
    rating_count: null,
    rating_distribution: null,
    rank_position: 0,
    categories: [],
    images: [],
    image_main: '',
    variants: [],
    description: '',
    shop_name: '',
    shop_logo: '',
    seller_id: '',
    shop_link: '',
    shop_product_count: null,
    shop_review_count: null,
    shop_sold_count: null,
    url: '',
    url_primary: '',
    url_type: 'static',
    canonical_url_hash: '',
    product_category_from_breadcrumb: '',
    collected_at: '',
    taxonomy_path: '',
    suspect: false,
    incomplete: false,
    missing_fields: [],
    _provenance: '',
    shipping: emptyShipping(),
  };
}

/**
 * @param {Partial<CanonicalProduct>} incoming
 * @param {Partial<CanonicalProduct>} prev
 */
export function mergeProduct(prev, incoming, provenance = '') {
  const incomingKeys = Object.keys(incoming || {});
  const out = { ...emptyProduct(), ...prev };
  out.variants = Array.isArray(prev.variants) ? [...prev.variants] : [];
  out.images = Array.isArray(prev.images) ? [...prev.images] : [];
  out.categories = Array.isArray(prev.categories) ? [...prev.categories] : [];
  out.price_history = Array.isArray(prev.price_history) ? [...prev.price_history] : [];
  out.shipping = normalizeShippingEntry(prev.shipping !== undefined ? prev.shipping : out.shipping);

  const prevChain = str(prev._provenance);

  for (const k of incomingKeys) {
    if (k === '_provenance') continue;
    if (k === 'price_history') continue;
    if (k === 'shipping') {
      if (incoming.shipping && typeof incoming.shipping === 'object') {
        out.shipping = mergeShippingPreferComplete(out.shipping, incoming.shipping);
      }
      continue;
    }
    if (k === 'variants') {
      const incV = incoming.variants;
      if (!Array.isArray(incV) || !incV.length) continue;
      if (!out.variants.length || incomingWinsConflict(prevChain, provenance)) {
        out.variants = [...incV];
      }
      continue;
    }
    if (k === 'images') {
      if (Array.isArray(incoming.images)) {
        out.images = unionDedupedStrings(out.images, incoming.images);
      }
      continue;
    }
    if (k === 'categories') {
      if (Array.isArray(incoming.categories)) {
        out.categories = mergeCategoriesField(out.categories, incoming.categories, prevChain, provenance);
      }
      continue;
    }
    if (k === 'product_id') {
      out.product_id = mergeStringScalar(out.product_id, incoming.product_id, prevChain, provenance);
      continue;
    }
    if (k === 'sku_id') {
      out.sku_id = mergeStringScalar(out.sku_id, incoming.sku_id, prevChain, provenance);
      continue;
    }
    if (k === 'name') {
      out.name = mergeStringScalar(out.name, incoming.name, prevChain, provenance);
      continue;
    }
    if (k === 'price_current') {
      out.price_current = mergePriceCurrent(out.price_current, incoming.price_current, prevChain, provenance);
      continue;
    }
    if (k === 'price_original') {
      out.price_original = mergePriceOriginal(out.price_original, incoming.price_original, prevChain, provenance);
      continue;
    }
    if (k === 'discount') {
      out.discount = mergeDiscount(out.discount, incoming.discount, prevChain, provenance);
      continue;
    }
    if (k === 'sales_count') {
      out.sales_count = mergeSalesCount(out.sales_count, incoming.sales_count, prevChain, provenance);
      continue;
    }
    if (k === 'rating') {
      out.rating = mergeNumericNoZeroDowngrade(out.rating, incoming.rating, prevChain, provenance);
      continue;
    }
    if (k === 'rating_count') {
      out.rating_count = mergeRatingCount(out.rating_count, incoming.rating_count, prevChain, provenance);
      continue;
    }
    if (k === 'rating_distribution') {
      const inc = incoming.rating_distribution;
      if (inc == null || typeof inc !== 'object') continue;
      const empty =
        Array.isArray(inc) ? inc.length === 0 : Object.keys(/** @type {Record<string, unknown>} */ (inc)).length === 0;
      if (empty) continue;
      const prevD = out.rating_distribution;
      const hasPrev =
        prevD != null &&
        typeof prevD === 'object' &&
        (Array.isArray(prevD) ? prevD.length > 0 : Object.keys(/** @type {Record<string, unknown>} */ (prevD)).length > 0);
      if (!hasPrev || incomingWinsConflict(prevChain, provenance)) {
        out.rating_distribution = /** @type {typeof out.rating_distribution} */ (
          JSON.parse(JSON.stringify(inc))
        );
      }
      continue;
    }
    if (k === 'taxonomy_path') {
      out.taxonomy_path = mergeStringScalar(out.taxonomy_path, incoming.taxonomy_path, prevChain, provenance);
      continue;
    }
    if (k === 'url') {
      out.url = mergeStringScalar(out.url, incoming.url, prevChain, provenance);
      continue;
    }
    if (k === 'url_primary') {
      out.url_primary = mergeStringScalar(out.url_primary, incoming.url_primary, prevChain, provenance);
      continue;
    }
    if (k === 'image_main') {
      out.image_main = mergeStringScalar(out.image_main, incoming.image_main, prevChain, provenance);
      continue;
    }
    if (k === 'description') {
      out.description = mergeStringScalar(out.description, incoming.description, prevChain, provenance);
      continue;
    }
    if (k === 'shop_name') {
      out.shop_name = mergeStringScalar(out.shop_name, incoming.shop_name, prevChain, provenance);
      continue;
    }
    if (k === 'shop_logo') {
      out.shop_logo = mergeStringScalar(out.shop_logo, incoming.shop_logo, prevChain, provenance);
      continue;
    }
    if (k === 'seller_id') {
      out.seller_id = mergeStringScalar(out.seller_id, incoming.seller_id, prevChain, provenance);
      continue;
    }
    if (k === 'shop_link') {
      out.shop_link = mergeStringScalar(out.shop_link, incoming.shop_link, prevChain, provenance);
      continue;
    }
    if (k === 'shop_product_count' || k === 'shop_review_count' || k === 'shop_sold_count') {
      out[k] = mergeRatingCount(out[k], incoming[k], prevChain, provenance);
      continue;
    }
    if (k === 'rank_position') {
      out.rank_position = mergeRankPosition(out.rank_position, incoming.rank_position, prevChain, provenance);
      continue;
    }
    if (k === 'collected_at') {
      const p = str(out.collected_at);
      const i = str(incoming.collected_at);
      if (!i) continue;
      if (!p) {
        out.collected_at = i;
        continue;
      }
      out.collected_at = incomingWinsConflict(prevChain, provenance) ? i : p;
      continue;
    }

    const v = incoming[k];
    if (v === undefined) continue;
    if (v === null) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    if (typeof v === 'number' && v === 0 && typeof out[k] === 'number' && out[k] !== 0) continue;
    out[k] = v;
  }

  if (provenance) {
    out._provenance = [str(prev._provenance), provenance].filter(Boolean).join('|');
  }

  return out;
}

/**
 * @param {Record<string, unknown>} row
 */
export function fromLegacyRow(row) {
  const price = num(String(row.preco_atual || '').replace(/[^\d.,]/g, '').replace(',', '.'));
  const priceO = num(String(row.preco_original || '').replace(/[^\d.,]/g, '').replace(',', '.'));
  const sku = str(row.sku);
  const link = str(row.link_do_produto);
  const img = str(row.link_imagem);
  const imgs = [];
  if (img) imgs.push(img);
  if (Array.isArray(row.images)) {
    for (const u of row.images) {
      const s = str(u);
      if (s && !imgs.includes(s)) imgs.push(s);
    }
  }

  let discount = num(row.discount);
  if (price > 0 && priceO > price) {
    discount = Math.round(100 * (1 - price / priceO));
  }

  /** @type {Record<string, unknown>} */
  const payload = {
    product_id: sku,
    sku_id: str(row.sku_id) || sku,
    name: str(row.nome),
    price_current: price,
    price_original: priceO > 0 ? priceO : null,
    discount,
    rating: num(row.nota_avaliacao),
    sales_count: num(String(row.total_vendas || '').replace(/[^\d.]/g, '')),
    taxonomy_path: str(row.taxonomia),
    url: link,
    images: imgs,
    image_main: img || imgs[0] || '',
    collected_at: str(row.data_coleta) || new Date().toISOString(),
  };
  if (row.rating_count != null && row.rating_count !== '') {
    payload.rating_count = num(row.rating_count);
  }
  if (row.rating_distribution != null && typeof row.rating_distribution === 'object') {
    try {
      const cloned = JSON.parse(JSON.stringify(row.rating_distribution));
      const empty =
        Array.isArray(cloned) ? cloned.length === 0 : Object.keys(cloned).length === 0;
      if (!empty) payload.rating_distribution = cloned;
    } catch {
      /* ignorar */
    }
  }
  if (row.rank_position != null) payload.rank_position = num(row.rank_position);
  if (row.shipping && typeof row.shipping === 'object') {
    payload.shipping = normalizeShippingEntry(row.shipping);
  }

  const shn = str(row.shop_name);
  if (shn) payload.shop_name = shn;
  const shl = str(row.shop_logo);
  if (shl) payload.shop_logo = shl;
  const sid = str(row.seller_id);
  if (sid) payload.seller_id = sid;
  const slk = str(row.shop_link);
  if (slk) payload.shop_link = slk;
  for (const key of ['shop_product_count', 'shop_review_count', 'shop_sold_count']) {
    const raw = row[key];
    if (raw != null && raw !== '') {
      const n = num(raw);
      if (Number.isFinite(n)) payload[key] = n;
    }
  }

  if (Array.isArray(row.variants) && row.variants.length) {
    /** @type {{ name: string; value: string }[]} */
    const cleaned = [];
    for (const it of row.variants) {
      if (!it || typeof it !== 'object') continue;
      const o = /** @type {Record<string, unknown>} */ (it);
      const n = str(o.name);
      const v = str(o.value);
      if (n && v) cleaned.push({ name: n, value: v });
    }
    if (cleaned.length) payload.variants = cleaned;
  }

  return mergeProduct(emptyProduct(), payload, '');
}

/**
 * @param {CanonicalProduct} p
 */
export function toLegacyRow(p) {
  return {
    sku: p.product_id,
    nome: p.name,
    preco_atual: p.price_current ? String(p.price_current) : '',
    preco_original:
      p.price_original != null && num(p.price_original) > 0 ? String(p.price_original) : '',
    nota_avaliacao: p.rating ? String(p.rating) : '',
    total_vendas: p.sales_count ? String(p.sales_count) : '',
    taxonomia: p.taxonomy_path || (Array.isArray(p.categories) ? p.categories.join(' > ') : ''),
    link_do_produto: p.url,
    link_imagem: str(p.image_main) || (Array.isArray(p.images) ? p.images[0] || '' : ''),
    data_coleta: p.collected_at,
  };
}

/** @typedef {ReturnType<typeof emptyProduct>} CanonicalProduct */
