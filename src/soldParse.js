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
 * Parse de um token tipo "1.3K", "1,3K", "2M", "10".
 * @param {string} token
 * @returns {number | null}
 */
function magnitudeTokenToInt(/** @type {string} */ token) {
  const s = String(token).trim();
  if (!s) return null;
  const m = s.match(/([\d.,]+)\s*([KkMmBb])?/i);
  if (!m) return null;
  const numS = m[1];
  const suf = (m[2] || '').toLowerCase();
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
