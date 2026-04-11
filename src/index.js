import path from 'node:path';
import { config } from './config.js';
import { launchBrowser } from './browser.js';
import { NetworkSniffer } from './networkSniffer.js';
import { DataStore } from './dataStore.js';
import { findCategoryUrlByName } from './categoryNav.js';
import { collectCategoryUrlsFromSitemapPage } from './sitemap.js';
import { extractTaxonomyPath } from './taxonomy.js';
import {
  collectPdpLinks,
  expandViewMoreUntilDone,
  extractProductIdFromPdpUrl,
  scrollListingToLoadProducts,
} from './listingExpand.js';
import { scrapeProductDetail } from './pdpScrape.js';
import { sleep, randomBetween } from './util.js';

async function waitManualLogin(page) {
  console.info(
    `[login] Conclua o acesso no navegador (recomendado: QR code). Aguardando ${config.manualLoginWaitMs} ms...`
  );
  await sleep(config.manualLoginWaitMs);
}

async function tryEmailPasswordLogin(page) {
  if (!config.tryPasswordLogin || !config.tiktokEmail || !config.tiktokPassword) return;

  console.warn(
    '[login] Login por e-mail/senha é frágil; se falhar, use QR + USER_DATA_DIR no .env.'
  );

  const emailSel =
    'input[name="username"], input[type="text"], input[autocomplete="username"]';
  const passSel = 'input[type="password"]';

  try {
    await page.waitForSelector(emailSel, { timeout: 15_000 });
    await page.click(emailSel, { clickCount: 3 });
    await page.type(emailSel, config.tiktokEmail, { delay: 40 });
    await page.waitForSelector(passSel, { timeout: 10_000 });
    await page.click(passSel, { clickCount: 3 });
    await page.type(passSel, config.tiktokPassword, { delay: 40 });

    const btn = await page.$('button[type="submit"]');
    if (btn) await btn.click();
  } catch (e) {
    console.warn('[login] Automação de formulário não concluída:', e?.message || e);
  }
}

function labelFromUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname || url;
  } catch {
    return url;
  }
}

async function resolveCategoryLabel(page, url) {
  const fromDom = await page
    .evaluate(() => {
      const h1 = document.querySelector('h1');
      if (h1?.textContent?.trim()) return h1.textContent.trim();
      const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
      if (og?.trim()) return og.trim();
      const t = document.title?.trim();
      return t || '';
    })
    .catch(() => '');

  if (fromDom) {
    return fromDom
      .replace(/\s*[\|\u2013\-]\s*TikTok\s*Shop.*$/i, '')
      .replace(/\s*[\|\u2013\-]\s*TikTok.*$/i, '')
      .trim()
      .slice(0, 400);
  }

  try {
    const u = new URL(url);
    if (/\/pdp\//i.test(u.pathname)) return '';
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1] || '';
    if (last && !/^\d+$/.test(last)) {
      return decodeURIComponent(last.replace(/-/g, ' ')).slice(0, 400);
    }
  } catch {
    /* ignore */
  }

  return labelFromUrl(url);
}

/**
 * Monta fila: sitemap (se configurado) + URLs explícitas + resolução por nome no hub.
 * @param {import('puppeteer').Page} page
 */
async function buildCategoryUrlQueue(page) {
  const urls = [...config.categoryUrls];

  if (config.sitemapUrl) {
    console.info(`[sitemap] coletando categorias em ${config.sitemapUrl}`);
    try {
      const fromMap = await collectCategoryUrlsFromSitemapPage(page, config.sitemapUrl);
      urls.push(...fromMap);
      console.info(`[sitemap] ${fromMap.length} links encontrados.`);
    } catch (e) {
      console.warn('[sitemap] falha ao ler sitemap:', e?.message || e);
    }
  }

  const namesToResolve =
    config.categoryNames.length > 0
      ? config.categoryNames
      : config.categoryUrls.length > 0 || config.sitemapUrl
        ? []
        : ['Womenswear & Underwear'];

  for (const name of namesToResolve) {
    const u = await findCategoryUrlByName(page, config.categoryHubUrl, name);
    if (u) {
      urls.push(u);
      console.info(`[categoria] resolvido "${name}" → ${u}`);
    } else {
      console.warn(`[categoria] não encontrei link no hub para: "${name}"`);
    }
  }

  const uniq = [...new Set(urls)];
  if (!uniq.length) {
    console.warn('[categoria] fila vazia; usando CATEGORY_HUB_URL.');
    uniq.push(config.categoryHubUrl.split('#')[0]);
  }
  return uniq;
}

/**
 * 1) Scroll + View more na listagem
 * 2) Coleta todas as URLs de PDP num array (ordem estável)
 * 3) Visita cada URL com page.goto (sem clicar/voltar)
 * 4) Repete com refresh até não haver SKUs novos
 * 5) Salva planilha ao final da categoria (incremental)
 */
async function scrapeCategoryWithPdpFlow(page, categoryUrl, sniffer, store) {
  const scrapedIds = new Set();
  let stagnantPasses = 0;

  const expandOpts = {
    maxClicks: config.viewMoreMaxClicks,
    settleMs: 2500,
    noGrowthLimit: 4,
  };

  try {
    while (stagnantPasses < config.categoryStagnantPasses) {
      await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await sleep(randomBetween(2000, 4000));

      const catLabel = (await resolveCategoryLabel(page, categoryUrl)) || labelFromUrl(categoryUrl);
      const taxonomyBase = (await extractTaxonomyPath(page, catLabel)) || catLabel;
      sniffer.categoriaPaiAtual = taxonomyBase;

      console.info(`[listagem] scroll + carregamento… (${taxonomyBase.slice(0, 80)})`);
      await scrollListingToLoadProducts(page, {
        maxRounds: config.listScrollMaxRounds,
        idleLimit: config.listScrollIdleLimit,
      });

      console.info('[listagem] expandindo "View more" até esgotar…');
      await expandViewMoreUntilDone(page, expandOpts);

      /** @type {string[]} Array estável com todas as URLs de produto visíveis (evita reordenação do grid). */
      const productUrls = await collectPdpLinks(page);

      const pending = [];
      for (const link of productUrls) {
        const id = extractProductIdFromPdpUrl(link);
        if (!id) continue;
        if (scrapedIds.has(id)) continue;
        pending.push({ link, id });
      }

      console.info(
        `[listagem] ${productUrls.length} URLs coletadas; ${pending.length} novas nesta sessão de categoria (já visitados: ${scrapedIds.size}).`
      );

      if (pending.length === 0) {
        stagnantPasses += 1;
        console.info(
          `[listagem] nenhuma URL nova (ociosa ${stagnantPasses}/${config.categoryStagnantPasses}); recarregando…`
        );
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
        await sleep(randomBetween(2000, 3500));
        sniffer.categoriaPaiAtual = taxonomyBase;
        await scrollListingToLoadProducts(page, {
          maxRounds: config.listScrollMaxRounds,
          idleLimit: config.listScrollIdleLimit,
        });
        await expandViewMoreUntilDone(page, expandOpts);
        const links2 = await collectPdpLinks(page);
        let anyNew = false;
        for (const link of links2) {
          const id = extractProductIdFromPdpUrl(link);
          if (id && !scrapedIds.has(id)) {
            anyNew = true;
            break;
          }
        }
        if (!anyNew) continue;
        stagnantPasses = 0;
        continue;
      }

      stagnantPasses = 0;

      for (const { link, id } of pending) {
        try {
          sniffer.categoriaPaiAtual = taxonomyBase;
          const row = await scrapeProductDetail(page, link, taxonomyBase, sniffer);
          const sku = String(row.sku || id);
          scrapedIds.add(sku);

          const stats = store.upsertMany([{ ...row, sku }]);
          if (stats.added > 0 || stats.updated > 0) await store.writeAll();

          console.info(
            `[pdp] ok sku=${sku} +${stats.added} ~${stats.updated} | ${(row.nome || '').slice(0, 48)}`
          );
        } catch (e) {
          console.error(`[pdp] erro ao processar ${link}:`, e?.message || e);
        }

        await sleep(randomBetween(config.pdpDelayMinMs, config.pdpDelayMaxMs));
      }
    }

    console.info(
      `[categoria] finalizada: ${categoryUrl} (SKUs únicos visitados nesta execução: ${scrapedIds.size})`
    );
  } finally {
    console.info('[persistência] salvando planilha após categoria…');
    await store.writeAll().catch((e) => console.error('[persistência] falha ao gravar:', e));
  }
}

async function main() {
  const outPath = path.resolve(config.outputFile);
  const store = await DataStore.create(outPath);
  console.info(`[planilha] formato: ${store.format} | SKUs já carregados: ${store.bySku.size} | arquivo: ${outPath}`);

  const { browser, userAgent } = await launchBrowser();
  console.info('[browser] User-Agent:', userAgent);

  const page = await browser.newPage();
  await page.setUserAgent(userAgent);
  await page.setViewport({ width: 1366, height: 768 });

  const sniffer = new NetworkSniffer(page, config.apiUrlIncludes);
  sniffer.attach();

  await page.goto(config.startUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await tryEmailPasswordLogin(page);
  await waitManualLogin(page);

  const categoryQueue = await buildCategoryUrlQueue(page);
  console.info(`[fila] ${categoryQueue.length} categorias na ordem.`);

  for (let i = 0; i < categoryQueue.length; i += 1) {
    const url = categoryQueue[i];
    sniffer.resetForNewCategory();
    console.info(`\n=== Categoria ${i + 1}/${categoryQueue.length}: ${url} ===`);

    try {
      await scrapeCategoryWithPdpFlow(page, url, sniffer, store);
    } catch (e) {
      console.error(`[erro] categoria ${url}:`, e?.message || e);
      await store.writeAll().catch(() => {});
    }

    if (i < categoryQueue.length - 1) {
      const pause = randomBetween(config.categoryDelayMinMs, config.categoryDelayMaxMs);
      console.info(`[delay] pausa ${pause} ms antes da próxima categoria.`);
      await sleep(pause);
    }
  }

  await browser.close();
  console.info('[fim] Arquivo:', outPath);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
