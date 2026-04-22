/**
 * Amostra aleatória de itens de master_category_snapshots.json, abre cada PDP
 * e compara preço, título, loja e vendas (heurística no texto visível).
 *
 * Uso: node src/verifySnapshotPdp.js
 * Env: VERIFY_SAMPLE_N=10, MASTER_SNAPSHOT_OUTPUT_JSON=path, HEADLESS=true
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from './config.js';
import { launchBrowser } from './browser.js';
import { waitIfCaptchaBlocking } from './captchaWait.js';
import { sleep } from './util.js';

const SAMPLE_N = Math.min(25, Math.max(1, Number(process.env.VERIFY_SAMPLE_N) || 10));
const JSON_PATH = path.resolve(config.masterSnapshotOutputJson);
const PDP_LOAD_MS = Number(process.env.VERIFY_PDP_TIMEOUT_MS) || 90_000;
const GAP_BETWEEN_MS = Number(process.env.VERIFY_PDP_GAP_MS) || 2500;

/**
 * @param {string} s
 * @param {string} t
 */
function nameSimilarity(s, t) {
  const a = s.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
  const b = t.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
  if (a.length < 3 || b.length < 3) return 0;
  if (a.includes(b.slice(0, 30)) || b.includes(a.slice(0, 30))) return 0.9;
  let o = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) o += 1;
  }
  return o / Math.max(a.length, b.length);
}

/**
 * @param {string} pdpText
 */
function parseBrMoneyFromString(pdpText) {
  const s = pdpText.replace(/[\u00a0\u202f]/g, ' ');
  const moneys = [];
  for (const m of s.matchAll(/R\$\s*([\d.,]+)/gi)) {
    const raw = m[1];
    let t = raw;
    if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^\d+,\d{1,2}$/.test(t) && !/^\d{1,3}\.\d{1,2}$/.test(t)) t = t.replace(',', '.');
    else t = t.replace(/\./g, '');
    const n = parseFloat(t);
    if (Number.isFinite(n) && n > 0 && n < 1_000_000) moneys.push(n);
  }
  if (moneys.length === 0) return { current: null, original: null, all: [] };
  const u = [...new Set(moneys.map((x) => Math.round(x * 100) / 100))].sort((a, b) => a - b);
  if (u.length === 1) return { current: u[0], original: null, all: u };
  return { current: u[0], original: u[u.length - 1], all: u };
}

/**
 * @param {string} text
 */
function parseSoldFromPdpText(text) {
  const t = text.replace(/\s+/g, ' ');
  const m1 = t.match(/(?:^|[^\d])([\d.,]+[KkMm]?)\s*\+?\s*vendidos?(?:\([^)]*\))?\b/i);
  if (m1) {
    const p = m1[1].replace(/\./g, '').replace(',', '.');
    const n = parseFloat(p);
    if (/\d+,\d+K/i.test(m1[0] + m1[1])) {
      const km = t.match(/([\d.,]+)\s*([Kk])\s*vendido/i);
      if (km) {
        const v = parseFloat(km[1].replace(/\./g, '').replace(',', '.'));
        return km[2].toLowerCase() === 'k' ? Math.floor(v * 1000) : Math.floor(v);
      }
    }
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  const m2 = t.match(/\bvendidos?(?:\([^)]*\))?\s*[:·\-]?\s*([\d.,]+[KkMm]?)/i);
  if (m2) {
    const p = m2[1].replace(/[^\d.]/g, '');
    const n = parseInt(p, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * @param {import('puppeteer').Page} page
 */
async function extractPdpSnapshot(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main') || document.body;
    const text = (main && main.innerText) || '';
    const h1 = document.querySelector('h1');
    const title = (h1 && h1.innerText) || '';
    const storeA = document.querySelector('a[href*="/store/"]');
    const shop = storeA
      ? String(storeA.textContent || storeA.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ')
          .trim()
      : '';
    return { text: text.slice(0, 12_000), title: title.replace(/\s+/g, ' ').trim().slice(0, 500), shop };
  });
}

/**
 * @param {number} a
 * @param {number} b
 */
function priceClose(a, b) {
  if (a == null || b == null) return { ok: false, reason: 'falta valor' };
  const d = Math.abs(a - b);
  if (d < 0.02) return { ok: true, reason: '≤ R$0,02' };
  if (b > 0 && d / b < 0.02) return { ok: true, reason: '≤ 2% rel.' };
  return { ok: false, reason: `Δ R$${d.toFixed(2)}` };
}

/**
 * @param {unknown[]} items
 * @param {number} n
 */
function pickRandom(items, n) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

async function main() {
  const raw = await fs.readFile(JSON_PATH, 'utf8');
  const data = JSON.parse(raw);
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) {
    console.error('Nenhum item no JSON:', JSON_PATH);
    process.exit(1);
  }
  const sample = pickRandom(items, SAMPLE_N);
  console.error(`[verify] ficheiro: ${JSON_PATH} · total: ${items.length} · amostra: ${sample.length}\n`);

  const { browser } = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  });

  /** @type {Array<Record<string, unknown>>} */
  const results = [];

  try {
    for (let i = 0; i < sample.length; i += 1) {
      const it = sample[i];
      const url = String(it.product_url || '');
      const jsonName = String(it.name || '');
      const jsonPrice = typeof it.price_current === 'number' ? it.price_current : null;
      const jsonOrigin = it.price_original != null ? Number(it.price_original) : null;
      const jsonSold = it.sold_count != null ? Number(it.sold_count) : null;
      const jsonShop = String(it.shop_name || '').trim();
      const pid = String(it.product_id || '');

      /** @type {Record<string, unknown>} */
      const row = {
        i: i + 1,
        product_id: pid,
        product_url: url,
        json: {
          name: jsonName.slice(0, 80) + (jsonName.length > 80 ? '…' : ''),
          price_current: jsonPrice,
          price_original: jsonOrigin,
          sold_count: jsonSold,
          shop: jsonShop,
        },
        pdp: /** @type {Record<string, unknown> | null} */ (null),
        checks: /** @type {Record<string, string>} */ ({}),
        error: null,
      };

      if (!url.includes('/pdp/')) {
        row.error = 'URL inválida';
        results.push(row);
        continue;
      }

      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: PDP_LOAD_MS });
        await waitIfCaptchaBlocking(page, {
          enabled: config.captchaWaitEnabled,
          maxWaitMs: config.captchaMaxWaitMs,
        });
        await sleep(2000);
        const snap = await extractPdpSnapshot(page);
        const fullText = String(snap.text || '');
        const pdp = parseBrMoneyFromString(fullText);
        const pdpTitle = String(snap.title || '');
        const pdpShop = String(snap.shop || '');
        const pdpSold = parseSoldFromPdpText(fullText);

        row.pdp = {
          title: pdpTitle.slice(0, 100),
          price_inferred: pdp.current,
          price_alt_max: pdp.original,
          shop: pdpShop.slice(0, 40),
          sold_parsed: pdpSold,
        };

        const pr = priceClose(jsonPrice, pdp.current);
        row.checks.price = pr.ok ? `OK (${pr.reason})` : `DIF ${pr.reason} · PDP ~${pdp.current ?? '?'}`;

        const sim = nameSimilarity(jsonName, pdpTitle || fullText);
        row.checks.title = sim > 0.45 ? `OK (sim ${(sim * 100).toFixed(0)}%)` : `DIF (sim ${(sim * 100).toFixed(0)}%)`;

        if (jsonShop && pdpShop) {
          const sa = jsonShop.toLowerCase();
          const sb = pdpShop.toLowerCase();
          row.checks.shop = sa.length > 1 && (sb.includes(sa) || sa.includes(sb) || sim > 0.3) ? 'OK' : 'DIF';
        } else {
          row.checks.shop = pdpShop ? 'PDP only' : '—';
        }

        if (jsonSold != null && pdpSold != null) {
          row.checks.sold = jsonSold === pdpSold ? 'OK' : `DIF (JSON ${jsonSold} · PDP ${pdpSold})`;
        } else {
          row.checks.sold = pdpSold != null ? `PDP ${pdpSold} · JSON ${jsonSold ?? '—'}` : '—';
        }
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e);
      }

      results.push(row);
      if (i < sample.length - 1) await sleep(GAP_BETWEEN_MS);
    }
  } finally {
    await browser.close();
  }

  // Saída legível
  for (const r of results) {
    console.log('—'.repeat(72));
    console.log(`#${r.i}  product_id: ${r.product_id}`);
    if (r.error) {
      console.log(`  ERRO: ${r.error}`);
      continue;
    }
    console.log(`  URL: ${r.product_url}`);
    console.log('  JSON (gravação):', JSON.stringify(/** @type {object} */ (r).json));
    if (r.pdp) console.log('  PDP (lido agora):', JSON.stringify(/** @type {object} */ (r).pdp));
    console.log('  Checks:', JSON.stringify(/** @type {object} */ (r).checks, null, 0));
  }
  console.log('—'.repeat(72));
  const okPrice = results.filter((r) => !r.error && String(r.checks?.price).startsWith('OK')).length;
  const n = results.filter((r) => !r.error).length;
  console.log(
    `Resumo: preço ≈ alinhado em ${okPrice}/${n} (PDP heurística; vitrine e PDP podem divergir).`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
