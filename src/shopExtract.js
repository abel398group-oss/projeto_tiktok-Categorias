/**
 * Loja / vendedor a partir do mesmo JSON que o PDP usa (__MODERN_ROUTER_DATA__ / API).
 * Alinha SSR + listing_network com os campos já suportados em fromLegacyRow / mergeProduct.
 */

/**
 * @param {unknown} raw
 */
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

/**
 * @param {unknown} p nó produto (card listagem ou envelope com product_info).
 * @returns {Record<string, unknown>} campos legado opcionais shop_*
 */
export function extractShopFieldsFromProductNode(p) {
  /** @type {Record<string, unknown>} */
  const row = {};
  if (!p || typeof p !== 'object') return row;

  const root = /** @type {Record<string, unknown>} */ (p);
  const pinfo =
    (root.product_info ?? root.productInfo) && typeof (root.product_info ?? root.productInfo) === 'object'
      ? /** @type {Record<string, unknown>} */ (root.product_info ?? root.productInfo)
      : root;

  const sm = /** @type {Record<string, unknown> | undefined} */ (
    pinfo.seller_model ?? pinfo.sellerModel ?? root.seller_model ?? root.sellerModel
  );
  if (sm && typeof sm === 'object') {
    const sn = String(sm.shop_name ?? sm.shopName ?? '').trim();
    if (sn) row.shop_name = sn;
    const sl = shopLogoUrlFromSeller(sm.shop_logo ?? sm.shopLogo);
    if (sl) row.shop_logo = sl;
  }

  const sinfo = /** @type {Record<string, unknown> | undefined} */ (
    root.shop_info ??
      root.shopInfo ??
      pinfo.shop_info ??
      pinfo.shopInfo
  );
  if (sinfo && typeof sinfo === 'object') {
    const sid = String(sinfo.seller_id ?? sinfo.sellerId ?? '').trim();
    if (sid) row.seller_id = sid;
    const slk = String(sinfo.shop_link ?? sinfo.shopLink ?? '').trim();
    if (slk) row.shop_link = slk;
    const osp =
      sinfo.on_sell_product_count ??
      sinfo.onSellProductCount ??
      sinfo.display_on_sell_product_count ??
      sinfo.displayOnSellProductCount;
    if (osp != null && String(osp).trim() !== '') {
      const n = Number(osp);
      if (Number.isFinite(n)) row.shop_product_count = n;
    }
    const src = sinfo.review_count ?? sinfo.reviewCount;
    if (src != null && String(src).trim() !== '') {
      const n = Number(src);
      if (Number.isFinite(n)) row.shop_review_count = n;
    }
    const ssc =
      sinfo.sold_count ??
      sinfo.soldCount ??
      sinfo.global_sold_count ??
      sinfo.globalSoldCount;
    if (ssc != null && String(ssc).trim() !== '') {
      const n = Number(ssc);
      if (Number.isFinite(n)) row.shop_sold_count = n;
    }
  }
  if (!row.seller_id && pinfo && typeof pinfo === 'object') {
    const pm = /** @type {Record<string, unknown> | undefined} */ (
      pinfo.product_model ?? pinfo.productModel
    );
    if (pm && typeof pm === 'object') {
      const sid = String(pm.seller_id ?? pm.sellerId ?? '').trim();
      if (sid) row.seller_id = sid;
    }
  }

  if (!row.shop_name) {
    const mkt = root.product_marketing_info ?? root.productMarketingInfo;
    if (mkt && typeof mkt === 'object') {
      const mk = /** @type {Record<string, unknown>} */ (mkt);
      const sellerName = String(mk.seller_name ?? mk.sellerName ?? mk.shop_name ?? mk.shopName ?? '').trim();
      if (sellerName) row.shop_name = sellerName;
    }
  }

  if (!row.shop_name) {
    const sel = root.seller ?? root.seller_info ?? root.sellerInfo;
    if (sel && typeof sel === 'object') {
      const s = /** @type {Record<string, unknown>} */ (sel);
      const name = String(s.shop_name ?? s.shopName ?? s.name ?? s.seller_name ?? s.sellerName ?? '').trim();
      if (name) row.shop_name = name;
      if (!row.shop_logo) {
        const lg = shopLogoUrlFromSeller(s.shop_logo ?? s.shopLogo ?? s.logo);
        if (lg) row.shop_logo = lg;
      }
    }
  }

  return row;
}
