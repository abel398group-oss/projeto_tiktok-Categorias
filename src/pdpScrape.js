import { sleep, randomBetween } from './util.js';
import { extractTaxonomyPath } from './taxonomy.js';

function pickBestRow(rows) {
  if (!rows.length) return null;
  const scored = rows.map((r) => {
    let score = 0;
    if (r.preco_atual) score += 3;
    if (r.preco_original) score += 1;
    if (r.nota_avaliacao) score += 2;
    if (r.total_vendas) score += 2;
    if (r.link_imagem) score += 1;
    if (r.link_do_produto) score += 1;
    if (r.nome) score += 1;
    return { r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].r;
}

function dedupeLatestBySku(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!r?.sku) continue;
    m.set(String(r.sku), r);
  }
  return Array.from(m.values());
}

/**
 * Abre a PDP por URL (sem voltar pela listagem — evita reordenação do grid).
 * Usa JSON interceptado + complemento no DOM + breadcrumb.
 */
export async function scrapeProductDetail(page, pdpUrl, taxonomiaFallback, sniffer) {
  sniffer.drainBuffer();

  await page.goto(pdpUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  // Espera conteúdo principal; não falha o fluxo se o seletor mudar.
  await page
    .waitForSelector('h1, [data-e2e="product_title"], main, [class*="product"]', {
      timeout: 28_000,
    })
    .catch(() => {});

  await sleep(randomBetween(1800, 3200));
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 20_000 }).catch(() => {});

  const coleta = new Date().toISOString();
  const taxonomia = (await extractTaxonomyPath(page, taxonomiaFallback)) || taxonomiaFallback || '';

  const fromNet = dedupeLatestBySku(sniffer.drainBuffer());
  const best = pickBestRow(fromNet);

  if (best && best.sku) {
    return {
      ...best,
      taxonomia: taxonomia || best.taxonomia || '',
      link_do_produto: best.link_do_produto || page.url().split('#')[0],
      data_coleta: coleta,
    };
  }

  const dom = await page.evaluate(() => {
    const title =
      document.querySelector('h1')?.textContent?.trim() ||
      document.querySelector('[data-e2e="product_title"]')?.textContent?.trim() ||
      '';

    const prices = [];
    document.querySelectorAll('[class*="price" i], [data-e2e*="price" i], strong, span').forEach((el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 52 && /R\$|\$\s?\d|[\d.,]+\s*R\$|^\d+[.,]\d{2}/.test(t)) prices.push(t);
    });
    const preco_atual = prices[0] || '';
    const preco_original = prices.length > 1 ? prices[1] : '';

    let sold = '';
    const soldRx = /(\d[\d.,]*\s*(k|m|mil|sold|vendidos?)?)/i;
    document.querySelectorAll('[class*="sold" i], [data-e2e*="sold" i]').forEach((el) => {
      const t = (el.textContent || '').trim();
      if (t && t.length < 40 && soldRx.test(t)) sold = t;
    });

    let rating = '';
    document.querySelectorAll('[class*="rating" i], [class*="review" i], [aria-label*="star" i]').forEach((el) => {
      const t = (el.textContent || el.getAttribute('aria-label') || '').trim();
      if (t && /\d+[.,]\d+/.test(t) && t.length < 24) rating = t;
    });

    const ogImg = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
    const img =
      ogImg ||
      document.querySelector('img[src*="tiktok" i], img[src*="ttcdn" i]')?.getAttribute('src') ||
      '';

    return {
      title,
      preco_atual,
      preco_original,
      sold,
      rating,
      img,
    };
  });

  const url = page.url().split('#')[0];
  let sku = '';
  const m = url.match(/(\d{10,})/g);
  if (m?.length) sku = m[m.length - 1];

  return {
    sku,
    nome: dom.title,
    preco_atual: dom.preco_atual,
    preco_original: dom.preco_original,
    nota_avaliacao: dom.rating,
    total_vendas: dom.sold,
    taxonomia,
    link_do_produto: url,
    link_imagem: dom.img,
    data_coleta: coleta,
  };
}
