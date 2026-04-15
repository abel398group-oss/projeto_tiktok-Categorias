/** Frete em listagem / PDP (mínimo compatível com produtos.json de referência). */

export function emptyShipping() {
  return { price: 0, is_free: false, text: 'unknown' };
}

/**
 * @param {unknown} labels
 */
export function shippingHasData(s) {
  return !!(s && typeof s === 'object' && (s.text || s.is_free === true || Number(s.price) > 0));
}

/**
 * @param {Record<string, unknown>} productNode
 */
export function extractFreeShippingFromListingLabels(productNode) {
  if (!productNode || typeof productNode !== 'object') return null;
  const labels = productNode.product_marketing_info?.shipping_labels;
  if (!Array.isArray(labels)) return null;
  const free = labels.some((x) => String(x || '').toLowerCase().includes('free'));
  if (free) return { price: 0, is_free: true, text: 'Free shipping' };
  return null;
}

/**
 * @param {unknown} s
 */
export function normalizeShippingEntry(s) {
  if (!s || typeof s !== 'object') return emptyShipping();
  const o = /** @type {Record<string, unknown>} */ (s);
  return {
    price: Number(o.price) || 0,
    is_free: Boolean(o.is_free),
    text: String(o.text ?? 'unknown'),
  };
}

/**
 * @param {unknown} prev
 * @param {unknown} inc
 */
export function mergeShippingPreferComplete(prev, inc) {
  const a = normalizeShippingEntry(prev);
  const b = normalizeShippingEntry(inc);
  if (b.text && b.text !== 'unknown') return b;
  if (b.is_free) return b;
  return a;
}
