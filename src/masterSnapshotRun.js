/**
 * Snapshots dinâmicos: produtos visíveis no dashboard de cada categoria master.
 * Lê taxonomy de categories.json; grava ficheiro separado (não altera produtos.json).
 *
 * Uso: npm run master-snapshots
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { launchBrowser } from './browser.js';
import { writeFileAtomic, sleep } from './util.js';
import { waitIfCaptchaBlocking } from './captchaWait.js';
import { extractDashboardProductsFromSsr } from './masterSnapshotSsr.js';

/**
 * @param {unknown} raw
 * @returns {Array<{ name: string; url: string }>}
 */
/** @param {string} categoryUrl */
function regionFromCategoryUrl(categoryUrl) {
  const m = String(categoryUrl || '').match(/shop\.tiktok\.com\/([a-z]{2})\//i);
  return m ? m[1].toLowerCase() : 'br';
}

/**
 * Última linha de defesa se ainda vier URL inválida do browser.
 * @param {unknown} url
 * @param {unknown} productId
 * @param {string} categoryUrl
 */
function sanitizeProductUrlOutput(url, productId, categoryUrl) {
  const u = String(url ?? '').trim();
  if (
    u &&
    !u.includes('[object Object]') &&
    !u.includes('%5Bobject%20Object%5D') &&
    /^https:\/\/shop\.tiktok\.com\//i.test(u)
  ) {
    return u.split(/[?#]/)[0];
  }
  const id = String(productId ?? '').replace(/\D/g, '');
  if (id.length < 8) return '';
  const reg = regionFromCategoryUrl(categoryUrl);
  return `https://shop.tiktok.com/${reg}/pdp/${id}`;
}

/**
 * Caminho do JSONL incremental (padrão: mesmo basename que o JSON, extensão `.jsonl`).
 * @param {string} outJsonPath
 * @param {string | null} override
 */
function resolveMasterSnapshotJsonlPath(outJsonPath, override) {
  const t = (override || '').trim();
  if (t) return path.resolve(t);
  const o = String(outJsonPath);
  if (/\.json$/i.test(o)) {
    return o.replace(/\.json$/i, '.jsonl');
  }
  return `${o}.jsonl`;
}

function mastersFromCategoriesJson(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const items = /** @type {Record<string, unknown>} */ (raw).items;
  if (!Array.isArray(items)) return [];
  /** @type {Array<{ name: string; url: string }>} */
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const o = /** @type {Record<string, unknown>} */ (it);
    if (Number(o.level) !== 1) continue;
    const name = String(o.name ?? '').trim();
    const url = String(o.url ?? '').trim();
    if (!name || !url) continue;
    out.push({ name, url });
  }
  return out;
}

async function main() {
  const inputPath = path.resolve(config.masterSnapshotCategoriesJson);
  const outPath = path.resolve(config.masterSnapshotOutputJson);
  const jsonlPath = resolveMasterSnapshotJsonlPath(outPath, config.masterSnapshotOutputJsonl);
  const runId = randomUUID();
  const delayMs = config.masterSnapshotCategoryDelayMs;

  const rawText = await fs.readFile(inputPath, 'utf8');
  const raw = JSON.parse(rawText);
  let masters = mastersFromCategoriesJson(raw);

  const maxN = config.masterSnapshotMaxCategories;
  if (maxN != null && Number.isFinite(maxN) && maxN > 0) {
    masters = masters.slice(0, Math.floor(maxN));
  }

  console.info('[master-snapshots] taxonomy:', inputPath);
  console.info('[master-snapshots] saída:', outPath);
  console.info('[master-snapshots] jsonl (incremental):', jsonlPath);
  console.info('[master-snapshots] run_id:', runId);
  console.info('[master-snapshots] categorias master:', masters.length);
  const maxProductsOut = config.masterSnapshotMaxProducts;
  if (maxProductsOut != null) {
    console.info('[master-snapshots] teto de produtos (MASTER_SNAPSHOT_MAX_PRODUCTS):', maxProductsOut);
  } else {
    console.info('[master-snapshots] teto de produtos: nenhum (ilimitado)');
  }

  /** @type {Record<string, unknown>[]} */
  const items = [];

  const { browser } = await launchBrowser();
  try {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.mkdir(path.dirname(jsonlPath), { recursive: true });
    await fs.writeFile(jsonlPath, '', 'utf8');

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    for (let i = 0; i < masters.length; i += 1) {
      if (maxProductsOut != null && items.length >= maxProductsOut) {
        console.info(
          '[master-snapshots] interrompido: já há',
          items.length,
          'produtos (teto',
          String(maxProductsOut) + ').',
        );
        break;
      }
      const cat = masters[i];
      const snapshotAt = new Date().toISOString();
      console.info(`[master-snapshots] (${i + 1}/${masters.length}) ${cat.name}`);

      await page.goto(cat.url, { waitUntil: 'networkidle2', timeout: 120_000 });
      await waitIfCaptchaBlocking(page, {
        enabled: config.captchaWaitEnabled,
        maxWaitMs: config.captchaMaxWaitMs,
      });
      await sleep(config.masterSnapshotPostLoadSleepMs);

      if (process.env.MASTER_SNAPSHOT_DEBUG_RAW === '1' && i === 0) {
        const rawSample = await page.evaluate(() => {
          const el = document.querySelector('script#__MODERN_ROUTER_DATA__');
          if (!el?.textContent?.trim()) return null;
          try {
            const router = JSON.parse(el.textContent);
            /** @type {unknown} */
            let found = null;
            function walk(o, d) {
              if (d > 20 || found != null) return;
              if (!o || typeof o !== 'object') return;
              const pl = /** @type {Record<string, unknown>} */ (o).productList;
              const pl2 = /** @type {Record<string, unknown>} */ (o).product_list;
              for (const arr of [pl, pl2]) {
                if (Array.isArray(arr) && arr[0] && typeof arr[0] === 'object') {
                  found = arr[0];
                  return;
                }
              }
              for (const k of Object.keys(o)) walk(/** @type {Record<string, unknown>} */ (o)[k], d + 1);
            }
            walk(router, 0);
            return found ? JSON.stringify(found, null, 2) : null;
          } catch {
            return null;
          }
        });
        if (rawSample) {
          console.info('[debug product raw]', rawSample.slice(0, 8000));
        }
      }

      const rows = await extractDashboardProductsFromSsr(page);
      for (const row of rows) {
        if (maxProductsOut != null && items.length >= maxProductsOut) break;
        const r = /** @type {Record<string, unknown>} */ (row);
        const pid = String(r.product_id ?? '');
        const purl = sanitizeProductUrlOutput(r.product_url, pid, cat.url);
        const rec = {
          run_id: runId,
          snapshot_at: snapshotAt,
          source_context: 'master_dashboard',
          category_name: cat.name,
          category_url: cat.url,
          dashboard_rank: r.dashboard_rank ?? null,
          product_id: pid,
          product_url: purl,
          name: r.name ?? '',
          price_current:
            typeof r.price_current === 'number' && isFinite(r.price_current)
              ? r.price_current
              : 0,
          price_original:
            typeof r.price_original === 'number' && isFinite(r.price_original)
              ? r.price_original
              : null,
          discount_percent:
            typeof r.discount_percent === 'number' && isFinite(r.discount_percent)
              ? r.discount_percent
              : null,
          shop_name: String(r.shop_name ?? '').trim(),
          image_main: r.image_main ?? '',
          sold_text: String(r.sold_text ?? '').trim(),
          sold_count:
            typeof r.sold_count === 'number' && isFinite(r.sold_count) ? r.sold_count : null,
          rating: typeof r.rating === 'number' && isFinite(r.rating) ? r.rating : null,
          rating_count:
            typeof r.rating_count === 'number' && isFinite(r.rating_count)
              ? Math.floor(r.rating_count)
              : null,
          rating_distribution:
            r.rating_distribution != null && typeof r.rating_distribution === 'object'
              ? r.rating_distribution
              : null,
        };
        items.push(rec);
        await fs.appendFile(jsonlPath, `${JSON.stringify(rec)}\n`, 'utf8');
        console.log('[jsonl] append ok', { product_id: pid, category_name: cat.name });
      }

      if (i < masters.length - 1 && delayMs > 0) {
        await sleep(delayMs);
      }
    }

    const payload = {
      meta: {
        version: 1,
        updated_at: new Date().toISOString(),
        run_id: runId,
        source_context: 'master_dashboard',
        master_categories_visited: masters.length,
        count: items.length,
      },
      items,
    };

    await writeFileAtomic(outPath, JSON.stringify(payload, null, 2), 'utf8');
    let urlsValidas = 0;
    let shopNamesPreenchidos = 0;
    for (const it of items) {
      const u = String(/** @type {Record<string, unknown>} */ (it).product_url || '');
      if (u.startsWith('https://shop.tiktok.com') && !u.includes('[object Object]')) {
        urlsValidas += 1;
      }
      if (String(/** @type {Record<string, unknown>} */ (it).shop_name || '').trim()) {
        shopNamesPreenchidos += 1;
      }
    }
    console.info('[validação]', {
      urls_validas: urlsValidas,
      shop_names_preenchidos: shopNamesPreenchidos,
      total_linhas: items.length,
    });
    console.info(
      `[master-snapshots] concluído: ${items.length} linhas de produto (${masters.length} masters).`,
    );
    console.info(`[master-snapshots] jsonl: ${jsonlPath} · ${items.length} linha(s) gravada(s).`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('[master-snapshots]', e);
  process.exitCode = 1;
});
