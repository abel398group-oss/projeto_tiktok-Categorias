/** Frete em listagem / PDP (mínimo compatível com produtos.json de referência). */

export function emptyShipping() {
  return {
    price: null,
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
  if (rawPrice === null || rawPrice === undefined) price = null;
  else {
    const n = Number(rawPrice);
    price = Number.isFinite(n) ? n : null;
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
 * @param {string} token
 * @returns {number | null}
 */
function parseBrlMoneyToken(token) {
  const g = String(token).trim();
  if (/^\d{1,3}(?:\.\d{3})+,\d{2}$/.test(g)) {
    return parseFloat(g.replace(/\./g, '').replace(',', '.'));
  }
  if (/^\d+,\d{1,2}$/.test(g)) {
    return parseFloat(g.replace(',', '.'));
  }
  if (/^\d+\.\d{1,2}$/.test(g)) {
    return parseFloat(g);
  }
  if (/^\d{1,3}(?:\.\d{3})+$/.test(g)) {
    return parseFloat(g.replace(/\./g, ''));
  }
  if (/^\d+$/.test(g)) {
    return parseInt(g, 10);
  }
  return null;
}

/**
 * Interpreta um texto bruto de frete exibido na PDP (não o router).
 * @param {string} raw
 * @returns {{ text: string; price: number; is_free: boolean } | null}
 */
export function parsePdpShippingLine(raw) {
  const s0 = String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u200b\u00a0]/g, '')
    .trim();
  if (s0.length < 4 || s0.length > 32_000) return null;
  const lower = s0.toLowerCase();
  if (!/frete|entrega|envio|shipping|delivery|gr[áa]tis|gratis|free/.test(lower)) {
    return null;
  }
  const noise = /cookie|privacidade|termos|newsletter|baixe o app|baixar app/i;
  if (noise.test(lower)) return null;

  // Valor: preferir padrão "Frete/Entrega ... R$ X"; senão R$ genérico só se o texto for claramente de frete
  let m = s0.match(
    /(?:^|[\s(])(?:frete|entrega|envio|shipping|delivery)\s*R\$\s*([\d]{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}|\d+(?:[.,]\d{1,2})?)(?![\d.,])/i
  );
  if (!m) {
    const m2 = s0.match(
      /R\$\s*([\d]{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}|\d+(?:[.,]\d{1,2})?)(?![\d.,0-9])/i
    );
    if (m2 && /(?:frete|entrega|envio|shipping|delivery|pedido|neste pedido|para o)/i.test(s0)) {
      m = m2;
    }
  }
  if (m) {
    const n = parseBrlMoneyToken(m[1] ?? '');
    if (n == null || !Number.isFinite(n) || n < 0) return null;
    if (n === 0) {
      return { text: s0, price: 0, is_free: true };
    }
    return { text: s0, price: n, is_free: false };
  }

  if (
    /(?:^|\b)(?:frete|entrega|envio|shipping|delivery)\s+gr[áa]tis\b/i.test(s0) ||
    (/\bgr[áa]tis\b|\bgratis\b|free\s+shipping|sem\s+custo\s+de\s+entrega|envio\s+gr[áa]tis|entrega\s+gr[áa]tis/i.test(
      s0
    ) &&
      /frete|entrega|envio|shipping|delivery/i.test(lower))
  ) {
    return { text: s0, price: 0, is_free: true };
  }
  if (/^free shipping$/i.test(s0.trim()) || /^\s*free shipping\s*$/i.test(s0)) {
    return { text: s0, price: 0, is_free: true };
  }
  return null;
}

/**
 * @param {{ text: string; price: number; is_free: boolean } | null} p
 * @param {string} original
 */
function scorePdpShippingParse(p, original) {
  if (!p) return -1;
  let sc = 0;
  const t = String(original);
  if (/^frete\s+R\$/i.test(t) || /^entrega.*R\$/i.test(t)) sc += 40;
  if (/\bfrete\s+R\$/i.test(t)) sc += 30;
  if (t.length <= 100) sc += 20;
  if (t.length <= 50) sc += 10;
  if (p.is_free && p.price === 0) sc += 25;
  if (p.is_free) sc += 5;
  if (typeof p.price === 'number' && p.price > 0) sc += 15;
  if (/^frete\s+gr[áa]tis/i.test(t) || /^entrega\s+gr[áa]tis/i.test(t)) sc += 15;
  return sc;
}

/**
 * @param {string[]} dedup
 */
function pickBestPdpShippingFromDedup(dedup) {
  /** @type {{ parse: { text: string; price: number; is_free: boolean }; score: number; text: string }[]} */
  const withScore = [];
  for (const text of dedup) {
    const p = parsePdpShippingLine(text);
    if (!p) continue;
    withScore.push({
      text: p.text,
      parse: p,
      score: scorePdpShippingParse(p, text),
    });
  }
  if (!withScore.length) return { selected: null, candidates: [] };
  withScore.sort((a, b) => b.score - a.score);
  return { selected: withScore[0] ?? null, candidates: withScore };
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string} productUrl
 * @param {string} winningText
 */
export async function logPdpShippingSelectedHtml(page, productUrl, winningText) {
  const t = String(winningText || '').replace(/\s+/g, ' ').trim();
  const product_url = String(productUrl || '').trim() || '(unknown)';
  if (!t || !page) {
    console.log('[shipping selected html]', { product_url, html: null });
    return;
  }
  const html = await page
    .evaluate((target) => {
      const norm = (s) => (s && String(s).replace(/\s+/g, ' ').trim()) || '';
      const tgt = String(target).replace(/\s+/g, ' ').trim();
      for (const el of document.querySelectorAll('*')) {
        if (norm(/** @type {Element} */ (el).innerText) === tgt) {
          return /** @type {Element} */ (el).outerHTML || null;
        }
      }
      return null;
    }, t)
    .catch(() => null);
  console.log('[shipping selected html]', {
    product_url,
    html: html && String(html).length > 0 ? String(html) : null,
  });
}

/**
 * Lê frete a partir do DOM visível da PDP (prioridade frente ao router). Textos "unknown" reais: price = null.
 * @param {import('puppeteer').Page} page
 * @param {string} [productUrl]
 * @returns {Promise<ReturnType<typeof normalizeShippingEntry> | null>}
 */
export async function extractPdpShippingDom(page, productUrl = '(unknown)') {
  const product_url = String(productUrl || '').split('#')[0] || '(unknown)';

  const pack = await page
    .evaluate(() => {
      const MAX = 20_000;
      const raw = /** @type {string[]} */ ([]);
      const noise = (t) => /cookie|privacidade|termos|newsletter|baixe o app|tiktok shop app/i.test(t);
      for (const el of document.querySelectorAll('*')) {
        if (!el || el.innerText == null) continue;
        const t = String(el.innerText).replace(/\s+/g, ' ').replace(/[\u200b\u00a0]/g, '').trim();
        if (!t || t.length < 4 || t.length > MAX) continue;
        if (noise(t)) continue;
        const l = t.toLowerCase();
        if (!/frete|entrega|gr[áa]tis|gratis|shipping|delivery|envio/.test(l)) continue;
        raw.push(t);
      }
      const seen = new Set();
      const dedup = /** @type {string[]} */ ([]);
      for (const t of raw) {
        if (seen.has(t)) continue;
        seen.add(t);
        dedup.push(t);
      }
      // Diagnóstico amplo (não altera `raw` / `dedup` usados no parse)
      const allTexts = Array.from(document.querySelectorAll('*'))
        .map((el) => (el && el.innerText != null ? String(el.innerText).replace(/\s+/g, ' ').trim() : ''))
        .filter(Boolean)
        .map((t) => (t.length > MAX ? t.slice(0, MAX) : t))
        .filter((text) => {
          const s = text.toLowerCase();
          return (
            s.includes('frete') ||
            s.includes('grátis') ||
            s.includes('gratis') ||
            s.includes('entrega') ||
            s.includes('shipping') ||
            /R\$/i.test(text)
          );
        });
      return { raw, dedup, allTexts };
    })
    .catch(() => null);

  if (!pack || typeof pack !== 'object') {
    return null;
  }
  const dedup = Array.isArray(pack.dedup) ? pack.dedup : [];
  const texts = Array.isArray(pack.allTexts) ? pack.allTexts : [];

  console.log('[shipping raw texts]', texts);

  const { selected, candidates } = pickBestPdpShippingFromDedup(dedup);
  const candidatesLog = candidates.map((c) => ({
    text: c.text,
    price: c.parse.price,
    is_free: c.parse.is_free,
    score: c.score,
  }));
  console.log('[shipping candidates]', { product_url, candidates: candidatesLog });
  console.log('[shipping selected]', {
    product_url,
    selected: selected
      ? { text: selected.text, score: selected.score, parse: selected.parse }
      : null,
  });

  if (!selected) {
    await logPdpShippingSelectedHtml(page, product_url, '');
    return null;
  }

  const p = selected.parse;
  if (!p.is_free && (p.price == null || !Number.isFinite(p.price))) {
    return null;
  }
  if (!p.is_free && p.price < 0) {
    return null;
  }

  await logPdpShippingSelectedHtml(page, product_url, p.text);

  return {
    text: p.text,
    is_free: p.is_free,
    price: p.is_free ? 0 : p.price,
    original_price: null,
    delivery_name: '',
    shipping_type: '',
    delivery_min_days: null,
    delivery_max_days: null,
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
