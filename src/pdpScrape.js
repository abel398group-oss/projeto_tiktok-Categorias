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
 * PDP: __MODERN_ROUTER_DATA__ → components_map (product_info) → promotion_product_price.min_price.
 * Executado no browser (shape alinhado ao HTML guardado).
 * @returns {Promise<Record<string, string> | null>}
 */
function extractPdpPricesFromRouter(page) {
  return page.evaluate(() => {
    const el = document.querySelector('script#__MODERN_ROUTER_DATA__');
    if (!el?.textContent?.trim()) return null;
    let router;
    try {
      router = JSON.parse(el.textContent);
    } catch {
      return null;
    }
    const ld = router.loaderData;
    if (!ld || typeof ld !== 'object') return null;

    let pageConfig = null;
    for (const key of Object.keys(ld)) {
      const chunk = ld[key];
      if (chunk && typeof chunk === 'object' && chunk.page_config?.components_map) {
        pageConfig = chunk.page_config;
        break;
      }
    }
    if (!pageConfig?.components_map) return null;

    /** @type {{ component_type?: string; componentType?: string; component_data?: Record<string, unknown> } | null} */
    let comp = null;
    for (const v of Object.values(pageConfig.components_map)) {
      if (v && typeof v === 'object') {
        const t = /** @type {{ component_type?: string; componentType?: string }} */ (v);
        if (t.component_type === 'product_info' || t.componentType === 'product_info') {
          comp = /** @type {typeof comp} */ (v);
          break;
        }
      }
    }
    if (!comp?.component_data) return null;

    const cd = /** @type {Record<string, unknown>} */ (comp.component_data);
    const pinfo = /** @type {Record<string, unknown> | undefined} */ (
      cd.product_info ?? cd.productInfo
    );
    if (!pinfo || typeof pinfo !== 'object') return null;

    const pm = /** @type {Record<string, unknown> | undefined} */ (
      pinfo.promotion_model ?? pinfo.promotionModel
    );
    const ppp = pm
      ? /** @type {Record<string, unknown> | undefined} */ (
          pm.promotion_product_price ?? pm.promotionProductPrice
        )
      : undefined;
    const min = ppp
      ? /** @type {Record<string, unknown> | undefined} */ (ppp.min_price ?? ppp.minPrice)
      : undefined;
    if (!min || typeof min !== 'object') return null;

    const sale = min.sale_price_decimal ?? min.salePriceDecimal;
    if (sale == null || String(sale).trim() === '') return null;

    const pmModel = /** @type {Record<string, unknown> | undefined} */ (
      pinfo.product_model ?? pinfo.productModel
    );
    const productId = pmModel
      ? String(pmModel.product_id ?? pmModel.productId ?? '').trim()
      : '';
    const nome = pmModel ? String(pmModel.name ?? '').trim() : '';

    const skuId = String(min.sku_id ?? min.skuId ?? '').trim();
    const origin = min.origin_price_decimal ?? min.originPriceDecimal;
    const ogImg = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';

    return {
      product_id: productId,
      sku_id: skuId,
      nome,
      preco_atual: String(sale).trim(),
      preco_original: origin != null && String(origin).trim() !== '' ? String(origin).trim() : '',
      discount_format: String(min.discount_format ?? min.discountFormat ?? '').trim(),
      discount_decimal: String(min.discount_decimal ?? min.discountDecimal ?? '').trim(),
      link_imagem: ogImg.trim(),
    };
  });
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

  const url = page.url().split('#')[0];
  const routerRow = await extractPdpPricesFromRouter(page);
  if (routerRow?.preco_atual) {
    let sku = String(routerRow.product_id || '').trim();
    if (!sku) {
      const mUrl = url.match(/(\d{10,})/g);
      if (mUrl?.length) sku = mUrl[mUrl.length - 1];
    }
    if (sku) {
      const skuId = String(routerRow.sku_id || '').trim() || sku;
      return {
        sku,
        sku_id: skuId,
        nome: routerRow.nome || '',
        preco_atual: routerRow.preco_atual,
        preco_original: routerRow.preco_original || '',
        nota_avaliacao: '',
        total_vendas: '',
        taxonomia,
        link_do_produto: url,
        link_imagem: routerRow.link_imagem || '',
        data_coleta: coleta,
      };
    }
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
