/**
 * Vídeo, propriedades e SKUs (PDP) — normalização e tetos para o JSON canónico.
 */

/**
 * @param {unknown} v
 * @returns {{ url: string; poster?: string } | null}
 */
export function clampProductVideo(v) {
  if (v == null || typeof v !== 'object') return null;
  const o = /** @type {Record<string, unknown>} */ (v);
  const url = String(o.url ?? '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const posterRaw = o.poster;
  const poster =
    posterRaw != null && String(posterRaw).trim() && /^https?:\/\//i.test(String(posterRaw).trim())
      ? String(posterRaw).trim()
      : undefined;
  return poster ? { url, poster } : { url };
}

/**
 * @param {unknown} arr
 * @param {{ maxProps?: number; maxValuesPerProp?: number; maxStrLen?: number }} [opts]
 * @returns {{ name: string; values: string[] }[]}
 */
export function clampProductProperties(arr, opts = {}) {
  const maxP = Math.min(40, Math.max(0, Math.floor(Number(opts.maxProps ?? 24))));
  const maxV = Math.min(200, Math.max(0, Math.floor(Number(opts.maxValuesPerProp ?? 80))));
  const maxLen = Math.min(500, Math.max(0, Math.floor(Number(opts.maxStrLen ?? 160))));
  if (!Array.isArray(arr) || maxP <= 0) return [];
  /** @type {{ name: string; values: string[] }[]} */
  const out = [];
  for (const it of arr) {
    if (out.length >= maxP) break;
    if (!it || typeof it !== 'object') continue;
    const o = /** @type {Record<string, unknown>} */ (it);
    const name = String(o.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    let nName = name;
    if (maxLen > 0 && nName.length > maxLen) nName = nName.slice(0, maxLen);
    /** @type {string[]} */
    const values = [];
    if (Array.isArray(o.values)) {
      for (const x of o.values) {
        if (values.length >= maxV) break;
        let s = String(x ?? '').replace(/\s+/g, ' ').trim();
        if (!s) continue;
        if (maxLen > 0 && s.length > maxLen) s = s.slice(0, maxLen);
        if (!values.includes(s)) values.push(s);
      }
    }
    if (!values.length) continue;
    out.push({ name: nName, values });
  }
  return out;
}

/**
 * @param {unknown} arr
 * @param {{ maxRows?: number; maxStrLen?: number }} [opts]
 * @returns {{ sku_id: string; sale_price?: string; origin_price?: string; stock?: number; available?: boolean }[]}
 */
export function clampSkuOffers(arr, opts = {}) {
  const maxR = Math.min(500, Math.max(0, Math.floor(Number(opts.maxRows ?? 120))));
  const maxLen = Math.min(80, Math.max(0, Math.floor(Number(opts.maxStrLen ?? 32))));
  if (!Array.isArray(arr) || maxR <= 0) return [];
  /** @type {{ sku_id: string; sale_price?: string; origin_price?: string; stock?: number; available?: boolean }[]} */
  const out = [];
  for (const it of arr) {
    if (out.length >= maxR) break;
    if (!it || typeof it !== 'object') continue;
    const o = /** @type {Record<string, unknown>} */ (it);
    const sku_id = String(o.sku_id ?? '').trim();
    if (!sku_id) continue;
    /** @type {typeof out[0]} */
    const row = { sku_id };
    const sp = o.sale_price ?? o.salePrice;
    if (sp != null && String(sp).trim() !== '') {
      let s = String(sp).trim();
      if (maxLen > 0 && s.length > maxLen) s = s.slice(0, maxLen);
      row.sale_price = s;
    }
    const op = o.origin_price ?? o.originPrice;
    if (op != null && String(op).trim() !== '') {
      let s = String(op).trim();
      if (maxLen > 0 && s.length > maxLen) s = s.slice(0, maxLen);
      row.origin_price = s;
    }
    if (o.stock != null && o.stock !== '') {
      const n = Number(o.stock);
      if (Number.isFinite(n)) row.stock = n;
    }
    if (typeof o.available === 'boolean') row.available = o.available;
    out.push(row);
  }
  return out;
}
