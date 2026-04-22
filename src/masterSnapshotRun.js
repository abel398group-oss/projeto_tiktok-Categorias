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
  console.info('[master-snapshots] run_id:', runId);
  console.info('[master-snapshots] categorias master:', masters.length);

  /** @type {Record<string, unknown>[]} */
  const items = [];

  const { browser } = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    for (let i = 0; i < masters.length; i += 1) {
      const cat = masters[i];
      const snapshotAt = new Date().toISOString();
      console.info(`[master-snapshots] (${i + 1}/${masters.length}) ${cat.name}`);

      await page.goto(cat.url, { waitUntil: 'networkidle2', timeout: 120_000 });
      await waitIfCaptchaBlocking(page, {
        enabled: config.captchaWaitEnabled,
        maxWaitMs: config.captchaMaxWaitMs,
      });
      await sleep(config.masterSnapshotPostLoadSleepMs);

      const rows = await extractDashboardProductsFromSsr(page);
      for (const row of rows) {
        const r = /** @type {Record<string, unknown>} */ (row);
        items.push({
          run_id: runId,
          snapshot_at: snapshotAt,
          source_context: 'master_dashboard',
          category_name: cat.name,
          category_url: cat.url,
          dashboard_rank: r.dashboard_rank ?? null,
          product_id: r.product_id ?? '',
          product_url: r.product_url ?? '',
          name: r.name ?? '',
          price_current:
            typeof r.price_current === 'number' && isFinite(r.price_current)
              ? r.price_current
              : 0,
          shop_name: r.shop_name ?? '',
          image_main: r.image_main ?? '',
        });
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

    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await writeFileAtomic(outPath, JSON.stringify(payload, null, 2), 'utf8');
    console.info(
      `[master-snapshots] concluído: ${items.length} linhas de produto (${masters.length} masters).`,
    );
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('[master-snapshots]', e);
  process.exitCode = 1;
});
