/**
 * Extrai linhas (legado + campos extra) a partir do __MODERN_ROUTER_DATA__ para o modelo canónico.
 */

/**
 * @param {import('puppeteer').Page} page
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function extractSsrListingRows(page) {
  return page.evaluate(() => {
    const el = document.querySelector('script#__MODERN_ROUTER_DATA__');
    if (!el?.textContent?.trim()) return [];

    let router;
    try {
      router = JSON.parse(el.textContent);
    } catch {
      return [];
    }

    const coleta = new Date().toISOString();
    /** @type {Array<Record<string, unknown>>} */
    const out = [];

    /** min_price primeiro (alinhamento PDP), depois promo/top-level, depois texto — nunca max_price. */
    function priceFromPpi(ppi) {
      if (!ppi || typeof ppi !== 'object') return '';
      function num(v) {
        if (v == null || v === '') return null;
        if (typeof v === 'number' && isFinite(v)) return v > 0 ? v : null;
        const s = String(v).replace(/[^\d.,]/g, '').replace(',', '.');
        const x = parseFloat(s);
        return isFinite(x) && x > 0 ? x : null;
      }
      function pick(n) {
        return n != null ? String(n) : '';
      }
      const p = /** @type {Record<string, unknown>} */ (ppi);
      let n;
      const min = p.min_price ?? p.minPrice;
      if (min && typeof min === 'object') {
        const m = /** @type {Record<string, unknown>} */ (min);
        n =
          num(m.sale_price_decimal) ||
          num(m.single_product_price_decimal) ||
          num(m.min_sale_price) ||
          num(m.price_val);
        if (n) return pick(n);
      }
      n =
        num(p.discount_price_decimal) ||
        num(p.discount_price) ||
        num(p.sale_price_decimal) ||
        num(p.sale_price);
      if (n) return pick(n);
      n = num(p.price_current);
      if (n) return pick(n);
      n = num(p.price);
      if (n) return pick(n);
      n = num(p.sale_price_format) || num(p.price_text);
      return pick(n);
    }

    function pickLink(p, id) {
      const c = [p.seo_url, p.seoUrl, p.product_url, p.productUrl, p.pdp_url, p.pdpUrl];
      for (const x of c) {
        const s = x && String(x).trim();
        if (s && (s.includes('shop.tiktok') || s.includes('tiktok.com'))) return s;
      }
      return `https://shop.tiktok.com/view/product/${id}`;
    }

    function firstImg(p) {
      const im = p.image || p.cover;
      if (im && typeof im === 'object') {
        const list = im.url_list || im.urlList || im.urls;
        if (Array.isArray(list) && list[0]) return String(list[0]);
        if (im.url) return String(im.url);
      }
      return '';
    }

    /** Alinhado a src/shopExtract.js + PDP (mesmos campos no JSON do router). */
    function shopLogoUrlFromSeller(raw) {
      if (raw == null) return '';
      if (typeof raw === 'string') return String(raw).trim();
      if (typeof raw === 'object') {
        const o = raw;
        const ul = o.url_list || o.urlList;
        if (Array.isArray(ul) && ul[0] != null) return String(ul[0]).trim();
        const u = o.url || o.uri || o.src;
        if (u != null) return String(u).trim();
      }
      return '';
    }

    function extractShopFieldsFromProductNode(p) {
      /** @type {Record<string, unknown>} */
      const row = {};
      if (!p || typeof p !== 'object') return row;
      const root = p;
      const pinfo =
        (root.product_info || root.productInfo) && typeof (root.product_info || root.productInfo) === 'object'
          ? root.product_info || root.productInfo
          : root;

      const sm = pinfo.seller_model || pinfo.sellerModel || root.seller_model || root.sellerModel;
      if (sm && typeof sm === 'object') {
        const sn = String(sm.shop_name || sm.shopName || '').trim();
        if (sn) row.shop_name = sn;
        const sl = shopLogoUrlFromSeller(sm.shop_logo || sm.shopLogo);
        if (sl) row.shop_logo = sl;
      }

      const sinfo = pinfo.shop_info || pinfo.shopInfo || root.shop_info || root.shopInfo;
      if (sinfo && typeof sinfo === 'object') {
        const sid = String(sinfo.seller_id || sinfo.sellerId || '').trim();
        if (sid) row.seller_id = sid;
        const slk = String(sinfo.shop_link || sinfo.shopLink || '').trim();
        if (slk) row.shop_link = slk;
        const osp = sinfo.on_sell_product_count ?? sinfo.onSellProductCount;
        if (osp != null && String(osp).trim() !== '') {
          const n = Number(osp);
          if (Number.isFinite(n)) row.shop_product_count = n;
        }
        const src = sinfo.review_count || sinfo.reviewCount;
        if (src != null && String(src).trim() !== '') {
          const n = Number(src);
          if (Number.isFinite(n)) row.shop_review_count = n;
        }
        const ssc = sinfo.sold_count || sinfo.soldCount;
        if (ssc != null && String(ssc).trim() !== '') {
          const n = Number(ssc);
          if (Number.isFinite(n)) row.shop_sold_count = n;
        }
      }

      if (!row.shop_name) {
        const mkt = root.product_marketing_info || root.productMarketingInfo;
        if (mkt && typeof mkt === 'object') {
          const sellerName = String(
            mkt.seller_name || mkt.sellerName || mkt.shop_name || mkt.shopName || ''
          ).trim();
          if (sellerName) row.shop_name = sellerName;
        }
      }

      if (!row.shop_name) {
        const sel = root.seller || root.seller_info || root.sellerInfo;
        if (sel && typeof sel === 'object') {
          const name = String(sel.shop_name || sel.shopName || sel.name || sel.seller_name || sel.sellerName || '').trim();
          if (name) row.shop_name = name;
          if (!row.shop_logo) {
            const lg = shopLogoUrlFromSeller(sel.shop_logo || sel.shopLogo || sel.logo);
            if (lg) row.shop_logo = lg;
          }
        }
      }

      return row;
    }

    function ingestProductNode(p) {
      if (!p || typeof p !== 'object') return;
      const id = String(p.product_id ?? p.productId ?? '').trim();
      if (!/^\d{10,}$/.test(id)) return;
      const nome = String(p.title ?? p.name ?? p.product_name ?? '').trim();
      const ppi = p.product_price_info ?? p.productPriceInfo;
      const preco = priceFromPpi(ppi);
      if (!nome || !preco) return;

      const rate = p.rate_info || p.rateInfo;
      let nota = '';
      let ratingCount = '';
      if (rate && typeof rate === 'object') {
        const r = /** @type {Record<string, unknown>} */ (rate);
        if (r.score != null) nota = String(r.score);
        if (r.review_count != null) ratingCount = String(r.review_count);
      }

      const sold = p.sold_info || p.soldInfo;
      let vendas = '';
      if (sold && typeof sold === 'object') {
        const s = /** @type {Record<string, unknown>} */ (sold);
        vendas = String(s.sold_count ?? s.format_sold_count ?? '');
      }

      let precoOrig = '';
      if (ppi && typeof ppi === 'object') {
        const po = /** @type {Record<string, unknown>} */ (ppi);
        const od = po.origin_price_decimal ?? po.original_price_decimal;
        if (od != null && String(od).trim()) precoOrig = String(od);
      }

      const skuId =
        ppi && typeof ppi === 'object'
          ? String(
              /** @type {Record<string, unknown>} */ (ppi).sku_id ??
                /** @type {Record<string, unknown>} */ (ppi).skuId ??
                id
            )
          : id;

      const imgUrl = firstImg(p);
      /** @type {string[]} */
      const imgs = [];
      if (imgUrl) imgs.push(imgUrl);

      /** @type {Record<string, unknown> | null} */
      let shipping = null;
      const labels = p.product_marketing_info?.shipping_labels;
      function labelLooksFree(raw) {
        const s = String(raw ?? '')
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');
        return (
          s.includes('free') ||
          s.includes('gratis') ||
          s.includes('sem frete') ||
          s.includes('envio gratis')
        );
      }
      if (Array.isArray(labels) && labels.some((l) => labelLooksFree(l))) {
        shipping = { price: 0, is_free: true, text: 'Frete grátis' };
      } else {
        shipping = {
          price: null,
          is_free: false,
          text: 'unknown',
          original_price: null,
          delivery_name: '',
          shipping_type: '',
        };
      }

      /** @type {Record<string, unknown>} */
      const row = {
        sku: id,
        sku_id: skuId,
        nome,
        preco_atual: preco,
        preco_original: precoOrig,
        nota_avaliacao: nota,
        rating_count: ratingCount,
        total_vendas: vendas,
        taxonomia: '',
        link_do_produto: pickLink(p, id),
        link_imagem: imgUrl,
        images: imgs,
        data_coleta: coleta,
        shipping,
      };
      const shopExtra = extractShopFieldsFromProductNode(p);
      for (const [k, v] of Object.entries(shopExtra)) {
        if (v !== '' && v !== null && v !== undefined) row[k] = v;
      }
      out.push(row);
    }

    function walk(o, depth) {
      if (depth > 22 || o === null || o === undefined) return;
      if (Array.isArray(o)) {
        for (const x of o) walk(x, depth + 1);
        return;
      }
      if (typeof o !== 'object') return;

      const pl = o.productList ?? o.product_list;
      if (Array.isArray(pl)) {
        for (const item of pl) ingestProductNode(item);
      }

      for (const k of Object.keys(o)) walk(o[k], depth + 1);
    }

    walk(router, 0);
    return out;
  });
}
