import path from 'node:path';
import { config } from './config.js';
import { RunMetrics, flushRunArtifacts } from './runMetrics.js';
import { launchBrowser } from './browser.js';
import { NetworkSniffer } from './networkSniffer.js';
import { CanonicalJsonStore } from './canonicalJsonStore.js';
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
import { extractSsrListingRows } from './ssrCategoryProducts.js';
import { sleep, randomBetween } from './util.js';

/** @param {import('./canonicalJsonStore.js').CanonicalJsonStore} store */
function isProductCapReached(store) {
  return config.maxProducts != null && store.byId.size >= config.maxProducts;
}

/**
 * Heurística no browser: página carregada, sem ecrã de auth bloqueante, sessão ou vitrine utilizável.
 * @param {import('puppeteer').Page} page
 */
async function probeManualLoginReady(page) {
  try {
    return await page.evaluate(() => {
      const ready = document.readyState === 'complete';
      if (!ready) return { ok: false, reason: 'loading' };

      const href = window.location.href.toLowerCase();
      const path = window.location.pathname.toLowerCase();
      const host = window.location.hostname.toLowerCase();
      const cook = document.cookie || '';

      const cookieVal = (name) => {
        const m = cook.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
        return m ? decodeURIComponent(m[1].trim()) : '';
      };
      const hasSession = ['sessionid', 'sid_tt', 'sid_guard', 'uid_tt', 'sessionid_ss'].some(
        (n) => cookieVal(n).length > 8
      );

      const authUrl =
        /passport|accounts\.google|apple\.com\/auth|enter_from=login|from=login/.test(href) ||
        /\/(login|passport|account\/register)(\/|$)/.test(path);

      const pwd = document.querySelector('input[type="password"]');
      let loginFormBlocking = false;
      if (pwd) {
        const r = pwd.getBoundingClientRect();
        const st = window.getComputedStyle(pwd);
        loginFormBlocking =
          r.width > 2 &&
          r.height > 2 &&
          st.visibility !== 'hidden' &&
          st.display !== 'none' &&
          Number(st.opacity) > 0.05;
      }

      let hasLoginCta = false;
      for (const el of document.querySelectorAll(
        'a[href*="login"], a[href*="passport"], button, [role="button"], [role="link"]'
      )) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (/^log in$|^sign in$|^entrar$|^iniciar sess/.test(t)) {
          hasLoginCta = true;
          break;
        }
      }

      if (authUrl || loginFormBlocking) return { ok: false, reason: 'auth_ui' };
      if (hasSession) return { ok: true, reason: 'session_cookie' };
      if (hasLoginCta) return { ok: false, reason: 'login_cta_visible' };

      return { ok: true, reason: 'page_ready' };
    });
  } catch {
    return { ok: false, reason: 'navigating' };
  }
}

async function waitManualLogin(page) {
  const maxMs = config.manualLoginWaitMs;
  const pollMs = Math.max(400, config.manualLoginPollMs);
  const deadline = Date.now() + maxMs;
  let lastLog = 0;

  console.info(
    `[login] Conclua o acesso no navegador (recomendado: QR code). A detetar página pronta até ~${Math.round(
      maxMs / 1000
    )}s (verificação a cada ${pollMs} ms)…`
  );

  while (Date.now() < deadline) {
    const probe = await probeManualLoginReady(page);
    if (probe.ok) {
      console.info(`[login] Seguindo em frente (${probe.reason}).`);
      return;
    }
    const now = Date.now();
    if (now - lastLog >= 25_000) {
      console.info(`[login] A aguardar… (${probe.reason}). Conclua o login quando estiver pronto.`);
      lastLog = now;
    }
    await sleep(pollMs);
  }

  console.warn('[login] Tempo máximo atingido; a continuar mesmo assim.');
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
/**
 * @param {() => boolean} [isTimeExceeded]
 */
async function scrapeCategoryWithPdpFlow(page, categoryUrl, sniffer, store, metrics, isTimeExceeded) {
  const timeExceededFn = typeof isTimeExceeded === 'function' ? isTimeExceeded : () => false;
  const scrapedIds = new Set();
  let stagnantPasses = 0;
  let catSsr = 0;
  let catNet = 0;
  let catPdpAttempts = 0;
  let catPdpOk = 0;
  let catPdpErr = 0;

  const expandOpts = {
    maxClicks: config.viewMoreMaxClicks,
    noGrowthLimit: 4,
  };

  try {
    while (stagnantPasses < config.categoryStagnantPasses) {
      if (timeExceededFn()) {
        console.info('[tempo] Limite de execução na listagem; a terminar esta categoria.');
        break;
      }
      if (isProductCapReached(store)) {
        console.info(
          `[test] MAX_PRODUCTS (${config.maxProducts}) atingido; a sair do ciclo de listagem/PDP desta categoria.`
        );
        break;
      }

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

      const ssrRaw = await extractSsrListingRows(page);
      const ssrRows = ssrRaw.map((r, i) => ({
        ...r,
        rank_position: i + 1,
        taxonomia: taxonomyBase || String(r.taxonomia || ''),
      }));
      console.info(`[cards] SSR listing rows: ${ssrRows.length}`);
      catSsr += ssrRows.length;
      if (metrics) metrics.extracted.ssr_rows += ssrRows.length;
      if (ssrRows.length) {
        const stSsr = store.upsertManyLegacy(ssrRows, 'category_ssr');
        console.info(
          `[upsert] SSR +${stSsr.added} ~${stSsr.updated} skip=${stSsr.skipped}`
        );
        if (stSsr.added > 0 || stSsr.updated > 0) await store.flush();
      }

      const netBatch = sniffer.drainBuffer();
      const netRows = netBatch.map((n) => ({
        ...n,
        taxonomia: taxonomyBase || String(n.taxonomia || ''),
        data_coleta: new Date().toISOString(),
      }));
      console.info(`[cards] network buffer rows: ${netRows.length}`);
      catNet += netRows.length;
      if (metrics) metrics.extracted.network_rows += netRows.length;
      if (netRows.length) {
        const stNet = store.upsertManyLegacy(netRows, 'listing_network');
        console.info(
          `[upsert] network +${stNet.added} ~${stNet.updated} skip=${stNet.skipped}`
        );
        if (stNet.added > 0 || stNet.updated > 0) await store.flush();
      }

      if (isProductCapReached(store)) {
        console.info(
          `[test] MAX_PRODUCTS (${config.maxProducts}) atingido após SSR/rede; a saltar PDP nesta passagem.`
        );
        break;
      }

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
        if (isProductCapReached(store)) break;

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
        if (timeExceededFn()) {
          console.info('[tempo] Limite de execução durante PDP; a terminar esta categoria.');
          break;
        }
        if (isProductCapReached(store)) break;

        catPdpAttempts += 1;
        if (metrics) metrics.extracted.pdp_attempts += 1;
        try {
          sniffer.categoriaPaiAtual = taxonomyBase;
          const row = await scrapeProductDetail(page, link, taxonomyBase, sniffer);
          const sku = String(row.sku || id);
          scrapedIds.add(sku);

          const stPdp = store.upsertLegacy({ ...row, sku }, 'pdp');
          catPdpOk += 1;
          if (metrics) metrics.extracted.pdp_ok += 1;
          if (stPdp.added > 0 || stPdp.updated > 0) await store.flush();

          console.info(
            `[pdp] ok sku=${sku} +${stPdp.added} ~${stPdp.updated} | ${(row.nome || '').slice(0, 48)}`
          );
        } catch (e) {
          catPdpErr += 1;
          if (metrics) metrics.extracted.pdp_errors += 1;
          console.error(`[pdp] erro ao processar ${link}:`, e?.message || e);
        }

        await sleep(randomBetween(config.pdpDelayMinMs, config.pdpDelayMaxMs));
      }

      if (timeExceededFn()) {
        break;
      }

      if (isProductCapReached(store)) {
        console.info(
          `[test] MAX_PRODUCTS (${config.maxProducts}) atingido; a terminar ciclo desta categoria.`
        );
        break;
      }
    }

    console.info(
      `[categoria] finalizada: ${categoryUrl} (SKUs únicos visitados nesta execução: ${scrapedIds.size})`
    );
  } finally {
    metrics?.recordCategorySummary({
      category_url: categoryUrl,
      ssr_rows: catSsr,
      network_rows: catNet,
      pdp_attempts: catPdpAttempts,
      pdp_ok: catPdpOk,
      pdp_errors: catPdpErr,
    });
    console.info(
      `[persistência] gravando produtos.json${store.csvPath ? ' e CSV legado…' : '…'}`
    );
    await store.flush().catch((e) => console.error('[persistência] falha ao gravar:', e));
  }
}

async function main() {
  const startTime = Date.now();
  const runDurationMs = (Number(process.env.RUN_DURATION_MINUTES) || 2) * 60 * 1000;
  function timeExceeded() {
    return Date.now() - startTime >= runDurationMs;
  }

  const jsonPath = path.resolve(config.outputJson);
  const csvPath = config.outputCsv ? path.resolve(config.outputCsv) : '';
  const metrics = new RunMetrics();
  const store = await CanonicalJsonStore.create(jsonPath, csvPath, { metrics });
  console.info(
    `[store] JSON: ${jsonPath} | produtos: ${store.byId.size}${csvPath ? ` | CSV: ${csvPath}` : ''}${
      config.maxProducts != null ? ` | MAX_PRODUCTS=${config.maxProducts} (modo teste)` : ''
    }`
  );
  console.info(
    `[run] duração máxima: ${runDurationMs / 60_000} min (RUN_DURATION_MINUTES, omitir = 2)`
  );

  const { browser, userAgent } = await launchBrowser();
  console.info('[browser] User-Agent:', userAgent);

  const page = await browser.newPage();
  await page.setUserAgent(userAgent);
  await page.setViewport({ width: 1366, height: 768 });

  const sniffer = new NetworkSniffer(page, config.apiUrlIncludes, {
    debug: config.debugScraper,
    onDebugSample: config.debugScraper ? (e) => metrics.addSnifferDebug(e) : null,
  });
  sniffer.attach();

  async function finishRun(exitNote = '') {
    if (exitNote) console.info(exitNote);
    await store.flush().catch((e) => console.error('[persistência] falha ao gravar:', e));
    await browser.close();
    await flushRunArtifacts(metrics).catch((e) => console.error('[métricas] falha ao gravar:', e));
    console.info('[fim] JSON:', jsonPath);
    if (csvPath) console.info('[fim] CSV:', csvPath);
    console.info('[fim] métricas:', path.resolve(config.metricsJsonPath));
  }

  await page.goto(config.startUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await tryEmailPasswordLogin(page);
  await waitManualLogin(page);

  if (timeExceeded()) {
    await finishRun('[tempo] Limite de execução atingido após login; a gravar e encerrar.');
    return;
  }

  const categoryQueue = await buildCategoryUrlQueue(page);
  console.info(`[fila] ${categoryQueue.length} categorias na ordem.`);

  if (timeExceeded()) {
    await finishRun('[tempo] Limite de execução atingido após montar a fila; a gravar e encerrar.');
    return;
  }

  for (let i = 0; i < categoryQueue.length; i += 1) {
    if (timeExceeded()) {
      await finishRun('[tempo] Limite de execução atingido; a gravar e encerrar.');
      return;
    }

    const url = categoryQueue[i];
    sniffer.resetForNewCategory();
    console.info(`\n=== Categoria ${i + 1}/${categoryQueue.length}: ${url} ===`);

    try {
      await scrapeCategoryWithPdpFlow(page, url, sniffer, store, metrics, timeExceeded);
    } catch (e) {
      console.error(`[erro] categoria ${url}:`, e?.message || e);
      await store.flush().catch(() => {});
    }

    if (isProductCapReached(store)) {
      console.info(
        `[test] MAX_PRODUCTS (${config.maxProducts}) atingido; a interromper a fila de categorias.`
      );
      break;
    }

    if (timeExceeded()) {
      await finishRun('[tempo] Limite de execução atingido; a gravar e encerrar.');
      return;
    }

    if (i < categoryQueue.length - 1) {
      const pause = randomBetween(config.categoryDelayMinMs, config.categoryDelayMaxMs);
      console.info(`[delay] pausa ${pause} ms antes da próxima categoria.`);
      await sleep(pause);
    }
  }

  await finishRun();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
