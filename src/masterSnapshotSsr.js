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

    /** @param {string} productId */
    function regionalPdpUrl(productId) {
      return `https://shop.tiktok.com/${pathRegion()}/pdp/${productId}`;
    }

    /**
     * Preferir PDP regional (/br/pdp/…) — evita /view/product/{id} que costuma cair em “Security Check” ao abrir direto.
     * @param {string} raw
     * @param {string} productId
     */
    function normalizeProductUrlCandidate(raw, productId) {
      if (!raw || !String(raw).trim()) return '';
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
      const ordered = [
        p.pdp_url,
        p.pdpUrl,
        p.seo_url,
        p.seoUrl,
        p.product_url,
        p.productUrl,
      ];
      for (const x of ordered) {
        const u = normalizeProductUrlCandidate(x ? String(x).trim() : '', id);
        if (u && /\/pdp\//i.test(u)) return u;
      }
      for (const x of ordered) {
        const u = normalizeProductUrlCandidate(x ? String(x).trim() : '', id);
        if (u && !/\/view\/product\//i.test(u)) return u;
      }
      return regionalPdpUrl(id);
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

    /** @param {Record<string, unknown>} p */
    function shopNameFrom(p) {
      const pinfo =
        (p.product_info || p.productInfo) && typeof (p.product_info || p.productInfo) === 'object'
          ? /** @type {Record<string, unknown>} */ (p.product_info || p.productInfo)
          : p;
      const sm = pinfo.seller_model || pinfo.sellerModel || p.seller_model || p.sellerModel;
      if (sm && typeof sm === 'object') {
        const sn = String(
          /** @type {Record<string, unknown>} */ (sm).shop_name ||
            /** @type {Record<string, unknown>} */ (sm).shopName ||
            ''
        ).trim();
        if (sn) return sn;
      }
      const sinfo = pinfo.shop_info || pinfo.shopInfo || p.shop_info || p.shopInfo;
      if (sinfo && typeof sinfo === 'object') {
        const sn = String(
          /** @type {Record<string, unknown>} */ (sinfo).shop_name ||
            /** @type {Record<string, unknown>} */ (sinfo).shopName ||
            ''
        ).trim();
        if (sn) return sn;
      }
      const mkt = p.product_marketing_info || p.productMarketingInfo;
      if (mkt && typeof mkt === 'object') {
        const sellerName = String(
          /** @type {Record<string, unknown>} */ (mkt).seller_name ||
            /** @type {Record<string, unknown>} */ (mkt).sellerName ||
            /** @type {Record<string, unknown>} */ (mkt).shop_name ||
            ''
        ).trim();
        if (sellerName) return sellerName;
      }
      return '';
    }

    /** @param {unknown} o */
    function isProductish(o) {
      if (!o || typeof o !== 'object') return false;
      const id = String(
        /** @type {Record<string, unknown>} */ (o).product_id ??
          /** @type {Record<string, unknown>} */ (o).productId ??
          ''
      ).trim();
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
            const id = String(p.product_id ?? p.productId ?? '').trim();
            if (seen.has(id)) continue;
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
        }
        rows.push({
          dashboard_rank: rows.length + 1,
          product_id: id,
          product_url: productUrl,
          name,
          price_current: 0,
          shop_name: '',
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
        const id = String(p.product_id ?? p.productId ?? '').trim();
        rank += 1;
        const pinfo = p.product_price_info ?? p.productPriceInfo;
        const name = String(p.title ?? p.name ?? p.product_name ?? '').trim();
        out.push({
          dashboard_rank: rank,
          product_id: id,
          product_url: pickLink(p, id),
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
