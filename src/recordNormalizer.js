import { createHash } from 'node:crypto';
import { emptyProduct, mergeProduct } from './productSchema.js';
import { normalizeShippingEntry } from './shippingExtract.js';

function str(v) {
  if (v == null) return '';
  return String(v).trim();
}

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

export function sanitizeProductUrl(url, productId) {
  const u = str(url);
  if (!u) return '';
  if (u.includes('[object Object]')) return '';
  return u;
}

export function urlLooksLikePdp(u) {
  return /\/pdp\/|\/view\/product\//i.test(String(u || ''));
}

export function hashCanonicalUrlPrimary(urlPrimary) {
  const s = str(urlPrimary);
  if (!s) return '';
  return createHash('sha1').update(s).digest('hex');
}

/** PDP canónico BR (sem query); ignora links vindos de SSR/rede no JSON final. */
function canonicalShopPdpUrl(productId) {
  const id = str(productId);
  if (!id) return '';
  return `https://shop.tiktok.com/br/pdp/${id}`;
}

function dedupeImagesList(urls, productId) {
  const out = [];
  const seen = new Set();
  for (const raw of urls || []) {
    const u = sanitizeProductUrl(str(raw), productId);
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

function reviewConfidence(ratingCount) {
  const n = num(ratingCount);
  return Math.log1p(n) / 10;
}

/**
 * Validação “soft”: nome e preço ausentes não bloqueiam persistência; alimentam `incomplete` / `missing_fields`.
 * @param {import('./productSchema.js').CanonicalProduct} p
 */
function softCompletenessIssues(p) {
  /** @type {string[]} */
  const missing_fields = [];
  if (!str(p.name)) missing_fields.push('name');
  if (num(p.price_current) <= 0) missing_fields.push('price');
  return { incomplete: missing_fields.length > 0, missing_fields };
}

/**
 * @param {import('./productSchema.js').CanonicalProduct} p
 */
export function normalizeProductRecord(p) {
  const out = { ...emptyProduct(), ...p };
  out.product_id = str(p.product_id);
  out.sku_id = str(p.sku_id) || out.product_id;
  out.name = str(p.name);
  const pdpCanonical = canonicalShopPdpUrl(out.product_id);
  if (pdpCanonical) {
    out.url = pdpCanonical;
    out.url_primary = pdpCanonical;
  } else {
    out.url = sanitizeProductUrl(p.url, out.product_id);
    out.url_primary = str(p.url_primary) || out.url;
  }
  out.url_type = urlLooksLikePdp(out.url_primary) ? 'dynamic' : 'static';
  out.canonical_url_hash = hashCanonicalUrlPrimary(out.url_primary);
  out.taxonomy_path = str(p.taxonomy_path);
  out.description = str(p.description);
  out.collected_at = str(p.collected_at) || new Date().toISOString();

  out.price_current = num(p.price_current);
  {
    const po = p.price_original;
    const poN = po == null || po === '' ? 0 : num(po);
    out.price_original = poN > 0 ? poN : null;
  }

  out.discount = Math.max(0, num(p.discount));
  if (out.price_current > 0 && out.price_original && out.price_original > out.price_current) {
    out.discount = Math.round(100 * (1 - out.price_current / out.price_original));
  }

  out.sales_count = Math.max(0, num(p.sales_count));
  out.normalized_sales = Math.log1p(out.sales_count);
  out.rating = num(p.rating);
  out.rating_count = p.rating_count == null || p.rating_count === '' ? null : num(p.rating_count);
  out.rating_distribution = p.rating_distribution ?? null;

  const rc = reviewConfidence(out.rating_count);
  out.score =
    0.5 * out.normalized_sales +
    0.4 * (out.rating * rc) +
    0.1 * Math.min(100, out.discount);

  let filled = 0;
  const checks = [
    out.name,
    out.price_current > 0,
    out.url_primary,
    out.images?.length,
    out.rating > 0,
    out.sales_count > 0,
    out.taxonomy_path,
  ];
  for (const c of checks) {
    if (c) filled += 1;
  }
  out.completeness_score = filled / checks.length;

  out.images = dedupeImagesList(p.images, out.product_id);
  out.image_main = out.images[0] || str(p.image_main);
  out.variants = Array.isArray(p.variants) ? p.variants : [];
  out.categories = Array.isArray(p.categories) && p.categories.length ? p.categories : ['uncategorized'];
  out.rank_position = num(p.rank_position);
  out.shipping = normalizeShippingEntry(p.shipping);

  if (!Array.isArray(out.price_history)) out.price_history = [];
  if (out.price_current > 0) {
    const last = out.price_history[out.price_history.length - 1];
    if (!last || num(last.price) !== out.price_current) {
      out.price_history = [
        ...out.price_history,
        { price: out.price_current, date: new Date().toISOString() },
      ];
    }
  }

  const soft = softCompletenessIssues(out);
  out.incomplete = soft.incomplete;
  out.missing_fields = soft.missing_fields;
  out.suspect = soft.incomplete || Boolean(p.suspect);

  return out;
}

/**
 * @param {import('./productSchema.js').CanonicalProduct} prev
 * @param {Partial<import('./productSchema.js').CanonicalProduct>} incoming
 * @param {string} provenance
 * listing_network não pode ser sobrescrito por category_ssr (ver mergeProduct / incomingWinsConflict).
 */
export function mergeCanonicalForUpsert(prev, incoming, provenance = '') {
  const base = { ...emptyProduct(), ...prev };
  const merged = mergeProduct(base, incoming, provenance);
  return merged;
}

export function validateStorable(p, provenanceHint = '') {
  const id = str(p.product_id);
  if (!id) {
    return { ok: false, reason: 'missing_product_id', incomplete: false, missing_fields: [] };
  }

  const u = str(p.url_primary || p.url);
  if (u && (u.includes('[object Object]') || /^\[object\s/i.test(u))) {
    return { ok: false, reason: 'malformed_url', incomplete: false, missing_fields: [] };
  }

  const soft = softCompletenessIssues(p);
  return {
    ok: true,
    reason: '',
    incomplete: soft.incomplete,
    missing_fields: soft.missing_fields,
  };
}
