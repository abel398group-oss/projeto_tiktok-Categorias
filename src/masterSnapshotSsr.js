/**
 * Extrai produtos visíveis no dashboard de uma categoria master.
 * 1) __MODERN_ROUTER_DATA__ — maior lista productList / product_list / products.
 * 2) Fallback: âncoras no DOM (href pode vir como /view/product/… — normalizamos para /{região}/pdp/{id}).
 *
 * Snapshot: ordem e itens mudam a cada carga.
 */

/**
 * @param {import('puppeteer').Page} page
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function extractDashboardProductsFromSsr(page) {
  return page.evaluate(() => {
    const LIST_KEYS = ['productList', 'product_list', 'products'];

    function pathRegion() {
      const m = location.pathname.match(/^\/([a-z]{2})\//i);
      return (m && m[1] ? m[1] : 'br').toLowerCase();
    }

    /**
     * Garante id string numérica (nunca objeto em template string).
     * @param {unknown} productId
     */
    function safeProductIdString(productId) {
      if (productId == null) return '';
      if (typeof productId === 'string' && /^\d{8,}$/.test(productId.trim())) return productId.trim();
      if (typeof productId === 'number' && isFinite(productId)) return String(Math.trunc(productId));
      const s = String(productId).replace(/\D/g, '');
      return s.length >= 8 ? s : String(productId ?? '').trim();
    }

    /** @param {unknown} productId */
    function regionalPdpUrl(productId) {
      const sid = safeProductIdString(productId);
      if (!/^\d{8,}$/.test(sid)) return '';
      return `https://shop.tiktok.com/${pathRegion()}/pdp/${sid}`;
    }

    /**
     * URL real: nunca fazer String(obj) (vira "[object Object]" e estoura o pathname).
     * @param {unknown} x
     * @returns {string}
     */
    function urlStringFromField(x) {
      if (x == null) return '';
      if (typeof x === 'string') {
        const t = x.trim();
        return t && t !== '[object Object]' ? t : '';
      }
      if (typeof x === 'object') {
        const o = /** @type {Record<string, unknown>} */ (x);
        const inner = [
          o.url,
          o.href,
          o.link,
          o.uri,
          o.path,
          o.jump_url,
          o.jumpUrl,
          o.detail_url,
          o.detailUrl,
          o.web_url,
          o.webUrl,
          o.seo_url,
          o.seoUrl,
          o.pdp_url,
          o.pdpUrl,
          o.product_url,
          o.productUrl,
        ];
        for (const v of inner) {
          if (typeof v === 'string' && v.trim() && v.trim() !== '[object Object]') return v.trim();
        }
      }
      return '';
    }

    /**
     * Preferir PDP regional (/br/pdp/…) — evita /view/product/{id} que costuma cair em “Security Check” ao abrir direto.
     * @param {string} raw
     * @param {string} productId
     */
    function normalizeProductUrlCandidate(raw, productId) {
      if (!raw || !String(raw).trim() || raw.trim() === '[object Object]') return '';
      let s = String(raw).trim();
      if (s.startsWith('//')) s = `https:${s}`;
      else if (s.startsWith('/')) s = `https://shop.tiktok.com${s}`;
      /** @type {URL} */
      let parsed;
      try {
        parsed = new URL(s, 'https://shop.tiktok.com');
      } catch {
        return '';
      }
      if (!parsed.hostname.toLowerCase().includes('tiktok.com')) return '';
      const path = parsed.pathname || '';
      if (/\/pdp\//i.test(path)) {
        return parsed.href.split(/[?#]/)[0];
      }
      if (path.includes('/view/product/')) {
        return regionalPdpUrl(productId);
      }
      return parsed.href.split(/[?#]/)[0];
    }

    /**
     * @param {Record<string, unknown>} p
     * @param {string} id
     */
    function pickLink(p, id) {
      const candidates = [
        p.url,
        p.link,
        p.jump_url,
        p.jumpUrl,
        p.detail_url,
        p.detailUrl,
        p.pdp_url,
        p.pdpUrl,
        p.seo_url,
        p.seoUrl,
        p.product_url,
        p.productUrl,
        p.web_url,
        p.webUrl,
      ];
      for (const x of candidates) {
        const str = urlStringFromField(x);
        if (!str) continue;
        const u = normalizeProductUrlCandidate(str, id);
        if (u && /\/pdp\//i.test(u)) return u;
      }
      for (const x of candidates) {
        const str = urlStringFromField(x);
        if (!str) continue;
        const u = normalizeProductUrlCandidate(str, id);
        if (u && !/\/view\/product\//i.test(u) && u.includes('tiktok.com')) return u;
      }
      return regionalPdpUrl(id) || `https://shop.tiktok.com/${pathRegion()}/pdp/${id}`;
    }

    /** @param {unknown} ppi */
    function priceToNumber(ppi) {
      if (!ppi || typeof ppi !== 'object') return 0;
      function num(v) {
        if (v == null || v === '') return null;
        if (typeof v === 'number' && isFinite(v)) return v >= 0 ? v : null;
        const s = String(v).replace(/[^\d.,]/g, '').replace(',', '.');
        const x = parseFloat(s);
        return isFinite(x) && x >= 0 ? x : null;
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
        if (n != null) return n;
      }
      n =
        num(p.discount_price_decimal) ||
        num(p.discount_price) ||
        num(p.sale_price_decimal) ||
        num(p.sale_price);
      if (n != null) return n;
      n = num(p.price_current) ?? num(p.price);
      if (n != null) return n;
      n = num(p.sale_price_format) ?? num(p.price_text);
      return n != null ? n : 0;
    }

    /** @param {Record<string, unknown>} p */
    function firstImg(p) {
      const im = p.image || p.cover;
      if (im && typeof im === 'object') {
        const list = im.url_list || im.urlList || im.urls;
        if (Array.isArray(list) && list[0]) return String(list[0]);
        if (im.url) return String(im.url);
      }
      return '';
    }

    /** @param {unknown} v */
    function strClean(v) {
      if (v == null) return '';
      if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim();
      if (typeof v === 'number' && isFinite(v)) return String(v);
      if (typeof v === 'object') return '';
      return String(v).replace(/\s+/g, ' ').trim();
    }

    /**
     * @param {Record<string, unknown> | null | undefined} o
     * @param {string[]} keys
     */
    function pickFromKeys(o, keys) {
      if (!o || typeof o !== 'object') return '';
      for (const k of keys) {
        const t = strClean(/** @type {Record<string, unknown>} */ (o)[k]);
        if (t) return t;
      }
      return '';
    }

    /** @param {Record<string, unknown>} p */
    function shopNameFrom(p) {
      let t = pickFromKeys(p, [
        'shop_name',
        'shopName',
        'seller_name',
        'sellerName',
        'store_name',
        'storeName',
        'shop_title',
        'shopTitle',
      ]);
      if (t) return t;

      const pinfoRaw = p.product_info || p.productInfo;
      const pinfo =
        pinfoRaw && typeof pinfoRaw === 'object'
          ? /** @type {Record<string, unknown>} */ (pinfoRaw)
          : p;

      t = pickFromKeys(pinfo, [
        'shop_name',
        'shopName',
        'seller_name',
        'sellerName',
        'store_name',
        'storeName',
      ]);
      if (t) return t;

      const sm = pinfo.seller_model || pinfo.sellerModel || p.seller_model || p.sellerModel;
      if (sm && typeof sm === 'object') {
        t = pickFromKeys(/** @type {Record<string, unknown>} */ (sm), [
          'shop_name',
          'shopName',
          'seller_name',
          'sellerName',
          'name',
        ]);
        if (t) return t;
      }

      const sinfo = pinfo.shop_info || pinfo.shopInfo || p.shop_info || p.shopInfo;
      if (sinfo && typeof sinfo === 'object') {
        t = pickFromKeys(/** @type {Record<string, unknown>} */ (sinfo), [
          'shop_name',
          'shopName',
          'seller_name',
          'sellerName',
        ]);
        if (t) return t;
      }

      const userInfo = p.user_info || p.userInfo;
      if (userInfo && typeof userInfo === 'object') {
        t = pickFromKeys(/** @type {Record<string, unknown>} */ (userInfo), [
          'shop_name',
          'shopName',
          'seller_name',
          'nickname',
          'store_name',
        ]);
        if (t) return t;
      }

      const sel = pinfo.seller || pinfo.seller_info || pinfo.sellerInfo || p.seller;
      if (sel && typeof sel === 'object') {
        t = pickFromKeys(/** @type {Record<string, unknown>} */ (sel), [
          'shop_name',
          'shopName',
          'name',
          'seller_name',
          'sellerName',
        ]);
        if (t) return t;
      }

      const mkt = p.product_marketing_info || p.productMarketingInfo;
      if (mkt && typeof mkt === 'object') {
        t = pickFromKeys(/** @type {Record<string, unknown>} */ (mkt), [
          'seller_name',
          'sellerName',
          'shop_name',
          'shopName',
        ]);
        if (t) return t;
      }

      return '';
    }

    /** @param {unknown} o */
    function isProductish(o) {
      if (!o || typeof o !== 'object') return false;
      const pr = /** @type {Record<string, unknown>} */ (o);
      const id = safeProductIdString(pr.product_id ?? pr.productId);
      return /^\d{8,}$/.test(id);
    }

    /**
     * @param {unknown} o
     * @returns {unknown[]}
     */
    function findLargestProductList(o) {
      /** @type {unknown[]} */
      let best = [];
      function walk(node, depth) {
        if (depth > 22 || node === null || node === undefined) return;
        if (Array.isArray(node)) {
          for (const x of node) walk(x, depth + 1);
          return;
        }
        if (typeof node !== 'object') return;
        const rec = /** @type {Record<string, unknown>} */ (node);
        for (const key of LIST_KEYS) {
          const pl = rec[key];
          if (Array.isArray(pl) && pl.length > best.length && pl.some(isProductish)) {
            best = pl;
          }
        }
        for (const k of Object.keys(rec)) walk(rec[k], depth + 1);
      }
      walk(o, 0);
      return best;
    }

    /**
     * @param {unknown} o
     * @returns {unknown[]}
     */
    function collectAllProductsDedup(o) {
      const seen = new Set();
      /** @type {unknown[]} */
      const acc = [];
      function walk(node, depth) {
        if (depth > 22 || node === null || node === undefined) return;
        if (Array.isArray(node)) {
          for (const x of node) walk(x, depth + 1);
          return;
        }
        if (typeof node !== 'object') return;
        const rec = /** @type {Record<string, unknown>} */ (node);
        for (const key of LIST_KEYS) {
          const pl = rec[key];
          if (!Array.isArray(pl)) continue;
          for (const item of pl) {
            if (!isProductish(item)) continue;
            const p = /** @type {Record<string, unknown>} */ (item);
            const id = safeProductIdString(p.product_id ?? p.productId);
            if (!/^\d{8,}$/.test(id) || seen.has(id)) continue;
            seen.add(id);
            acc.push(item);
          }
        }
        for (const k of Object.keys(rec)) walk(rec[k], depth + 1);
      }
      walk(o, 0);
      return acc;
    }

    /**
     * @returns {Array<Record<string, unknown>>}
     */
    function extractFromDomDashboard() {
      const root = document.querySelector('main') || document.body;
      const seen = new Set();
      /** @type {Array<Record<string, unknown>>} */
      const rows = [];
      const anchors = root.querySelectorAll('a[href*="/view/product/"], a[href*="/pdp/"]');
      for (const a of anchors) {
        let href = '';
        try {
          href = new URL(/** @type {HTMLAnchorElement} */ (a).href, location.href).href.split(/[?#]/)[0];
        } catch {
          continue;
        }
        let m = href.match(/\/view\/product\/(?:[^/]+\/)?(\d{8,})\/?$/i);
        if (!m) m = href.match(/\/pdp\/(?:[^/]+\/)?(\d{8,})\/?$/i);
        if (!m) continue;
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);
        const productUrl = regionalPdpUrl(id);
        const elA = /** @type {HTMLAnchorElement} */ (a);
        let name = (
          elA.getAttribute('aria-label') ||
          elA.innerText ||
          elA.textContent ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .split('\n')[0]
          .slice(0, 400);
        let img = '';
        let shopNameDom = '';
        let el = elA;
        for (let up = 0; up < 8 && el; up++) {
          el = el.parentElement;
          if (!el) break;
          const im = el.querySelector(
            'img[src*="tiktokcdn"], img[src*="ibyteimg"], img[src*="ttwstatic"], img[src*="tiktok"]'
          );
          if (im && /** @type {HTMLImageElement} */ (im).src) {
            img = /** @type {HTMLImageElement} */ (im).src.split('?')[0];
          }
          if (!shopNameDom) {
            const storeA = el.querySelector('a[href*="/store/"]');
            if (storeA) {
              shopNameDom = (storeA.textContent || storeA.getAttribute('aria-label') || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 300);
            }
          }
        }
        rows.push({
          dashboard_rank: rows.length + 1,
          product_id: id,
          product_url: productUrl || regionalPdpUrl(id),
          name,
          price_current: 0,
          shop_name: shopNameDom,
          image_main: img,
        });
      }
      return rows;
    }

    function mapListToRows(list) {
      /** @type {Array<Record<string, unknown>>} */
      const out = [];
      let rank = 0;
      for (const item of list) {
        if (!isProductish(item)) continue;
        const p = /** @type {Record<string, unknown>} */ (item);
        const id = safeProductIdString(p.product_id ?? p.productId);
        if (!/^\d{8,}$/.test(id)) continue;
        rank += 1;
        const pinfo = p.product_price_info ?? p.productPriceInfo;
        const name = String(p.title ?? p.name ?? p.product_name ?? '').trim();
        let pUrl = pickLink(p, id);
        if (!pUrl || pUrl.includes('[object Object]') || pUrl.includes('%5Bobject%20Object%5D')) {
          pUrl = regionalPdpUrl(id) || `https://shop.tiktok.com/${pathRegion()}/pdp/${id}`;
        }
        out.push({
          dashboard_rank: rank,
          product_id: id,
          product_url: pUrl,
          name,
          price_current: priceToNumber(
            pinfo && typeof pinfo === 'object' ? pinfo : undefined
          ),
          shop_name: shopNameFrom(p),
          image_main: firstImg(p),
        });
      }
      return out;
    }

    const el = document.querySelector('script#__MODERN_ROUTER_DATA__');
    if (el?.textContent?.trim()) {
      try {
        const router = JSON.parse(el.textContent);
        let list = findLargestProductList(router);
        if (!Array.isArray(list) || list.length === 0) {
          list = collectAllProductsDedup(router);
        }
        const fromJson = mapListToRows(list);
        if (fromJson.length > 0) return fromJson;
      } catch {
        /* DOM fallback */
      }
    }

    return extractFromDomDashboard();
  });
}
