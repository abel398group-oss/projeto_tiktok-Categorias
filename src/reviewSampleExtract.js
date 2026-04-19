/**
 * Amostra de reviews (texto + fotos + SKU) com tetos para não explodir o JSON.
 */

/**
 * @param {unknown} raw
 * @param {{ maxReviews?: number; maxTextChars?: number; maxPhotosPerReview?: number }} [opts]
 * @returns {{ text: string; photos: string[]; sku_id?: string; rating?: number }[]}
 */
export function clampReviewSamples(raw, opts = {}) {
  const maxR = Math.min(50, Math.max(0, Math.floor(Number(opts.maxReviews ?? 5))));
  const maxT = Math.min(8000, Math.max(0, Math.floor(Number(opts.maxTextChars ?? 320))));
  const maxP = Math.min(20, Math.max(0, Math.floor(Number(opts.maxPhotosPerReview ?? 2))));
  if (maxR <= 0 || !Array.isArray(raw)) return [];
  /** @type {{ text: string; photos: string[]; sku_id?: string; rating?: number }[]} */
  const out = [];
  for (const it of raw) {
    if (out.length >= maxR) break;
    if (!it || typeof it !== 'object') continue;
    const o = /** @type {Record<string, unknown>} */ (it);
    let text = String(o.text ?? '').replace(/\s+/g, ' ').trim();
    if (maxT > 0 && text.length > maxT) text = text.slice(0, maxT);
    /** @type {string[]} */
    const photos = [];
    if (Array.isArray(o.photos)) {
      for (const u of o.photos) {
        if (photos.length >= maxP) break;
        const s = String(u ?? '').trim();
        if (s && /^https?:\/\//i.test(s)) photos.push(s);
      }
    }
    const skuRaw = o.sku_id;
    const sku_id = skuRaw != null && String(skuRaw).trim() ? String(skuRaw).trim() : '';
    let rating;
    if (o.rating != null && o.rating !== '') {
      const n = Number(o.rating);
      if (Number.isFinite(n)) rating = n;
    }
    if (!text && !photos.length && !sku_id && rating === undefined) continue;
    /** @type {{ text: string; photos: string[]; sku_id?: string; rating?: number }} */
    const row = { text, photos };
    if (sku_id) row.sku_id = sku_id;
    if (rating !== undefined) row.rating = rating;
    out.push(row);
  }
  return out;
}
