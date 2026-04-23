/**
 * Só aceita padrão visível tipo "851 vendido(s)", "0 vendido(s)", "1,3K+ vendido(s)".
 * Rejeita blocos com preço/ruído (ex. R$) e textos muito longos.
 *
 * @param {string | null | undefined} s0
 * @returns {boolean}
 */
export function pdpVendidoVisiblePhraseLooksConfident(s0) {
  const s = String(s0 || '')
    .replace(/[\u00a0\u202f\u200b]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || s.length > 200) return false;
  if (/R\$\s*[\d.,]/i.test(s)) return false;
  if (/%/i.test(s) && s.length > 40) return false;
  if (!/vendidos?(?:\([^)]*\))?/i.test(s)) return false;
  // 0, 3, 851, 1.2K, 1,2K, 1.200 (milhor BR), 20,1K
  return /(?:^|[\s(])(0|(?:[0-9]+[.,]\d+[KkMm]|[0-9]+[KkMm]|[1-9]\d{0,2}(?:\.\d{3})*|[0-9]{1,7}))\s*\+?\s*vendidos?(?:\([^)]*\))?/i.test(
    s
  );
}

/**
 * Converte texto visível (PDP / vitrine) em quantidade de vendas.
 * Ex.: "1.3K vendido(s)" → 1300, "72" → 72, "2M" → 2_000_000
 *
 * @param {string | null | undefined} text
 * @returns {number | null}
 */

export function parseSoldCountFromDisplayText(text) {
  if (text == null) return null;
  const s0 = String(text).trim();
  if (!s0) return null;

  const mBefore = s0.match(
    /([\d.,]+[KkMmBb]?)\s*\+?\s*(?:vendidos?(?:\([^)]*\))?|vendidas?|sales?|sold)\b/i
  );
  if (mBefore) {
    const n = magnitudeTokenToInt(mBefore[1]);
    if (n != null) return n;
  }
  const mAfter = s0.match(
    /\b(?:vendidos?(?:\([^)]*\))?|vendidas?|sales?|sold)\s*[:·\-]?\s*([\d.,]+[KkMmBb]?)(?:\b|(?![\d.,]))/i
  );
  if (mAfter) {
    const n = magnitudeTokenToInt(mAfter[1]);
    if (n != null) return n;
  }
  const mScale = s0.match(/(?:^|[^\d])([\d.,]+)\s*([KkMmBb])\b/);
  if (mScale) {
    const n = magnitudeTokenToInt(mScale[1] + mScale[2]);
    if (n != null) return n;
  }
  if (!/R\s*\$|%-?/i.test(s0) && /^\d{1,12}$/.test(s0.replace(/\s/g, ''))) {
    return parseInt(s0.replace(/\s/g, ''), 10);
  }
  return null;
}

/**
 * A PDP pode ter vários nós com "vendido(s)" (ex.: variante vs total do produto).
 * Deduplica textos, faz parse de cada um e escolhe o maior valor.
 * Se existir algum valor > 0, ignora entradas com 0 (evita “0 vendido(s)” quando há “10.2K vendido(s)”).
 *
 * @param {readonly (string | null | undefined)[]} rawCandidates
 * @returns {{
 *   candidates: { text: string; value: number | null }[];
 *   best: { text: string; value: number } | null;
 *   winningText: string;
 *   count: number | null;
 *   texts: string[];
 *   parsed: (number | null)[];
 *   selected: number | null;
 * }}
 */
export function pickMaxSoldFromVendidoTexts(rawCandidates) {
  const seen = new Set();
  /** @type {string[]} */
  const list = [];
  for (const x of rawCandidates || []) {
    const t = String(x ?? '').trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    list.push(t);
  }
  if (!list.length) {
    return {
      candidates: [],
      best: null,
      winningText: '',
      count: null,
      texts: [],
      parsed: [],
      selected: null,
    };
  }
  /** @type {{ text: string; value: number | null }[]} */
  const candidates = list.map((text) => ({
    text,
    value: parseSoldCountFromDisplayText(text),
  }));
  let pool = candidates.filter((c) => {
    if (c.value == null) return false;
    const n = Number(c.value);
    return Number.isFinite(n) && !Number.isNaN(n);
  });
  /** @type {{ text: string; value: number }[]} */
  pool = pool.map((c) => ({ text: c.text, value: /** @type {number} */ (c.value) }));
  if (pool.some((c) => c.value > 0)) {
    pool = pool.filter((c) => c.value > 0);
  }
  /** @type {{ text: string; value: number } | null} */
  let best = null;
  if (pool.length) {
    const sorted = [...pool].sort((a, b) => b.value - a.value);
    const w = sorted[0];
    if (w) {
      best = { text: w.text, value: Math.max(0, Math.floor(w.value)) };
    }
  }

  const winningText = best ? best.text : list[0];
  const count = best ? best.value : null;
  const parsed = candidates.map((c) => c.value);

  return {
    candidates,
    best,
    winningText,
    count,
    texts: list,
    parsed,
    selected: count,
  };
}

/**
 * Mesma ordem de `rawCandidates` (já deves ter escopo local, ex. cima do título primeiro).
 * Primeiro parse com `parseSoldCountFromDisplayText` != null; não compara tamanhos entre candidatos.
 *
 * @param {readonly (string | null | undefined)[]} rawCandidates
 * @returns {{
 *   candidates: { text: string; value: number | null }[];
 *   best: { text: string; value: number } | null;
 *   winningText: string;
 *   count: number | null;
 *   texts: string[];
 *   parsed: (number | null)[];
 *   selected: number | null;
 * }}
 */
export function pickFirstValidSoldFromVendidoTexts(rawCandidates) {
  const seen = new Set();
  /** @type {string[]} */
  const list = [];
  for (const x of rawCandidates || []) {
    const t = String(x ?? '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    list.push(t);
  }
  if (!list.length) {
    return {
      candidates: [],
      best: null,
      winningText: '',
      count: null,
      texts: [],
      parsed: [],
      selected: null,
    };
  }
  /** @type {{ text: string; value: number | null }[]} */
  const candidates = list.map((text) => ({
    text,
    value: parseSoldCountFromDisplayText(text),
  }));
  const parsed = candidates.map((c) => c.value);
  for (const c of candidates) {
    if (c.value == null) continue;
    const n = Number(c.value);
    if (!Number.isFinite(n) || n < 0) continue;
    const v = Math.max(0, Math.floor(n));
    return {
      candidates,
      best: { text: c.text, value: v },
      winningText: c.text,
      count: v,
      texts: list,
      parsed,
      selected: v,
    };
  }
  return {
    candidates,
    best: null,
    winningText: list[0] || '',
    count: null,
    texts: list,
    parsed,
    selected: null,
  };
}

/**
 * Parse de um token tipo "1.3K", "1,3K", "2M", "10".
 * @param {string} token
 * @returns {number | null}
 */
function magnitudeTokenToInt(/** @type {string} */ token) {
  const s0 = String(token).trim();
  if (!s0) return null;
  // "45.5K" (sufixo colado) vs "1.3" + "K" separado
  const m = s0.match(/^([\d.,]+)\s*([KkMmBb])?$/i) || s0.match(/^([\d.,]+)([KkMmBb])$/i);
  if (!m) return null;
  const numS = m[1];
  let suf = (m[2] || '').toLowerCase();
  if (!suf) {
    const t = s0.match(/[KkMmBb](?![a-z])/i);
    if (t) suf = t[0].toLowerCase();
  }
  let n0;
  if (suf) {
    if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(numS)) {
      n0 = parseFloat(numS.replace(/\./g, '').replace(',', '.'));
    } else if (/^\d+,\d{1,2}$/.test(numS) && (numS.match(/\./g) || []).length === 0) {
      n0 = parseFloat(numS.replace(',', '.'));
    } else {
      n0 = parseFloat(numS.replace(/\.(?=\d{3})/g, '').replace(/,/g, '.') || '0') || 0;
    }
  } else {
    n0 = parseFloat(numS.replace(/[^\d.]/g, ''));
  }
  if (!Number.isFinite(n0) || n0 < 0) return null;
  const mult = suf === 'k' ? 1000 : suf === 'm' ? 1_000_000 : suf === 'b' ? 1_000_000_000 : 1;
  return Math.floor(n0 * mult);
}
