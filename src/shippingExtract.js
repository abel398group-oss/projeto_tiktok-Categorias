/** Frete em listagem / PDP (mínimo compatível com produtos.json de referência). */

export function emptyShipping() {
  return {
    price: 0,
    is_free: false,
    text: 'unknown',
    original_price: null,
    delivery_name: '',
    shipping_type: '',
    /** Prazo estimado (dias úteis/calendário conforme API). */
    delivery_min_days: null,
    delivery_max_days: null,
  };
}

/**
 * Listagem BR: "Frete grátis", "grátis", "free shipping", etc.
 * @param {unknown} rawLabel
 */
export function shippingLabelLooksFree(rawLabel) {
  const s = String(rawLabel ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return (
    s.includes('free') ||
    s.includes('gratis') ||
    s.includes('sem frete') ||
    s.includes('envio gratis')
  );
}

/**
 * @param {unknown} labels
 */
export function shippingLabelsIndicateFree(labels) {
  if (!Array.isArray(labels)) return false;
  return labels.some((x) => shippingLabelLooksFree(x));
}

/**
 * @param {unknown} s
 */
export function shippingHasData(s) {
  return !!(
    s &&
    typeof s === 'object' &&
    (s.text ||
      s.is_free === true ||
      Number(s.price) > 0 ||
      (s.delivery_name && String(s.delivery_name).trim()) ||
      (s.shipping_type && String(s.shipping_type).trim()) ||
      (s.original_price != null && Number(s.original_price) > 0) ||
      (s.delivery_min_days != null && Number.isFinite(Number(s.delivery_min_days))) ||
      (s.delivery_max_days != null && Number.isFinite(Number(s.delivery_max_days))))
  );
}

/**
 * Dados de frete já resolvidos (não só placeholder de listagem vazia / texto unknown).
 * @param {{ text?: string; is_free?: boolean; price?: number | null; delivery_name?: string; shipping_type?: string; original_price?: number | null; delivery_min_days?: number | null; delivery_max_days?: number | null }} a
 */
function shippingHasMeaningfulData(a) {
  return !!(
    (a.text && String(a.text) !== 'unknown') ||
    a.is_free === true ||
    (typeof a.price === 'number' && a.price > 0) ||
    (a.delivery_name && String(a.delivery_name).trim()) ||
    (a.shipping_type && String(a.shipping_type).trim()) ||
    (a.original_price != null && Number(a.original_price) > 0) ||
    (a.delivery_min_days != null && Number.isFinite(Number(a.delivery_min_days))) ||
    (a.delivery_max_days != null && Number.isFinite(Number(a.delivery_max_days)))
  );
}

/**
 * @param {Record<string, unknown>} productNode
 */
export function extractFreeShippingFromListingLabels(productNode) {
  if (!productNode || typeof productNode !== 'object') return null;
  const labels = productNode.product_marketing_info?.shipping_labels;
  if (!shippingLabelsIndicateFree(labels)) return null;
  return { price: 0, is_free: true, text: 'Frete grátis' };
}

/**
 * @param {unknown} s
 */
export function normalizeShippingEntry(s) {
  if (!s || typeof s !== 'object') return emptyShipping();
  const o = /** @type {Record<string, unknown>} */ (s);
  const rawPrice = o.price;
  /** @type {number | null} */
  let price;
  if (rawPrice === null) price = null;
  else {
    const n = Number(rawPrice);
    price = Number.isFinite(n) ? n : 0;
  }
  const out = {
    price,
    is_free: Boolean(o.is_free),
    text: String(o.text ?? 'unknown'),
    original_price: /** @type {number | null} */ (null),
    delivery_name: '',
    shipping_type: '',
    delivery_min_days: /** @type {number | null} */ (null),
    delivery_max_days: /** @type {number | null} */ (null),
  };
  const op = o.original_price ?? o.originalPrice;
  if (op != null && op !== '') {
    const n = Number(op);
    if (Number.isFinite(n)) out.original_price = n;
  }
  const dn = o.delivery_name ?? o.deliveryName;
  if (dn != null && String(dn).trim()) out.delivery_name = String(dn).trim();
  const st = o.shipping_type ?? o.shippingType;
  if (st != null && String(st).trim()) out.shipping_type = String(st).trim();

  const dmin = o.delivery_min_days ?? o.deliveryMinDays;
  if (dmin != null && dmin !== '') {
    const n = Number(dmin);
    if (Number.isFinite(n)) out.delivery_min_days = n;
  }
  const dmax = o.delivery_max_days ?? o.deliveryMaxDays;
  if (dmax != null && dmax !== '') {
    const n = Number(dmax);
    if (Number.isFinite(n)) out.delivery_max_days = n;
  }
  return out;
}

/**
 * Heurística na PDP quando o JSON não traz `real_price_desc`: texto visível na página.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function extractPdpShippingDom(page) {
  const raw = await page
    .evaluate(() => {
      /** @param {string} t */
      function clean(t) {
        return String(t || '')
          .replace(/\s+/g, ' ')
          .replace(/[\u200b\u00a0]/g, '')
          .trim();
      }

      const noise = /cookie|privacidade|termos|tiktok shop|baixar|download|menu|footer|newsletter/i;
      const candidates = [];

      /** @param {string} t */
      function consider(t) {
        const s = clean(t);
        if (s.length < 6 || s.length > 180) return;
        if (noise.test(s)) return;
        if (!/frete|envio|entrega|shipping|delivery/i.test(s)) return;
        if (!/grátis|gratis|free|R\$|reais|calcul|a partir|prazo|dia|business/i.test(s)) return;
        candidates.push(s);
      }

      const roots = document.querySelectorAll(
        'main, [class*="product" i], [class*="shipping" i], [class*="logistic" i], [class*="delivery" i], [data-e2e*="shipping" i], [data-e2e*="logistic" i]'
      );
      const seen = new Set();
      for (const root of roots) {
        root.querySelectorAll('span, div, p, li, strong, a').forEach((el) => {
          const t = clean(el.textContent || '');
          if (!t || t.length > 200) return;
          const k = t.toLowerCase();
          if (seen.has(k)) return;
          seen.add(k);
          consider(t);
        });
      }

      if (!candidates.length) return null;

      candidates.sort((a, b) => {
        const sa = scoreShippingLine(a);
        const sb = scoreShippingLine(b);
        if (sb !== sa) return sb - sa;
        return a.length - b.length;
      });
      /** @param {string} s */
      function scoreShippingLine(s) {
        const x = s.toLowerCase();
        let sc = 0;
        if (/grátis|gratis|free|sem\s+frete/i.test(x)) sc += 4;
        if (/R\$\s*[\d]/.test(s)) sc += 3;
        if (/frete/i.test(x)) sc += 2;
        if (/entrega|envio|delivery|prazo|dia/i.test(x)) sc += 1;
        return sc;
      }

      const pick = candidates[0];
      const lower = pick.toLowerCase();
      const isFree =
        /grátis|gratis|free\s+shipping|sem\s+frete|frete\s+gr|envio\s+gr/i.test(lower) ||
        /\bgrátis\b|\bgratis\b/i.test(pick);
      let price = null;
      const m = pick.match(/R\$\s*([\d]{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}|\d+(?:[.,]\d{1,2})?)/);
      if (m) {
        const n = Number(m[1].replace(/\./g, '').replace(',', '.'));
        if (Number.isFinite(n)) price = n;
      }
      return {
        text: pick,
        is_free: Boolean(isFree),
        price: isFree ? 0 : price,
      };
    })
    .catch(() => null);

  if (!raw || typeof raw !== 'object') return null;
  const o = /** @type {Record<string, unknown>} */ (raw);
  const text = String(o.text ?? '').trim();
  if (!text) return null;
  return {
    text,
    is_free: Boolean(o.is_free),
    price: o.price === 0 ? 0 : o.price != null ? Number(o.price) : null,
    original_price: null,
    delivery_name: '',
    shipping_type: '',
  };
}

export function mergeShippingPreferComplete(prev, inc) {
  const a = normalizeShippingEntry(prev);
  const b = normalizeShippingEntry(inc);
  /** @type {ReturnType<typeof normalizeShippingEntry>} */
  let result;
  if (b.price === null && String(b.text) === 'unknown') {
    if (shippingHasMeaningfulData(a)) result = { ...a };
    else result = { ...a, ...b };
  } else if (b.text && b.text !== 'unknown') {
    result = { ...a, ...b };
  } else if (b.is_free) {
    result = { ...a, ...b, is_free: true };
  } else if (b.delivery_name || b.shipping_type || b.original_price != null) {
    result = { ...a, ...b };
  } else {
    result = a;
  }
  result.delivery_min_days =
    b.delivery_min_days != null ? b.delivery_min_days : a.delivery_min_days;
  result.delivery_max_days =
    b.delivery_max_days != null ? b.delivery_max_days : a.delivery_max_days;
  return result;
}
