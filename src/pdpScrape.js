import { sleep, randomBetween } from './util.js';
import { extractTaxonomyPath } from './taxonomy.js';
import { emptyShipping, mergeShippingPreferComplete, normalizeShippingEntry } from './shippingExtract.js';

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
 * Enriquece linha legado (ex.: sniffer) com shop/reviews/variantes do router.
 * Não altera preco_atual, preco_original, discount, sku, nome, etc. vindos de `best`.
 * @param {Record<string, unknown>} best
 * @param {Record<string, unknown> | null} routerRow
 */
function enrichLegacyRowFromRouter(best, routerRow) {
  if (!routerRow) return;
  const sn = String(routerRow.shop_name ?? '').trim();
  if (sn) best.shop_name = sn;
  const sl = String(routerRow.shop_logo ?? '').trim();
  if (sl) best.shop_logo = sl;
  const sid = String(routerRow.seller_id ?? '').trim();
  if (sid) best.seller_id = sid;
  const slink = String(routerRow.shop_link ?? '').trim();
  if (slink) best.shop_link = slink;
  for (const key of ['shop_product_count', 'shop_review_count', 'shop_sold_count']) {
    const raw = routerRow[key];
    if (raw != null && raw !== '') {
      const n = Number(raw);
      if (Number.isFinite(n)) best[key] = n;
    }
  }
  const rc = String(routerRow.rating_count ?? '').trim();
  if (rc) best.rating_count = rc;
  const rd = routerRow.rating_distribution;
  if (rd != null && typeof rd === 'object') {
    const empty = Array.isArray(rd) ? rd.length === 0 : Object.keys(rd).length === 0;
    if (!empty) {
      try {
        best.rating_distribution = JSON.parse(JSON.stringify(rd));
      } catch {
        /* ignorar */
      }
    }
  }
  const rv = routerRow.variants;
  if (Array.isArray(rv) && rv.length > 0) {
    const bv = best.variants;
    if (!Array.isArray(bv) || bv.length === 0) {
      try {
        best.variants = JSON.parse(JSON.stringify(rv));
      } catch {
        /* ignorar */
      }
    }
  }
  if (routerRow.shipping && typeof routerRow.shipping === 'object') {
    const base =
      best.shipping && typeof best.shipping === 'object'
        ? normalizeShippingEntry(best.shipping)
        : emptyShipping();
    best.shipping = mergeShippingPreferComplete(base, routerRow.shipping);
  }
}

/**
 * PDP: __MODERN_ROUTER_DATA__ → components_map (product_info) → preços (opcional), loja, review_model, variantes.
 * `preco_atual` pode ficar vazio; loja/reviews/variantes vêm quando `product_info` existe.
 * @returns {Promise<{ row: Record<string, unknown> | null; diag: Record<string, unknown> }>}
 */
function extractPdpPricesFromRouter(page) {
  return page.evaluate(() => {
    /** @type {Record<string, unknown>} */
    const diag = {
      found_modern_script: false,
      parsed_json: false,
      found_loader_data: false,
      found_components_map: false,
      component_types: /** @type {string[]} */ ([]),
      selected_component_type: /** @type {string | null} */ (null),
      found_product_info: false,
      has_shop_name: false,
      has_shop_logo: false,
      has_review_model: false,
      has_rating_count: false,
      has_rating_distribution: false,
      has_variants: false,
      product_id: '',
    };

    const el = document.querySelector('script#__MODERN_ROUTER_DATA__');
    if (!el?.textContent?.trim()) return { row: null, diag };
    diag.found_modern_script = true;

    let router;
    try {
      router = JSON.parse(el.textContent);
      diag.parsed_json = true;
    } catch {
      return { row: null, diag };
    }
    const ld = router.loaderData;
    if (!ld || typeof ld !== 'object') return { row: null, diag };
    diag.found_loader_data = true;

    let pageConfig = null;
    for (const key of Object.keys(ld)) {
      const chunk = ld[key];
      if (chunk && typeof chunk === 'object' && chunk.page_config?.components_map) {
        pageConfig = chunk.page_config;
        break;
      }
    }
    if (!pageConfig?.components_map) return { row: null, diag };
    diag.found_components_map = true;

    for (const v of Object.values(pageConfig.components_map)) {
      if (v && typeof v === 'object') {
        const t = /** @type {Record<string, unknown>} */ (v);
        const ct = t.component_type ?? t.componentType;
        if (ct != null && String(ct).trim() !== '') {
          /** @type {string[]} */ (diag.component_types).push(String(ct).trim());
        }
      }
    }

    /** @type {{ component_type?: string; componentType?: string; component_data?: Record<string, unknown> } | null} */
    let comp = null;
    for (const v of Object.values(pageConfig.components_map)) {
      if (v && typeof v === 'object') {
        const t = /** @type {{ component_type?: string; componentType?: string }} */ (v);
        if (t.component_type === 'product_info' || t.componentType === 'product_info') {
          comp = /** @type {typeof comp} */ (v);
          diag.selected_component_type = 'product_info';
          break;
        }
      }
    }
    if (!comp?.component_data) return { row: null, diag };

    const cd = /** @type {Record<string, unknown>} */ (comp.component_data);
    const pinfo = /** @type {Record<string, unknown> | undefined} */ (
      cd.product_info ?? cd.productInfo
    );
    if (!pinfo || typeof pinfo !== 'object') return { row: null, diag };
    diag.found_product_info = true;

    const pmModel = /** @type {Record<string, unknown> | undefined} */ (
      pinfo.product_model ?? pinfo.productModel
    );
    const productId = pmModel
      ? String(pmModel.product_id ?? pmModel.productId ?? '').trim()
      : '';
    const nome = pmModel ? String(pmModel.name ?? '').trim() : '';

    const ogImg = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';

    function shopLogoUrlFromSeller(raw) {
      if (raw == null) return '';
      if (typeof raw === 'string') return String(raw).trim();
      if (typeof raw === 'object') {
        const o = /** @type {Record<string, unknown>} */ (raw);
        const ul = o.url_list ?? o.urlList;
        if (Array.isArray(ul) && ul[0] != null) return String(ul[0]).trim();
        const u = o.url ?? o.uri ?? o.src;
        if (u != null) return String(u).trim();
      }
      return '';
    }

    const sm = /** @type {Record<string, unknown> | undefined} */ (
      pinfo.seller_model ?? pinfo.sellerModel
    );
    let shopName = '';
    let shopLogo = '';
    if (sm && typeof sm === 'object') {
      shopName = String(sm.shop_name ?? sm.shopName ?? '').trim();
      shopLogo = shopLogoUrlFromSeller(sm.shop_logo ?? sm.shopLogo);
    }

    const sinfo = /** @type {Record<string, unknown> | undefined} */ (
      pinfo.shop_info ?? pinfo.shopInfo
    );
    let sellerId = '';
    let shopLink = '';
    /** @type {number | null} */
    let shopProductCount = null;
    /** @type {number | null} */
    let shopReviewCount = null;
    /** @type {number | null} */
    let shopSoldCount = null;
    if (sinfo && typeof sinfo === 'object') {
      sellerId = String(sinfo.seller_id ?? sinfo.sellerId ?? '').trim();
      shopLink = String(sinfo.shop_link ?? sinfo.shopLink ?? '').trim();
      const osp = sinfo.on_sell_product_count ?? sinfo.onSellProductCount;
      if (osp != null && String(osp).trim() !== '') {
        const n = Number(osp);
        if (Number.isFinite(n)) shopProductCount = n;
      }
      const src = sinfo.review_count ?? sinfo.reviewCount;
      if (src != null && String(src).trim() !== '') {
        const n = Number(src);
        if (Number.isFinite(n)) shopReviewCount = n;
      }
      const ssc = sinfo.sold_count ?? sinfo.soldCount;
      if (ssc != null && String(ssc).trim() !== '') {
        const n = Number(ssc);
        if (Number.isFinite(n)) shopSoldCount = n;
      }
    }

    /** @type {{ name: string; value: string }[]} */
    const variants = [];
    function pushVariant(propName, val) {
      const n = String(propName ?? '').trim();
      const v = String(val ?? '').trim();
      if (n && v) variants.push({ name: n, value: v });
    }
    if (pmModel && typeof pmModel === 'object') {
      const saleProps = pmModel.sale_properties ?? pmModel.saleProperties;
      if (Array.isArray(saleProps)) {
        for (const sp of saleProps) {
          if (!sp || typeof sp !== 'object') continue;
          const pr = /** @type {Record<string, unknown>} */ (sp);
          const propName =
            pr.prop_name ??
            pr.propName ??
            pr.property_name ??
            pr.propertyName ??
            pr.name ??
            '';
          const values =
            pr.sale_prop_values ??
            pr.salePropValues ??
            pr.prop_values ??
            pr.propValues ??
            [];
          if (Array.isArray(values)) {
            for (const vv of values) {
              if (!vv || typeof vv !== 'object') continue;
              const m = /** @type {Record<string, unknown>} */ (vv);
              const val =
                m.prop_value ??
                m.propValue ??
                m.property_value ??
                m.propertyValue ??
                m.name ??
                '';
              pushVariant(propName, val);
            }
          }
        }
      }
    }

    const rm = /** @type {Record<string, unknown> | undefined} */ (
      pinfo.review_model ?? pinfo.reviewModel
    );
    let ratingCountStr = '';
    let overallScoreStr = '';
    /** @type {unknown} */
    let ratingDist = null;
    if (rm && typeof rm === 'object') {
      const rc = rm.product_review_count ?? rm.productReviewCount;
      if (rc != null && String(rc).trim() !== '') ratingCountStr = String(rc).trim();
      const os = rm.product_overall_score ?? rm.productOverallScore;
      if (os != null && String(os).trim() !== '') overallScoreStr = String(os).trim();
      const dist =
        rm.rating_distribution ??
        rm.ratingDistribution ??
        rm.review_star_rating_distribution ??
        rm.reviewStarRatingDistribution ??
        rm.star_rating_distribution ??
        rm.starRatingDistribution;
      if (dist != null && typeof dist === 'object') {
        ratingDist = dist;
      }
    }

    const rinfo = /** @type {Record<string, unknown> | undefined} */ (
      pinfo.review_info ?? pinfo.reviewInfo
    );
    if (rinfo && typeof rinfo === 'object') {
      const rr = /** @type {Record<string, unknown> | undefined} */ (
        rinfo.review_ratings ?? rinfo.reviewRatings
      );
      if (rr && typeof rr === 'object') {
        const res = rr.rating_result ?? rr.ratingResult;
        if (res != null && typeof res === 'object') {
          const emptyRes = Array.isArray(res) ? res.length === 0 : Object.keys(res).length === 0;
          if (!emptyRes) ratingDist = res;
        }
      }
    }

    function realPriceDescImpliesFree(rawText) {
      const s = String(rawText ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      return (
        s.includes('gratis') ||
        s.includes('free') ||
        s.includes('sem frete') ||
        s.includes('envio gratis')
      );
    }

    /** @type {Record<string, unknown> | null} */
    let shippingObj = null;
    const pll = pinfo.promotion_logistic_list ?? pinfo.promotionLogisticList;
    if (Array.isArray(pll) && pll[0] && typeof pll[0] === 'object') {
      const pl = /** @type {Record<string, unknown>} */ (pll[0]);
      const freeRaw = pl.freeShipping ?? pl.free_shipping;
      const fee = /** @type {Record<string, unknown> | undefined} */ (
        pl.shippingFee ?? pl.shipping_fee
      );
      let shipPrice = 0;
      let shipText = 'unknown';
      if (fee && typeof fee === 'object') {
        const rp = fee.real_price ?? fee.realPrice;
        if (rp != null && String(rp).trim() !== '') {
          const n = Number(rp);
          if (Number.isFinite(n)) shipPrice = n;
        }
        const rd = fee.real_price_desc ?? fee.realPriceDesc;
        if (rd != null && String(rd).trim() !== '') shipText = String(rd).trim();
      }
      const origRaw = pl.originalShippingFee ?? pl.original_shipping_fee;
      /** @type {number | null} */
      let originalPrice = null;
      if (origRaw != null && origRaw !== '') {
        const n = Number(origRaw);
        if (Number.isFinite(n)) originalPrice = n;
      }
      const delName = pl.deliveryName ?? pl.delivery_name;
      const et = /** @type {Record<string, unknown> | undefined} */ (
        pl.event_tracking ?? pl.eventTracking
      );
      let shipType = '';
      if (et && typeof et === 'object') {
        const st = et.shipping_type ?? et.shippingType;
        if (st != null) shipType = String(st).trim();
      }
      /** Coerência is_free: confiar em freeShipping === true e em price 0 + texto (ex. grátis), sem inferir só por price 0. */
      let isFree = Boolean(freeRaw);
      if (freeRaw === true) {
        isFree = true;
      } else if (
        shipPrice === 0 &&
        shipText !== 'unknown' &&
        realPriceDescImpliesFree(shipText)
      ) {
        isFree = true;
      }
      shippingObj = {
        price: shipPrice,
        is_free: isFree,
        text: shipText,
        original_price: originalPrice,
        delivery_name: delName != null ? String(delName).trim() : '',
        shipping_type: shipType,
      };
    }
    if (!shippingObj) {
      shippingObj = {
        price: null,
        is_free: false,
        text: 'unknown',
        original_price: null,
        delivery_name: '',
        shipping_type: '',
      };
    }

    let preco_atual = '';
    let preco_original = '';
    let skuId = '';
    let discount_format = '';
    let discount_decimal = '';
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
    if (min && typeof min === 'object') {
      const sale = min.sale_price_decimal ?? min.salePriceDecimal;
      if (sale != null && String(sale).trim() !== '') {
        preco_atual = String(sale).trim();
        const origin = min.origin_price_decimal ?? min.originPriceDecimal;
        preco_original =
          origin != null && String(origin).trim() !== '' ? String(origin).trim() : '';
        skuId = String(min.sku_id ?? min.skuId ?? '').trim();
        discount_format = String(min.discount_format ?? min.discountFormat ?? '').trim();
        discount_decimal = String(min.discount_decimal ?? min.discountDecimal ?? '').trim();
      }
    }
    if (!skuId && pmModel && typeof pmModel === 'object') {
      const skus = pmModel.skus;
      if (Array.isArray(skus) && skus[0] && typeof skus[0] === 'object') {
        const s0 = /** @type {Record<string, unknown>} */ (skus[0]);
        skuId = String(s0.sku_id ?? s0.skuId ?? '').trim();
      }
    }

    diag.product_id = productId;
    diag.has_shop_name = shopName !== '';
    diag.has_shop_logo = shopLogo !== '';
    diag.has_review_model = !!(rm && typeof rm === 'object');
    diag.has_rating_count = ratingCountStr !== '';
    if (ratingDist != null && typeof ratingDist === 'object') {
      const empty = Array.isArray(ratingDist)
        ? ratingDist.length === 0
        : Object.keys(ratingDist).length === 0;
      diag.has_rating_distribution = !empty;
    } else {
      diag.has_rating_distribution = false;
    }
    diag.has_variants = variants.length > 0;

    const row = {
      product_id: productId,
      sku_id: skuId,
      nome,
      preco_atual,
      preco_original,
      discount_format,
      discount_decimal,
      link_imagem: ogImg.trim(),
      shop_name: shopName,
      shop_logo: shopLogo,
      seller_id: sellerId,
      shop_link: shopLink,
      shop_product_count: shopProductCount,
      shop_review_count: shopReviewCount,
      shop_sold_count: shopSoldCount,
      nota_avaliacao: overallScoreStr,
      rating_count: ratingCountStr,
      rating_distribution: ratingDist,
      variants,
      shipping: shippingObj,
    };
    return { row, diag };
  });
}

/**
 * Logs mínimos para depuração do router no ramo sniffer (Node).
 * @param {Record<string, unknown>} diag
 * @param {string} [skuHint]
 */
function logPdpRouterSnifferDiag(diag, skuHint) {
  const fp = diag.found_product_info === true;
  console.info(`[pdp-router] found_product_info=${fp}`);
  console.info(`[pdp-router] has_shop_name=${diag.has_shop_name === true}`);
  console.info(`[pdp-router] has_shop_logo=${diag.has_shop_logo === true}`);
  console.info(`[pdp-router] has_review_model=${diag.has_review_model === true}`);
  console.info(`[pdp-router] has_rating_count=${diag.has_rating_count === true}`);
  console.info(`[pdp-router] has_rating_distribution=${diag.has_rating_distribution === true}`);
  console.info(`[pdp-router] has_variants=${diag.has_variants === true}`);
  const pid = String(diag.product_id || skuHint || '').trim() || '(empty)';
  console.info(`[pdp-router] product_id=${pid}`);
  const types = Array.isArray(diag.component_types) ? diag.component_types : [];
  console.info(`[pdp-router] component_types=${JSON.stringify(types)}`);
  const sel = diag.selected_component_type != null ? String(diag.selected_component_type) : '';
  console.info(`[pdp-router] selected_component_type=${sel || '(none)'}`);
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
    console.info('[pdp] source=sniffer', {
      sku: best.sku,
      url: page.url().split('#')[0],
    });
    const { row: routerForEnrich, diag: routerDiag } = await extractPdpPricesFromRouter(page);
    logPdpRouterSnifferDiag(routerDiag, String(best.sku || ''));
    enrichLegacyRowFromRouter(best, routerForEnrich);
    return {
      ...best,
      taxonomia: taxonomia || best.taxonomia || '',
      link_do_produto: best.link_do_produto || page.url().split('#')[0],
      data_coleta: coleta,
    };
  }

  const url = page.url().split('#')[0];
  const mHint = url.match(/(\d{10,})/g);
  const urlProductHint = mHint?.length ? mHint[mHint.length - 1] : '';
  const { row: routerRow, diag: routerDiagPdp } = await extractPdpPricesFromRouter(page);
  logPdpRouterSnifferDiag(routerDiagPdp, urlProductHint);
  if (routerRow?.preco_atual) {
    let sku = String(routerRow.product_id || '').trim();
    if (!sku) {
      const mUrl = url.match(/(\d{10,})/g);
      if (mUrl?.length) sku = mUrl[mUrl.length - 1];
    }
    if (sku) {
      const skuId = String(routerRow.sku_id || '').trim() || sku;
      const v = routerRow.variants;
      console.info('[pdp] source=router', {
        sku,
        url,
        enrichment: {
          shop_name: Boolean(String(routerRow.shop_name || '').trim()),
          shop_logo: Boolean(String(routerRow.shop_logo || '').trim()),
          rating_count: Boolean(String(routerRow.rating_count || '').trim()),
          rating_distribution: routerRow.rating_distribution != null,
          variants: Array.isArray(v) && v.length > 0,
          variants_len: Array.isArray(v) ? v.length : 0,
        },
      });
      return {
        sku,
        sku_id: skuId,
        nome: routerRow.nome || '',
        preco_atual: routerRow.preco_atual,
        preco_original: routerRow.preco_original || '',
        nota_avaliacao: String(routerRow.nota_avaliacao || '').trim(),
        rating_count: String(routerRow.rating_count || '').trim(),
        rating_distribution: routerRow.rating_distribution ?? null,
        total_vendas: '',
        taxonomia,
        link_do_produto: url,
        link_imagem: routerRow.link_imagem || '',
        shop_name: routerRow.shop_name || '',
        shop_logo: routerRow.shop_logo || '',
        seller_id: String(routerRow.seller_id ?? '').trim(),
        shop_link: String(routerRow.shop_link ?? '').trim(),
        shop_product_count: routerRow.shop_product_count,
        shop_review_count: routerRow.shop_review_count,
        shop_sold_count: routerRow.shop_sold_count,
        variants: Array.isArray(routerRow.variants) ? routerRow.variants : [],
        shipping: routerRow.shipping && typeof routerRow.shipping === 'object' ? routerRow.shipping : undefined,
        data_coleta: coleta,
      };
    }
    console.info('[pdp] router_skipped', {
      reason: 'no_sku_after_router',
      url,
      had_precoatual: true,
    });
  } else {
    console.info('[pdp] router_skipped', {
      reason: routerRow ? 'no_precoatual' : 'no_router_payload',
      url,
    });
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

  console.info('[pdp] source=dom', { sku, url });

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
