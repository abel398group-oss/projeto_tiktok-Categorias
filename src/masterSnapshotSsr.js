/**
 * Extrai produtos visíveis no dashboard de uma categoria master.
 * 1) DOM do cartão (vitrine) — preço, “de” riscado, %, frete, vendidos como na tela.
 * 2) __MODERN_ROUTER_DATA__ — preenche campos em falta (imagem, loja, ratings, etc.).
 * 3) Se não houver cartões com âncora: só SSR. Se SSR falhar, DOM parcial.
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

    /**
     * @param {unknown} v
     * @returns {number | null}
     */
    function parseMoneyToNumber(v) {
      if (v == null || v === '') return null;
      if (typeof v === 'number' && isFinite(v)) return v >= 0 ? v : null;
      const s = String(v).replace(/[^\d.,]/g, '').replace(',', '.');
      const x = parseFloat(s);
      return isFinite(x) && x >= 0 ? x : null;
    }

    /**
     * "R$ 1.234,56" (milhar BR) e "R$ 74,92" — para texto visível do cartão.
     * @param {string} raw
     * @returns {number | null}
     */
    function parseBrVisibleMoneyString(raw) {
      const t = String(raw)
        .replace(/R\$\s*/i, '')
        .trim()
        .replace(/[^\d.,]/g, '');
      if (!t) return null;
      if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(t)) {
        const x = parseFloat(t.replace(/\./g, '').replace(',', '.'));
        return isFinite(x) && x >= 0 ? x : null;
      }
      if (/\d+,\d{1,2}$/.test(t)) {
        const x = parseFloat(t.replace(/\./g, '').replace(',', '.'));
        return isFinite(x) && x >= 0 ? x : null;
      }
      if (/^\d+\.\d{2}$/.test(t) && t.indexOf(',') < 0) {
        const x = parseFloat(t);
        return isFinite(x) && x >= 0 ? x : null;
      }
      return parseMoneyToNumber('R$ ' + t);
    }

    /**
     * Alinhado a `productExtract.pickPrecoAtual`: evita pegar só `min_price.sale_price_decimal`
     * (mínimo entre variantes, ex. 104,9) e ignorar `real_time_price` / `price_current` (PDP, ex. 109,9).
     * @param {unknown} ppi product_price_info
     * @param {Record<string, unknown> | null} [root] nó do produto (card / feed)
     */
    function priceToNumber(ppi, root) {
      function num(v) {
        return parseMoneyToNumber(v);
      }
      const p = ppi && typeof ppi === 'object' ? /** @type {Record<string, unknown>} */ (ppi) : null;
      const r = root && typeof root === 'object' ? root : null;
      if (!p && !r) return 0;
      const pBase = r
        ? (r.product_base && typeof r.product_base === 'object' ? r.product_base : r.productBase)
        : null;
      const pb =
        pBase && typeof pBase === 'object' && pBase !== null
          ? /** @type {Record<string, unknown>} */ (pBase).price
          : null;
      const priceB = pb && typeof pb === 'object' ? /** @type {Record<string, unknown>} */ (pb) : null;

      /** @type {number | null} */
      let n = null;
      if (p) {
        n = num(p.discount_price_decimal) || num(p.discount_price);
        if (n != null) return n;
        n = num(p.real_time_price);
        if (n != null) return n;
        n = num(p.sale_price_format) || num(p.format_discount_price) || num(p.sale_price_integer_part_format);
        if (n != null) return n;
        n = num(p.price_current) || num(p.show_price) || num(p.format_price) || num(p.price_text);
        if (n != null) return n;
      }
      if (r) {
        n = num(r.discount_price) || num(r.sale_price) || num(r.min_sale_price);
        if (n != null) return n;
        n = num(r.real_time_price);
        if (n != null) return n;
        n = num(r.price_current) || num(r.display_price) || num(r.current_price) || num(r.price);
        if (n != null) return n;
      }
      if (priceB) {
        n =
          num(priceB.discount_price) ||
          num(priceB.sale_price) ||
          num(priceB.real_price) ||
          num(priceB.current_price) ||
          num(priceB.min_sku_price);
        if (n != null) return n;
      }
      if (p) {
        const min = p.min_price ?? p.minPrice;
        if (min && typeof min === 'object') {
          const m = /** @type {Record<string, unknown>} */ (min);
          n =
            num(m.real_time_price) ||
            num(m.real_time_sale_price) ||
            num(m.real_price_decimal) ||
            num(m.real_price) ||
            num(m.sale_price_decimal) ||
            num(m.single_product_price_decimal) ||
            num(m.min_sale_price) ||
            num(m.price_val);
          if (n != null) return n;
        }
        n = num(p.sale_price_decimal) || num(p.sale_price) || num(p.price);
        if (n != null) return n;
        n = num(p.sale_price_format) || num(p.price_text);
        if (n != null) return n;
      }
      return 0;
    }

    /**
     * Preço “de”/tachado e desconto % a partir de product_price_info (vitrine / SSR).
     * @param {Record<string, unknown>} p
     * @returns {{ price_original: number | null; discount_percent: number | null }}
     */
    function priceExtrasFromProduct(p) {
      /** @type {number | null} */
      let price_original = null;
      /** @type {number | null} */
      let discount_percent = null;

      const ppi = p.product_price_info ?? p.productPriceInfo;
      if (!ppi || typeof ppi !== 'object') {
        return { price_original, discount_percent };
      }
      const P = /** @type {Record<string, unknown>} */ (ppi);

      function readOriginFromMin(/** @type {Record<string, unknown>} */ m) {
        const op =
          m.origin_price_decimal ??
          m.originPriceDecimal ??
          m.original_price_decimal ??
          m.origin_price ??
          m.original_price;
        if (op == null) return;
        const n = parseMoneyToNumber(op);
        if (n != null && n > 0) price_original = n;
      }

      const min0 = P.min_price ?? P.minPrice;
      if (min0 && typeof min0 === 'object') {
        readOriginFromMin(/** @type {Record<string, unknown>} */ (min0));
        const m = /** @type {Record<string, unknown>} */ (min0);
        const ddec = m.discount_decimal ?? m.discountDecimal;
        if (ddec != null && discount_percent == null) {
          const n = parseMoneyToNumber(ddec);
          if (n != null && n > 0) {
            discount_percent = n > 0 && n <= 1 ? Math.round(n * 100) : Math.min(100, Math.round(n));
          }
        }
        const df = m.discount_format ?? m.discountFormat;
        if (df != null && discount_percent == null) {
          const s = String(df);
          const pctMatch = s.match(/-?\s*(\d{1,3})\s*%/);
          if (pctMatch) discount_percent = parseInt(pctMatch[1], 10);
        }
      }

      if (price_original == null) {
        const od =
          P.origin_price_decimal ??
          P.original_price_decimal ??
          P.origin_price ??
          P.original_price;
        if (od != null) {
          const n = parseMoneyToNumber(od);
          if (n != null && n > 0) price_original = n;
        }
      }

      const prom = P.promotion_model ?? P.promotionModel;
      if (prom && typeof prom === 'object' && price_original == null) {
        const pmR = /** @type {Record<string, unknown>} */ (prom);
        const ppp = pmR.promotion_product_price ?? pmR.promotionProductPrice;
        if (ppp && typeof ppp === 'object') {
          const pppR = /** @type {Record<string, unknown>} */ (ppp);
          const min1 = pppR.min_price ?? pppR.minPrice;
          if (min1 && typeof min1 === 'object') {
            readOriginFromMin(/** @type {Record<string, unknown>} */ (min1));
          }
        }
      }

      for (const key of [
        'discount',
        'discount_percent',
        'discount_percentage',
        'discountPercent',
        'price_discount',
      ]) {
        if (discount_percent != null) break;
        const dRaw = P[key];
        if (dRaw == null) continue;
        const d = typeof dRaw === 'number' ? dRaw : parseFloat(String(dRaw).replace(/[^\d.-]/g, ''));
        if (Number.isFinite(d)) {
          if (d > 0 && d <= 1) discount_percent = Math.round(d * 100);
          else if (d > 1 && d <= 100) discount_percent = Math.round(d);
        }
      }

      const current = priceToNumber(ppi, p);
      if (price_original != null && current > 0 && price_original > current) {
        if (discount_percent == null) {
          discount_percent = Math.max(0, Math.min(100, Math.round(100 * (1 - current / price_original))));
        }
      } else if (current > 0 && price_original == null) {
        /* preço promocional sem “de” no payload — fica null */
      }

      return { price_original, discount_percent };
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

    /**
     * @param {string} chunk
     * @returns {number | null}
     */
    function parseSoldMagnitudeToken(chunk) {
      const t0 = String(chunk).trim();
      if (!t0) return null;
      const kmb = t0.match(/^([\d.,]+)\s*([kKmM])$/i);
      if (kmb) {
        const part = kmb[1].trim();
        const suf = kmb[2].toLowerCase();
        let p = part;
        if (/^\d+,\d{1,3}$/.test(p) && !/\./.test(p)) p = p.replace(',', '.');
        else if (/^\d{1,3}(?:\.\d{3})+,\d{2}$/.test(p)) p = p.replace(/\./g, '').replace(',', '.');
        else if (/^\d{1,3}(?:\.\d{3})+$/.test(p)) p = p.replace(/\./g, '');
        const n0 = parseFloat(p);
        if (!Number.isFinite(n0) || n0 < 0) return null;
        const mult = suf === 'k' ? 1000 : suf === 'm' ? 1_000_000 : 1_000_000_000;
        return Math.floor(n0 * mult);
      }
      let t = t0;
      if (/^\d+,\d{1,3}$/.test(t) && !/\./.test(t)) t = t.replace(',', '.');
      else if (/^\d{1,3}(?:\.\d{3})+,\d{2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
      else if (/^\d{1,3}(?:\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
      const n = parseFloat(t);
      if (Number.isFinite(n) && n >= 0) return Math.floor(n);
      return null;
    }

    /**
     * "45,3K", "1 vendido(s)", "15270" → inteiro. Não cola todos os dígitos se houver R$ e % (evita 53103510).
     * @param {unknown} v
     * @returns {number | null}
     */
    function parseSoldCountFromDisplayText(v) {
      if (v == null) return null;
      const s0 = String(v)
        .trim()
        .replace(/[\u00a0\u202f]/g, ' ');
      if (!s0) return null;

      // Número imediatamente antes de "vendido(s)" / "vendidos"
      const mBeforeV = s0.match(
        /(?:^|[^\d.,%R$€])([\d.,]+[KkMm]?)\s*\+?\s*vendidos?(?:\([^)]*\))?/i
      );
      if (mBeforeV) {
        const n = parseSoldMagnitudeToken(mBeforeV[1]);
        if (n != null) return n;
      }
      // "vendidos: 10"
      const mAfterV = s0.match(
        /\bvendidos?(?:\([^)]*\))?\s*[:·\-]?\s*([\d.,]+[KkMm]?)(?![\d.,]*%)/i
      );
      if (mAfterV) {
        const n = parseSoldMagnitudeToken(mAfterV[1]);
        if (n != null) return n;
      }

      const kmb = s0.match(/([\d.,]+)\s*([kKmM])\b/i);
      if (kmb) {
        const n = parseSoldMagnitudeToken(String(kmb[1]).trim() + kmb[2]);
        if (n != null) return n;
      }

      if (/\b(mil|thousand)\b/i.test(s0)) {
        const m2 = s0.match(/([\d.,]+)\s*(?:mil|thousand)/i);
        if (m2) {
          const n2 = parseSoldMagnitudeToken(m2[1]);
          if (n2 != null) return n2;
        }
      }

      if (/%/i.test(s0) || /R\$\s*[\d.,]/i.test(s0)) {
        return null;
      }
      const digits = s0.replace(/[^\d]/g, '');
      if (digits.length >= 1 && digits.length <= 9) {
        const n = parseInt(digits, 10);
        if (Number.isFinite(n) && n >= 0) return n;
      }
      return null;
    }

    /**
     * Junta `format_sold_count` (texto com K/M) e `sold_count` (inteiro do API, por vezes outra métrica).
     * @param {number | null} nFromFmt
     * @param {number | null} nRaw
     * @param {string | null} fmtStr
     * @returns {number | null}
     */
    function mergeSoldNumber(nFromFmt, nRaw, fmtStr) {
      if (nFromFmt != null && nRaw != null) {
        const hasScale = fmtStr && /[kKmM]/.test(String(fmtStr));
        if (hasScale) return nFromFmt;
        if (nFromFmt >= nRaw) return nFromFmt;
        return nRaw;
      }
      if (nFromFmt != null) return nFromFmt;
      return nRaw;
    }

    /**
     * Quantidade vendida (quando o feed expõe). Muitos produtos novos não trazem `sold_info`.
     * @param {Record<string, unknown>} p
     * @returns {{ sold_text: string; sold_count: number | null }}
     */
    function soldInfoFrom(p) {
      /** @type {number | null} */
      let sold_count = null;
      let sold_text = '';

      function applySoldBlock(/** @type {Record<string, unknown>} */ s) {
        const fmt =
          s.format_sold_count ?? s.formatSoldCount ?? s.sold_count_text ?? s.soldCountText;
        const raw =
          s.sold_count ??
          s.soldCount ??
          s.global_sold_count ??
          s.globalSoldCount ??
          s.total_sold_count ??
          s.totalSoldCount;

        if (fmt != null && String(fmt).trim()) {
          sold_text = String(fmt).trim();
        }

        const nFromFmt = fmt != null && String(fmt).trim() ? parseSoldCountFromDisplayText(fmt) : null;
        /** @type {number | null} */
        let nRaw = null;
        if (raw != null && String(raw).trim() !== '') {
          const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^\d.-]/g, ''));
          if (Number.isFinite(n) && n >= 0) nRaw = Math.floor(n);
        }
        const merged = mergeSoldNumber(nFromFmt, nRaw, fmt != null ? String(fmt) : null);
        if (merged != null) {
          sold_count = merged;
          if (!sold_text) sold_text = String(merged);
        } else if (nRaw != null) {
          sold_count = nRaw;
          if (!sold_text) sold_text = String(nRaw);
        } else if (nFromFmt != null) {
          sold_count = nFromFmt;
          if (!sold_text) sold_text = String(nFromFmt);
        }
      }

      const sold = p.sold_info || p.soldInfo;
      if (sold && typeof sold === 'object') {
        applySoldBlock(/** @type {Record<string, unknown>} */ (sold));
      }

      if (sold_count == null && !sold_text) {
        const mkt = p.product_marketing_info || p.productMarketingInfo;
        if (mkt && typeof mkt === 'object') {
          const m = /** @type {Record<string, unknown>} */ (mkt);
          const t =
            m.format_sold_count ??
            m.formatSoldCount ??
            m.sold_count_text ??
            m.sold_text;
          if (t != null && String(t).trim()) sold_text = String(t).trim();
          const nFromFmt = t != null && String(t).trim() ? parseSoldCountFromDisplayText(t) : null;
          const sc =
            m.sold_count ??
            m.soldCount ??
            m.global_sold_count ??
            m.globalSoldCount;
          /** @type {number | null} */
          let nRaw = null;
          if (sc != null && String(sc).trim() !== '') {
            const n = typeof sc === 'number' ? sc : Number(String(sc).replace(/[^\d.-]/g, ''));
            if (Number.isFinite(n) && n >= 0) nRaw = Math.floor(n);
          }
          const merged = mergeSoldNumber(nFromFmt, nRaw, t != null ? String(t) : null);
          if (merged != null) sold_count = merged;
        }
      }

      if (sold_count == null && !sold_text) {
        const pinfo = p.product_info || p.productInfo;
        if (pinfo && typeof pinfo === 'object') {
          const si = (/** @type {Record<string, unknown>} */ (pinfo)).sold_info
            || (/** @type {Record<string, unknown>} */ (pinfo)).soldInfo;
          if (si && typeof si === 'object') {
            applySoldBlock(/** @type {Record<string, unknown>} */ (si));
          }
        }
      }

      /**
       * O bloco de marketing costuma trazer o texto com K/M; `sold_info` às vezes traz outro inteiro.
       * Se existir "45,3K" em qualquer sítio, preferir a contagem derivada desse texto.
       */
      function bestFmtFrom(/** @type {Record<string, unknown> | null | undefined} */ o) {
        if (!o || typeof o !== 'object') return '';
        return String(
          o.format_sold_count ??
            o.formatSoldCount ??
            o.sold_count_text ??
            o.soldCountText ??
            o.sold_text ??
            ''
        ).trim();
      }
      const fmtCandidates = [
        bestFmtFrom(/** @type {Record<string, unknown> | null} */ (p.sold_info || p.soldInfo)),
        bestFmtFrom(
          p.product_marketing_info && typeof p.product_marketing_info === 'object'
            ? /** @type {Record<string, unknown>} */ (p.product_marketing_info)
            : null
        ),
        bestFmtFrom(
          p.productMarketingInfo && typeof p.productMarketingInfo === 'object'
            ? /** @type {Record<string, unknown>} */ (p.productMarketingInfo)
            : null
        ),
      ].filter(Boolean);
      let bestK = 0;
      let bestStr = '';
      for (const fs of fmtCandidates) {
        if (!/[kKmM]/.test(fs)) continue;
        const n = parseSoldCountFromDisplayText(fs);
        if (n != null && n > bestK) {
          bestK = n;
          bestStr = fs;
        }
      }
      if (bestK > 0) {
        if (sold_count == null || bestK > sold_count) {
          sold_count = bestK;
          if (bestStr) sold_text = bestStr;
        }
      }

      return { sold_text, sold_count };
    }

    /**
     * Nota média, quantidade de avaliações e, se existir, distribuição por estrelas (SSR / review_model).
     * @param {Record<string, unknown>} p
     * @returns {{ rating: number | null; rating_count: number | null; rating_distribution: unknown | null }}
     */
    function ratingInfoFrom(p) {
      /** @type {number | null} */
      let rating = null;
      /** @type {number | null} */
      let rating_count = null;
      /** @type {unknown | null} */
      let rating_distribution = null;

      function numOrNull(/** @type {unknown} */ v) {
        if (v == null || v === '') return null;
        if (typeof v === 'number' && isFinite(v)) return v;
        let t = String(v).trim();
        if (/^\d+,\d+$/.test(t)) t = t.replace(',', '.');
        const s = t.replace(/[^\d.-]/g, '');
        if (!s) return null;
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : null;
      }

      /** "2000" | "2.0K" (API) → inteiro. Reutiliza o mesmo K/M que `format_sold_count`. */
      function reviewCountFromField(/** @type {unknown} */ v) {
        if (v == null || v === '') return null;
        if (typeof v === 'number' && isFinite(v)) return Math.max(0, Math.floor(v));
        const s = String(v).trim();
        const fromScaled = parseSoldCountFromDisplayText(s);
        if (fromScaled != null) return Math.max(0, Math.floor(fromScaled));
        const n = numOrNull(s);
        if (n != null) return Math.max(0, Math.floor(n));
        return null;
      }

      function applyReviewModel(/** @type {Record<string, unknown>} */ rm) {
        if (rating_count == null) {
          const rc = rm.product_review_count ?? rm.productReviewCount;
          const n = reviewCountFromField(rc);
          if (n != null) rating_count = n;
        }
        if (rating == null) {
          const os = rm.product_overall_score ?? rm.productOverallScore;
          const n = numOrNull(os);
          if (n != null) rating = n;
        }
        if (rating_distribution == null) {
          const dist =
            rm.rating_distribution ??
            rm.ratingDistribution ??
            rm.review_star_rating_distribution ??
            rm.reviewStarRatingDistribution ??
            rm.star_rating_distribution ??
            rm.starRatingDistribution;
          if (dist != null && typeof dist === 'object') {
            const empty = Array.isArray(dist) ? dist.length === 0 : Object.keys(/** @type {object} */ (dist)).length === 0;
            if (!empty) rating_distribution = dist;
          }
        }
      }

      const rate = p.rate_info || p.rateInfo;
      if (rate && typeof rate === 'object') {
        const r = /** @type {Record<string, unknown>} */ (rate);
        if (rating == null) {
          const sc = r.score ?? r.rating ?? r.star_rating ?? r.avg_rating ?? r.average_rating;
          const n = numOrNull(sc);
          if (n != null) rating = n;
        }
        if (rating_count == null) {
          const rc = r.review_count ?? r.reviewCount;
          const n = reviewCountFromField(rc);
          if (n != null) rating_count = n;
        }
      }

      if (rating == null) {
        const pr =
          p.product_rating ??
          p.productRating ??
          p.avg_rating ??
          p.rating_score ??
          p.rating;
        const n = numOrNull(pr);
        if (n != null) rating = n;
      }

      /**
       * @param {Record<string, unknown>} pi
       */
      function mergePinfo(pi) {
        const rm = pi.review_model ?? pi.reviewModel;
        if (rm && typeof rm === 'object') {
          applyReviewModel(/** @type {Record<string, unknown>} */ (rm));
        }
        const rinfo = pi.review_info ?? pi.reviewInfo;
        if (rinfo && typeof rinfo === 'object' && rating_distribution == null) {
          const ri = /** @type {Record<string, unknown>} */ (rinfo);
          const rr = ri.review_ratings ?? ri.reviewRatings;
          if (rr && typeof rr === 'object') {
            const res = /** @type {Record<string, unknown>} */ (rr).rating_result
              ?? /** @type {Record<string, unknown>} */ (rr).ratingResult;
            if (res != null && typeof res === 'object') {
              const empty = Array.isArray(res) ? res.length === 0 : Object.keys(/** @type {object} */ (res)).length === 0;
              if (!empty) rating_distribution = res;
            }
          }
        }
      }

      const pinfo = p.product_info || p.productInfo;
      if (pinfo && typeof pinfo === 'object') {
        mergePinfo(/** @type {Record<string, unknown>} */ (pinfo));
      }

      const rmRoot = p.review_model ?? p.reviewModel;
      if (rmRoot && typeof rmRoot === 'object') {
        applyReviewModel(/** @type {Record<string, unknown>} */ (rmRoot));
      }

      if (rating_count == null) {
        const mkt = p.product_marketing_info || p.productMarketingInfo;
        if (mkt && typeof mkt === 'object') {
          const m = /** @type {Record<string, unknown>} */ (mkt);
          const rc = m.review_count ?? m.reviewCount;
          const n = reviewCountFromField(rc);
          if (n != null) rating_count = n;
        }
      }

      return { rating, rating_count, rating_distribution };
    }

    /**
     * Cartão/PDP: “4,3 ★ (465)”, “5★(6)”, “4.3 ★ (2.0K)”.
     * Entre parênteses, K/M como em vendas: “2.0K” → 2000 (evita tratar “2.0K” como só o dígito 2).
     * @param {Element} anchor
     * @returns {{ rating: number | null; rating_count: number | null; rating_distribution: null }}
     */
    function ratingFromDomNearProduct(anchor) {
      let el = /** @type {HTMLElement | null} */ (anchor);
      for (let up = 0; up < 12 && el; up++) {
        const block = (el.innerText || el.textContent || '').replace(/\s+/g, ' ');
        const m = block.match(/(\d+[.,]?\d*)\s*★\s*\(([^)]+)\)/i);
        if (m) {
          const r = parseFloat(m[1].replace(',', '.'));
          const inner = m[2].trim();
          let c = parseSoldCountFromDisplayText(inner);
          if (c == null) {
            const d = parseInt(inner.replace(/[^\d]/g, ''), 10);
            c = Number.isFinite(d) && d >= 0 ? d : null;
          }
          if (Number.isFinite(r) && r >= 0 && r <= 5 && c != null) {
            return { rating: r, rating_count: c, rating_distribution: null };
          }
        }
        el = el.parentElement;
      }
      return { rating: null, rating_count: null, rating_distribution: null };
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

    function shippingLabelLooksFree(rawLabel) {
      const s = String(rawLabel ?? '')
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

    /**
     * @param {Record<string, unknown> | null | undefined} pinfoObj
     */
    function collectLogisticListsFromPinfo(pinfoObj) {
      if (!pinfoObj || typeof pinfoObj !== 'object') return [];
      const pi = /** @type {Record<string, unknown>} */ (pinfoObj);
      const keys = [
        'promotion_logistic_list',
        'promotionLogisticList',
        'logistic_list',
        'logisticList',
        'logistics_service_list',
        'logisticsServiceList',
        'shipping_option_list',
        'shippingOptionList',
        'product_logistic_list',
        'productLogisticList',
      ];
      for (const k of keys) {
        const v = pi[k];
        if (Array.isArray(v) && v.length) return v;
      }
      return [];
    }

    /**
     * @param {Record<string, unknown>} pl
     */
    function resolveFeeBlock(pl) {
      let fee = pl.shippingFee ?? pl.shipping_fee;
      if (fee && typeof fee === 'object') return /** @type {Record<string, unknown>} */ (fee);
      const lm = pl.logistic_model ?? pl.logisticModel;
      if (lm && typeof lm === 'object') {
        const l = /** @type {Record<string, unknown>} */ (lm);
        fee = l.shipping_fee ?? l.shippingFee ?? l.fee;
        if (fee && typeof fee === 'object') return /** @type {Record<string, unknown>} */ (fee);
      }
      const svc = pl.logistic_service ?? pl.logisticService ?? pl.shipping_service ?? pl.shippingService;
      if (svc && typeof svc === 'object') {
        const s = /** @type {Record<string, unknown>} */ (svc);
        fee = s.shipping_fee ?? s.shippingFee ?? s.fee;
        if (fee && typeof fee === 'object') return /** @type {Record<string, unknown>} */ (fee);
      }
      return null;
    }

    /**
     * @param {Record<string, unknown> | null} fee
     */
    function extractShipTextFromFee(fee) {
      if (!fee || typeof fee !== 'object') return '';
      const f = /** @type {Record<string, unknown>} */ (fee);
      const rd =
        f.real_price_desc ??
        f.realPriceDesc ??
        f.price_desc ??
        f.priceDesc ??
        f.fee_desc ??
        f.display_text ??
        f.displayText ??
        '';
      return String(rd).trim();
    }

    /**
     * @param {Record<string, unknown>} pl
     */
    function extractEtaHintFromPl(pl) {
      const lm = pl.logistic_model ?? pl.logisticModel;
      /** @type {Record<string, unknown>[]} */
      const nodes = [pl];
      if (lm && typeof lm === 'object') nodes.push(/** @type {Record<string, unknown>} */ (lm));
      for (const n of nodes) {
        const h =
          n.delivery_eta_text ??
          n.deliveryEtaText ??
          n.eta_text ??
          n.etaText ??
          n.delivery_time_desc ??
          n.deliveryTimeDesc ??
          n.shipping_text ??
          n.shippingText ??
          n.lead_time_text ??
          n.leadTimeText ??
          '';
        const s = String(h).trim();
        if (s) return s;
      }
      return '';
    }

    /**
     * @param {Record<string, unknown>} pl
     * @param {{ min: number | null; max: number | null }} dd
     */
    function buildShippingFromPlEntry(pl, dd) {
      const freeRaw = pl.freeShipping ?? pl.free_shipping;
      const fee = resolveFeeBlock(pl);
      let shipPrice = 0;
      let shipText = '';
      if (fee && typeof fee === 'object') {
        const ff = /** @type {Record<string, unknown>} */ (fee);
        const rp = ff.real_price ?? ff.realPrice;
        if (rp != null && String(rp).trim() !== '') {
          let n = Number(rp);
          if (!Number.isFinite(n)) n = parseMoneyToNumber(rp) ?? 0;
          if (Number.isFinite(n) && n >= 0) shipPrice = n;
        }
        shipText = extractShipTextFromFee(fee);
      }
      if (!shipText) shipText = extractEtaHintFromPl(pl);
      const origRaw = pl.originalShippingFee ?? pl.original_shipping_fee;
      /** @type {number | null} */
      let originalPrice = null;
      if (origRaw != null && origRaw !== '') {
        const n = Number(origRaw);
        if (Number.isFinite(n)) originalPrice = n;
      }
      const delName = pl.deliveryName ?? pl.delivery_name;
      const et = /** @type {Record<string, unknown> | undefined} */ (pl.event_tracking ?? pl.eventTracking);
      let shipType = '';
      if (et && typeof et === 'object') {
        const st = et.shipping_type ?? et.shippingType;
        if (st != null) shipType = String(st).trim();
      }
      let isFree = freeRaw === true || freeRaw === 1 || freeRaw === '1';
      if (!isFree && shipPrice === 0 && shipText && realPriceDescImpliesFree(shipText)) isFree = true;

      if (!shipText || shipText === 'unknown') {
        if (freeRaw === true || freeRaw === 1 || freeRaw === '1' || isFree) {
          shipText = 'Frete grátis';
          isFree = true;
        } else if (shipPrice > 0) {
          shipText = `R$ ${shipPrice.toFixed(2).replace('.', ',')}`;
        } else {
          shipText = 'unknown';
        }
      }

      return {
        price: isFree ? 0 : shipPrice,
        is_free: isFree,
        text: shipText,
        original_price: originalPrice,
        delivery_name: delName != null ? String(delName).trim() : '',
        shipping_type: shipType,
        delivery_min_days: dd.min,
        delivery_max_days: dd.max,
      };
    }

    /**
     * @param {Record<string, unknown> | null | undefined} pinfoObj
     */
    function extractPinfoShippingHint(pinfoObj) {
      if (!pinfoObj || typeof pinfoObj !== 'object') return '';
      const pi = /** @type {Record<string, unknown>} */ (pinfoObj);
      const keys = [
        'shipping_summary',
        'shippingSummary',
        'delivery_text',
        'deliveryText',
        'logistic_text',
        'logisticText',
      ];
      for (const k of keys) {
        const v = pi[k];
        if (v != null && String(v).trim()) return String(v).trim();
      }
      return '';
    }

    /**
     * @returns {{ price: number; is_free: boolean; text: string; original_price: number | null; delivery_name: string; shipping_type: string; delivery_min_days: number | null; delivery_max_days: number | null }}
     */
    function defaultShippingUnknown() {
      return {
        price: 0,
        is_free: false,
        text: 'unknown',
        original_price: null,
        delivery_name: '',
        shipping_type: '',
        delivery_min_days: null,
        delivery_max_days: null,
      };
    }

    /**
     * Frete: “Frete grátis” em labels; valor em listas logísticas; fallback texto em product_*.
     * @param {Record<string, unknown>} p
     */
    function shippingFromProduct(p) {
      const mkt = p.product_marketing_info || p.productMarketingInfo;
      if (mkt && typeof mkt === 'object') {
        const mk = /** @type {Record<string, unknown>} */ (mkt);
        const labels = mk.shipping_labels || mk.shippingLabels;
        if (Array.isArray(labels) && labels.some((l) => shippingLabelLooksFree(l))) {
          return {
            price: 0,
            is_free: true,
            text: 'Frete grátis',
            original_price: null,
            delivery_name: '',
            shipping_type: '',
            delivery_min_days: null,
            delivery_max_days: null,
          };
        }
        if (Array.isArray(labels) && labels.length) {
          const t = labels.map((x) => String(x).trim()).filter(Boolean).join(' · ').slice(0, 200);
          if (t) {
            if (realPriceDescImpliesFree(t)) {
              return {
                price: 0,
                is_free: true,
                text: 'Frete grátis',
                original_price: null,
                delivery_name: '',
                shipping_type: '',
                delivery_min_days: null,
                delivery_max_days: null,
              };
            }
            const money = t.match(/R\$\s*[\d.,]+/i);
            const pr = money ? parseMoneyToNumber(money[0]) : null;
            if (pr != null && pr > 0) {
              return {
                price: pr,
                is_free: false,
                text: t,
                original_price: null,
                delivery_name: '',
                shipping_type: '',
                delivery_min_days: null,
                delivery_max_days: null,
              };
            }
          }
        }
      }

      const emptyDd = { min: /** @type {number | null} */ (null), max: /** @type {number | null} */ (null) };
      /** @type {Record<string, unknown>[]} */
      const pinfoSources = [];
      if (p.product_info && typeof p.product_info === 'object') {
        pinfoSources.push(/** @type {Record<string, unknown>} */ (p.product_info));
      }
      if (p.productInfo && typeof p.productInfo === 'object') {
        pinfoSources.push(/** @type {Record<string, unknown>} */ (p.productInfo));
      }
      const ppi = p.product_price_info ?? p.productPriceInfo;
      if (ppi && typeof ppi === 'object') {
        pinfoSources.push(/** @type {Record<string, unknown>} */ (ppi));
      }
      pinfoSources.push(p);

      for (const pinfo of pinfoSources) {
        const entries = collectLogisticListsFromPinfo(pinfo);
        for (const e of entries) {
          if (!e || typeof e !== 'object') continue;
          const built = buildShippingFromPlEntry(/** @type {Record<string, unknown>} */ (e), emptyDd);
          if (built.text && built.text !== 'unknown') return built;
          if (!built.is_free && built.price > 0) return built;
        }
      }

      for (const pinfo of pinfoSources) {
        const hint = extractPinfoShippingHint(pinfo);
        if (hint) {
          const isFree = realPriceDescImpliesFree(hint);
          const hm = hint.match(/R\$\s*[\d.,]+/i);
          const prFromHint = hm ? parseMoneyToNumber(hm[0]) : null;
          return {
            price: isFree ? 0 : prFromHint != null && prFromHint > 0 ? prFromHint : 0,
            is_free: isFree,
            text: hint,
            original_price: null,
            delivery_name: '',
            shipping_type: '',
            delivery_min_days: null,
            delivery_max_days: null,
          };
        }
      }

      return defaultShippingUnknown();
    }

    /**
     * Tenta ler linha “Frete …” no cartão (listagem) quando o JSON não traz logística.
     * @param {Element} anchor
     */
    function shippingTextFromDomNearProduct(anchor) {
      let el = /** @type {HTMLElement | null} */ (anchor);
      for (let up = 0; up < 12 && el; up++) {
        const block = (el.innerText || el.textContent || '').replace(/\s+/g, ' ');
        const m = block.match(/Frete[^\n]{0,120}/i);
        if (m) {
          const line = m[0].replace(/\s+/g, ' ').trim().slice(0, 200);
          if (realPriceDescImpliesFree(line) || /gr[aá]tis/i.test(line)) {
            return {
              price: 0,
              is_free: true,
              text: 'Frete grátis',
              original_price: null,
              delivery_name: '',
              shipping_type: '',
              delivery_min_days: null,
              delivery_max_days: null,
            };
          }
          const pm = line.match(/R\$\s*[\d.,]+/i);
          if (pm) {
            const n = parseMoneyToNumber(pm[0]);
            if (n != null && n > 0) {
              return {
                price: n,
                is_free: false,
                text: line,
                original_price: null,
                delivery_name: '',
                shipping_type: '',
                delivery_min_days: null,
                delivery_max_days: null,
              };
            }
          }
        }
        el = el.parentElement;
      }
      return null;
    }

    /**
     * Nó mínimo que engloba preço + resto do cartão.
     * @param {HTMLElement} anchor
     * @returns {HTMLElement}
     */
    function getCardContainer(/** @type {HTMLElement} */ anchor) {
      let el = anchor.parentElement;
      for (let up = 0; up < 12 && el; up += 1) {
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ');
        if (/\bR\$\s*[\d.,]+/i.test(text) && text.length > 10) {
          return el;
        }
        el = el.parentElement;
      }
      return anchor;
    }

    /**
     * Remove linhas de frete para não confundir preço de envio (ex. R$ 2,00) com preço do produto.
     * @param {string} full
     */
    function stripFretePortions(/** @type {string} */ full) {
      return full
        .split('\n')
        .map((l) => l.trim())
        .filter((L) => {
          if (!L) return true;
          if (/^frete\s/i.test(L)) return false;
          if (/\bfrete\s+r\$/i.test(L)) return false;
          if (/neste pedido/i.test(L) && /frete/i.test(L)) return false;
          if (/^shipping\b/i.test(L)) return false;
          return true;
        })
        .join('\n');
    }

    /**
     * @param {HTMLElement} card
     * @returns {{ price_current: number; price_original: number | null; discount_percent: number | null }}
     */
    function parseCardVisualFinancials(/** @type {HTMLElement} */ card) {
      const forMoney = stripFretePortions(card.innerText || card.textContent || '');
      let price_original = null;
      const strikeSel = 's, del, [class*="line-through"], [class*="strikethrough"], [class*="lineThrough"]';
      card.querySelectorAll(strikeSel).forEach((node) => {
        const t = (node.textContent || '').trim();
        const mm = t.match(/R\$\s*[\d.,]+/i);
        if (mm) {
          const n = parseBrVisibleMoneyString(mm[0]);
          if (n != null && n > 0) price_original = n;
        }
      });
      const discountM = forMoney.match(/[\-–—]\s*(\d{1,2})\s*%/i);
      let discount_percent = discountM != null ? parseInt(discountM[1], 10) : null;
      if (discount_percent == null) {
        const m2 = forMoney.match(/(\d{1,2})\s*%\s*off/i);
        if (m2) discount_percent = parseInt(m2[1], 10);
      }
      const moneys = [];
      for (const m of forMoney.matchAll(/R\$\s*[\d.,]+/gi)) {
        const n = parseBrVisibleMoneyString(m[0]);
        if (n != null && n > 0) moneys.push(n);
      }
      const uniq = [...new Set(moneys)].sort((a, b) => a - b);
      let price_current = 0;
      if (price_original != null) {
        const below = uniq.filter((x) => x < price_original);
        if (below.length) {
          price_current = below[below.length - 1];
        } else {
          const le = uniq.filter((x) => x <= price_original);
          if (le.length) price_current = Math.min(...le);
        }
        if (price_current === 0) {
          const rest = uniq.filter((x) => x !== price_original);
          if (rest.length) price_current = Math.min(...rest);
        }
        if (price_current === 0) price_current = price_original;
      } else if (uniq.length >= 2) {
        const mn = Math.min(...uniq);
        const mx = Math.max(...uniq);
        if (mx > mn) {
          price_current = mn;
          price_original = mx;
        } else {
          price_current = mx;
        }
        if (discount_percent == null && price_original && price_current > 0 && price_original > price_current) {
          discount_percent = Math.max(
            0,
            Math.min(100, Math.round(100 * (1 - price_current / price_original)))
          );
        }
      } else if (uniq.length === 1) {
        price_current = uniq[0];
        price_original = null;
        if (discountM == null) discount_percent = null;
      }
      if (discountM != null && discountM[1] != null) {
        discount_percent = parseInt(discountM[1], 10);
      }
      return { price_current, price_original, discount_percent };
    }

    /**
     * @param {string} block
     * @returns {{ sold_text: string; sold_count: number | null }}
     */
    /**
     * Remove lixo após a frase de vendas (no mesmo nó o TikTok cola -10%, R$ …).
     * @param {string} s
     */
    function clipSoldTextToVendorPhrase(/** @type {string} */ s) {
      const t = String(s).trim();
      if (!t) return t;
      const cut = t.search(/\s*[\-–—]\s*\d{1,2}\s*%\s*R?\$?/i);
      if (cut > 0) return t.slice(0, cut).trim();
      const cut2 = t.search(/\bR\$\s*[\d.,]+/i);
      if (cut2 > 0) return t.slice(0, cut2).trim();
      return t.slice(0, 120);
    }

    function soldFromCardBlock(/** @type {string} */ block) {
      const b = block.replace(/\s+/g, ' ');
      const re =
        /([\d.,]+[KkMmBb]?)\s*\+?\s*(?:vendidos?(?:\([^)]*\))?|vendidas?|sales?|sold)\b/i;
      const m1 = b.match(re);
      if (m1 && m1.index != null) {
        let sold_text = b.slice(m1.index, m1.index + m1[0].length).trim();
        sold_text = clipSoldTextToVendorPhrase(sold_text);
        const sold_count =
          parseSoldCountFromDisplayText(m1[1]) ?? parseSoldCountFromDisplayText(sold_text);
        return { sold_text, sold_count };
      }
      const re2 = /\b(?:vendidos?|vendidas?|sales?|sold)\s*[:·\-]?\s*([\d.,]+[KkMmBb]?)/i;
      const m2 = b.match(re2);
      if (m2) {
        let sold_text = clipSoldTextToVendorPhrase(m2[0].trim());
        const sold_count =
          parseSoldCountFromDisplayText(m2[1]) ?? parseSoldCountFromDisplayText(sold_text);
        return { sold_text, sold_count };
      }
      return { sold_text: '', sold_count: null };
    }

    /**
     * @param {Record<string, unknown>} s
     */
    function isShippingMeaningfulForMerge(s) {
      if (!s || typeof s !== 'object') return false;
      if (s.is_free === true) return true;
      if (typeof s.price === 'number' && s.price > 0) return true;
      const t = String(s.text ?? '');
      if (t && t !== 'unknown') return true;
      return false;
    }

    /**
     * Vitrine (DOM) prevalece; SSR completa furos.
     * @param {Record<string, unknown>} dom
     * @param {Record<string, unknown> | undefined} ssr
     */
    function mergeDomWithSsr(/** @type {Record<string, unknown>} */ dom, ssr) {
      if (!ssr) return { ...dom };
      const s = /** @type {Record<string, unknown>} */ (ssr);
      const o = { ...s };
      o.product_id = dom.product_id;
      o.dashboard_rank = dom.dashboard_rank;
      o.product_url = String((dom.product_url && String(dom.product_url).trim()) || s.product_url);
      o.name = String((dom.name && String(dom.name).trim()) || s.name);
      if (typeof dom.price_current === 'number' && isFinite(dom.price_current) && dom.price_current > 0) {
        o.price_current = dom.price_current;
      }
      o.price_original =
        dom.price_original != null && typeof dom.price_original === 'number' && dom.price_original > 0
          ? dom.price_original
          : s.price_original;
      o.discount_percent =
        dom.discount_percent != null && typeof dom.discount_percent === 'number'
          ? dom.discount_percent
          : s.discount_percent;
      const ds = /** @type {Record<string, unknown> | null} */ (
        dom.shipping && typeof dom.shipping === 'object' ? dom.shipping : null
      );
      if (ds && isShippingMeaningfulForMerge(ds)) {
        o.shipping = dom.shipping;
      } else {
        o.shipping = s.shipping;
      }
      o.sold_text = String(
        (dom.sold_text && String(dom.sold_text).trim().length) ? dom.sold_text : s.sold_text
      );
      o.sold_count = dom.sold_count != null ? dom.sold_count : s.sold_count;
      o.image_main = String((dom.image_main && String(dom.image_main)) || s.image_main);
      o.shop_name = String((dom.shop_name && String(dom.shop_name).trim()) || s.shop_name);
      o.rating = dom.rating != null && typeof dom.rating === 'number' ? dom.rating : s.rating;
      o.rating_count = dom.rating_count != null ? dom.rating_count : s.rating_count;
      o.rating_distribution =
        dom.rating_distribution != null ? dom.rating_distribution : s.rating_distribution;
      return o;
    }

    /**
     * Heurística no cartão (DOM) quando o SSR não veio.
     * @param {Element} anchor
     */
    function soldTextFromDomNearProduct(anchor) {
      let el = /** @type {HTMLElement | null} */ (anchor);
      for (let up = 0; up < 12 && el; up++) {
        const block = (el.innerText || el.textContent || '').replace(/\s+/g, ' ');
        const re = /[\d.,]+[KkMmBb]?\s*\+?\s*(sold|vendidos?|vendidas?|sales?)/i;
        const m = block.match(re);
        if (m && m.index !== undefined) {
          const from = Math.max(0, m.index);
          return clipSoldTextToVendorPhrase(block.slice(from, from + m[0].length).trim());
        }
        const m2 = block.match(/(sold|vendidos?|vendidas?)\s*[:·\-]?\s*[\d.,]+[KkMmBb]?/i);
        if (m2) return clipSoldTextToVendorPhrase(m2[0].trim());
        el = el.parentElement;
      }
      return '';
    }

    /**
     * Vitrine: um registo por cartão, dados visuais.
     * @returns {Array<Record<string, unknown>>}
     */
    function extractFromDomVitrine() {
      const root = document.querySelector('main') || document.body;
      const seen = new Set();
      /** @type {Array<Record<string, unknown>>} */
      const rows = [];
      const anchors = root.querySelectorAll('a[href*="/view/product/"], a[href*="/pdp/"]');
      for (const a of anchors) {
        const elA = /** @type {HTMLAnchorElement} */ (a);
        const rawHref = elA.getAttribute('href') || '';
        let href = '';
        try {
          href = new URL(rawHref, location.href).href.split(/[?#]/)[0];
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
        const card = getCardContainer(elA);
        const fin = parseCardVisualFinancials(card);
        const cardText = (card.innerText || card.textContent || '').replace(/\s+/g, ' ');
        const soldBlock = soldFromCardBlock(cardText);
        const soldText =
          soldBlock.sold_text || soldTextFromDomNearProduct(elA);
        const soldCount =
          soldBlock.sold_count != null
            ? soldBlock.sold_count
            : soldText
              ? parseSoldCountFromDisplayText(soldText)
              : null;
        const shipDom = shippingTextFromDomNearProduct(elA);
        const ratDom = ratingFromDomNearProduct(elA);
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
        if (name.length < 8) {
          const t = (cardText.split(/\bR\$\s*[\d.,]+/i)[0] || '').trim().slice(0, 400);
          if (t.length > name.length) name = t;
        }
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
          product_url: productUrl,
          name,
          price_current: fin.price_current,
          price_original: fin.price_original,
          discount_percent: fin.discount_percent,
          shipping: shipDom || defaultShippingUnknown(),
          rating: ratDom.rating,
          rating_count: ratDom.rating_count,
          rating_distribution: ratDom.rating_distribution,
          shop_name: shopNameDom,
          image_main: img,
          sold_text: soldText,
          sold_count: soldCount,
        });
      }
      return rows;
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
        const sold = soldInfoFrom(p);
        const extras = priceExtrasFromProduct(p);
        const rat = ratingInfoFrom(p);
        out.push({
          dashboard_rank: rank,
          product_id: id,
          product_url: pUrl,
          name,
          price_current: priceToNumber(
            pinfo && typeof pinfo === 'object' ? pinfo : undefined,
            p
          ),
          price_original: extras.price_original,
          discount_percent: extras.discount_percent,
          shipping: shippingFromProduct(p),
          rating: rat.rating,
          rating_count: rat.rating_count,
          rating_distribution: rat.rating_distribution,
          shop_name: shopNameFrom(p),
          image_main: firstImg(p),
          sold_text: sold.sold_text,
          sold_count: sold.sold_count,
        });
      }
      return out;
    }

    /**
     * Router SSR: merge por product_id; mesma lógica que `mapListToRows`.
     * @returns {{ rows: Array<Record<string, unknown>>; byId: Map<string, Record<string, unknown>> }}
     */
    function buildSsrFromRouter() {
      const out = {
        /** @type {Array<Record<string, unknown>>} */
        rows: [],
        byId: /** @type {Map<string, Record<string, unknown>>} */ (new Map()),
      };
      const script = document.querySelector('script#__MODERN_ROUTER_DATA__');
      if (!script?.textContent?.trim()) return out;
      try {
        const router = JSON.parse(script.textContent);
        let list = findLargestProductList(router);
        if (!Array.isArray(list) || list.length === 0) {
          list = collectAllProductsDedup(router);
        }
        if (!Array.isArray(list) || list.length === 0) return out;
        out.rows = mapListToRows(list);
        for (const r of out.rows) {
          out.byId.set(String(r.product_id), r);
        }
        return out;
      } catch {
        return out;
      }
    }

    const ssr = buildSsrFromRouter();
    const domRows = extractFromDomVitrine();
    if (domRows.length > 0) {
      return domRows.map((d) =>
        mergeDomWithSsr(/** @type {Record<string, unknown>} */ (d), ssr.byId.get(String(d.product_id)))
      );
    }
    if (ssr.rows.length > 0) {
      return ssr.rows;
    }
    return [];
  });
}
