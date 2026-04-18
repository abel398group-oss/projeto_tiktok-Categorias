import { extractFreeShippingFromListingLabels } from './shippingExtract.js';

function asString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return String(v).trim();
}

/** Número de venda > 0 (aceita string formatada tipo R$ 37,12). Ignora NaN, <= 0. */
function parsePositivePrice(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v > 0 ? v : null;
  if (typeof v === 'bigint') {
    const x = Number(v);
    return x > 0 && Number.isFinite(x) ? x : null;
  }
  const s = String(v).trim();
  if (!s) return null;
  const cleaned = s.replace(/[^\d.,]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Unifica nós comuns: item.product, componente com product embutido. */
function unwrapProductNode(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj.product && typeof obj.product === 'object') return { ...obj, ...obj.product };
  return obj;
}

function getProductPriceInfo(obj) {
  const o = unwrapProductNode(obj);
  return o.product_price_info || o.productPriceInfo || null;
}

function getSoldInfo(obj) {
  const o = unwrapProductNode(obj);
  return o.sold_info || o.soldInfo || null;
}

function getProductBase(obj) {
  const o = unwrapProductNode(obj);
  return o.product_base || o.productBase || null;
}

/**
 * Preço de venda atual (PDP/listagem): prioridade fixa — desconto/promo primeiro; nunca max_price como principal.
 * 1) discount_price / sale_price (incl. decimais e formatos de promo)
 * 2) price_current explícito
 * 3) price / current_price / blocos equivalentes (sem max)
 * 4) min_price.* (apenas campos de venda dentro do objeto min)
 */
function pickPrecoAtual(obj) {
  if (!obj || typeof obj !== 'object') return '';

  const node = unwrapProductNode(obj);
  const ppi = getProductPriceInfo(node);
  const pb = getProductBase(node);
  const priceBlock = pb?.price && typeof pb.price === 'object' ? pb.price : null;
  const pi = node.price_info || node.priceInfo;

  /** @type {Record<string, unknown>} */
  const extracted_prices = {
    price: ppi?.price ?? node.price,
    min_price: ppi?.min_price ?? ppi?.minPrice,
    max_price: ppi?.max_price ?? ppi?.maxPrice ?? node.max_price ?? node.maxPrice,
    sale_price: ppi?.sale_price ?? ppi?.sale_price_decimal ?? node.sale_price,
    discount_price: ppi?.discount_price ?? ppi?.discount_price_decimal ?? node.discount_price,
    price_current: ppi?.price_current ?? node.price_current,
    price_val: ppi?.price_val,
  };

  /** @type {Array<[() => number | null, string]>} */
  const tries = [
    // 1 — promo / venda
    [() => parsePositivePrice(ppi?.discount_price_decimal), 'ppi.discount_price_decimal'],
    [() => parsePositivePrice(ppi?.discount_price), 'ppi.discount_price'],
    [() => parsePositivePrice(ppi?.sale_price_decimal), 'ppi.sale_price_decimal'],
    [() => parsePositivePrice(ppi?.sale_price), 'ppi.sale_price'],
    [() => parsePositivePrice(node.discount_price), 'node.discount_price'],
    [() => parsePositivePrice(node.sale_price), 'node.sale_price'],
    [() => parsePositivePrice(node.min_sale_price), 'node.min_sale_price'],
    [() => parsePositivePrice(node.real_time_price ?? ppi?.real_time_price), 'real_time_price'],
    [() => parsePositivePrice(priceBlock?.discount_price), 'product_base.price.discount_price'],
    [() => parsePositivePrice(priceBlock?.sale_price), 'product_base.price.sale_price'],
    [() => parsePositivePrice(priceBlock?.real_price), 'product_base.price.real_price'],
    [() => parsePositivePrice(ppi?.sale_price_format), 'ppi.sale_price_format'],
    [() => parsePositivePrice(ppi?.sale_price_integer_part_format), 'ppi.sale_price_integer_part_format'],
    [() => parsePositivePrice(node.format_discount_price ?? node.discount_price_format), 'node.discount_price_format'],
    [() => parsePositivePrice(ppi?.format_discount_price), 'ppi.format_discount_price'],
    // 2 — price_current
    [() => parsePositivePrice(ppi?.price_current), 'ppi.price_current'],
    [() => parsePositivePrice(node.price_current), 'node.price_current'],
    // 3 — price genérico (nunca max_price)
    [() => parsePositivePrice(node.price), 'node.price'],
    [() => parsePositivePrice(node.current_price), 'node.current_price'],
    [() => parsePositivePrice(node.display_price), 'node.display_price'],
    [() => parsePositivePrice(priceBlock?.current_price), 'product_base.price.current_price'],
    [
      () =>
        pi && typeof pi === 'object'
          ? parsePositivePrice(pi.min_sale_price ?? pi.sale_price)
          : null,
      'price_info.min_sale_price|sale_price',
    ],
    [
      () => {
        if (!pi || typeof pi !== 'object') return null;
        const pr = pi.price;
        if (pr != null && typeof pr !== 'object') return parsePositivePrice(pr);
        return null;
      },
      'price_info.price',
    ],
    [() => parsePositivePrice(node.format_price ?? node.formatted_price ?? node.formattedPrice), 'node.formatted_price'],
    // 4 — objeto min_price (só subcampos de venda)
    [
      () => {
        const min = ppi?.min_price ?? ppi?.minPrice;
        if (!min || typeof min !== 'object') return null;
        const m = /** @type {Record<string, unknown>} */ (min);
        return (
          parsePositivePrice(m.sale_price_decimal) ??
          parsePositivePrice(m.single_product_price_decimal) ??
          parsePositivePrice(m.min_sale_price) ??
          parsePositivePrice(m.price_val)
        );
      },
      'ppi.min_price.(sale|single|min_sale|price_val)',
    ],
    [() => parsePositivePrice(priceBlock?.min_sku_price), 'product_base.price.min_sku_price'],
    // Fallback formatado (último recurso; ainda sem max_price)
    [() => parsePositivePrice(ppi?.price_text), 'ppi.price_text'],
    [() => parsePositivePrice(ppi?.show_price), 'ppi.show_price'],
    [() => parsePositivePrice(ppi?.format_price), 'ppi.format_price'],
  ];

  let chosenNum = /** @type {number | null} */ (null);
  let chosenSource = '';
  for (const [fn, label] of tries) {
    const n = fn();
    if (n != null) {
      chosenNum = n;
      chosenSource = label;
      break;
    }
  }

  if (chosenNum == null && pi && typeof pi === 'object') {
    const min = pi.min_price ?? pi.minPrice ?? pi.price;
    if (min && typeof min === 'object') {
      const s =
        min.formatted_price ?? min.formattedPrice ?? min.price_str ?? min.amount ?? min.value;
      chosenNum = parsePositivePrice(s);
      if (chosenNum != null) chosenSource = 'price_info.min.formatted';
    }
  }

  const chosenStr = chosenNum != null ? String(chosenNum) : '';

  if (
    process.env.DEBUG_PRICE_EXTRACTION === 'true' ||
    process.env.DEBUG_PRICE_EXTRACTION === '1'
  ) {
    console.log(
      JSON.stringify(
        {
          product_id: pickId(obj),
          extracted_prices,
          chosen_price: chosenStr,
          chosen_source: chosenSource,
        },
        null,
        2
      )
    );
  }

  return chosenStr;
}

/** Preço “De” / tachado / original. */
function pickPrecoOriginal(obj) {
  if (!obj || typeof obj !== 'object') return '';

  const ppi = getProductPriceInfo(obj);
  if (ppi && typeof ppi === 'object') {
    const o =
      ppi.origin_price_format ||
      ppi.original_price_format ||
      ppi.market_price_format ||
      ppi.list_price_format;
    if (o) return asString(o);
    const od = ppi.origin_price_decimal ?? ppi.original_price_decimal;
    if (od != null && String(od).trim()) {
      const sym = ppi.currency_symbol || '';
      return asString(sym ? `${sym} ${od}` : od);
    }
  }

  const pb = getProductBase(obj);
  const priceBlock = pb?.price;
  if (priceBlock && typeof priceBlock === 'object') {
    const op =
      priceBlock.original_price ||
      priceBlock.min_sku_original_price ||
      priceBlock.origin_price;
    if (op != null) return asString(op);
  }

  return asString(obj.origin_price ?? obj.original_price ?? obj.list_price ?? '');
}

function pickSold(obj) {
  if (!obj || typeof obj !== 'object') return '';

  const si = getSoldInfo(obj);
  if (si && typeof si === 'object') {
    if (si.format_sold_count != null && String(si.format_sold_count).trim())
      return asString(si.format_sold_count);
    if (si.sold_count != null) return asString(si.sold_count);
  }

  const pb = getProductBase(obj);
  if (pb && pb.sold_count != null) return asString(pb.sold_count);

  const s =
    obj.format_sold_count ??
    obj.formatSoldCount ??
    obj.sold_count ??
    obj.soldCount ??
    obj.sales ??
    obj.sold ??
    obj.sold_text;
  return asString(s);
}

/** Nota / avaliação média (ex.: 4.8). */
function pickRating(obj) {
  if (!obj || typeof obj !== 'object') return '';

  const o = unwrapProductNode(obj);
  const ri = o.rate_info || o.rateInfo || o.rating_info || o.ratingInfo || o.review_info;
  if (ri && typeof ri === 'object') {
    const x =
      ri.score ??
      ri.rating ??
      ri.star_rating ??
      ri.avg_rating ??
      ri.average_rating ??
      ri.product_rating;
    if (x != null) return asString(x);
  }

  return asString(
    o.product_rating ??
      o.productRating ??
      o.avg_rating ??
      o.average_star ??
      o.rating_score ??
      ''
  );
}

function expandCdnUrl(maybe) {
  const s = asString(maybe);
  if (!s) return '';
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  if (s.startsWith('//')) return `https:${s}`;
  return s;
}

/** URL da imagem principal / capa. */
function pickImage(obj) {
  const list = pickImagesList(obj);
  return list[0] || '';
}

/** Todas as URLs de imagem (listagem / API). */
function pickImagesList(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const o = unwrapProductNode(obj);
  /** @type {string[]} */
  const out = [];
  const add = (u) => {
    const s = expandCdnUrl(asString(u));
    if (s && !out.includes(s)) out.push(s);
  };

  const img = o.image || o.cover || o.main_image || o.mainImage || o.pic;
  if (img && typeof img === 'object') {
    const list = img.url_list || img.urlList || img.urls;
    if (Array.isArray(list)) for (const u of list) add(u);
    if (img.url) add(img.url);
    if (img.uri) add(img.uri);
  } else if (typeof img === 'string') {
    add(img);
  }

  const imgs = o.images || o.image_list;
  if (Array.isArray(imgs)) {
    for (const first of imgs) {
      if (typeof first === 'string') add(first);
      else if (first?.url_list?.[0]) add(first.url_list[0]);
    }
  }

  return out;
}

function pickTitle(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const o = unwrapProductNode(obj);
  return asString(o.title ?? o.product_name ?? o.name ?? o.desc ?? '');
}

function pickId(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const o = unwrapProductNode(obj);
  const id =
    o.product_id ??
    o.productId ??
    obj.product_id ??
    obj.productId ??
    o.item_id ??
    o.itemId ??
    o.id;
  return asString(id);
}

/**
 * Espelha a ordem de `pickId` (??) só para debug — não altera extração.
 * @returns {{ field: string }}
 */
function inspectPickIdFieldUsed(obj) {
  if (!obj || typeof obj !== 'object') return { field: 'none' };
  const o = unwrapProductNode(obj);
  /** @type {[string, unknown][]} */
  const checks = [
    ['product_id', o.product_id],
    ['productId', o.productId],
    ['obj.product_id', obj.product_id],
    ['obj.productId', obj.productId],
    ['item_id', o.item_id],
    ['itemId', o.itemId],
    ['id', o.id],
  ];
  for (const [field, val] of checks) {
    if (val !== undefined && val !== null) return { field };
  }
  return { field: 'none' };
}

/** DFS: existe `product_id` ou `productId` não vazio em qualquer nível de `raw`. */
function treeHasProductIdAnywhere(value, depth = 0) {
  if (depth > 20 || value == null) return false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (treeHasProductIdAnywhere(item, depth + 1)) return true;
    }
    return false;
  }
  if (typeof value !== 'object') return false;
  for (const key of ['product_id', 'productId']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const v = /** @type {Record<string, unknown>} */ (value)[key];
      if (v != null && String(v).trim() !== '') return true;
    }
  }
  for (const k of Object.keys(value)) {
    if (treeHasProductIdAnywhere(/** @type {Record<string, unknown>} */ (value)[k], depth + 1))
      return true;
  }
  return false;
}

function expandProductUrl(maybePath, productId) {
  const s = asString(maybePath);
  if (!s) return '';
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  if (s.startsWith('//')) return `https:${s}`;
  const base = (process.env.TIKTOK_SHOP_ORIGIN || 'https://shop.tiktok.com').replace(/\/$/, '');
  if (s.startsWith('/')) return `${base}${s}`;
  if (productId) return `${base}/${s.replace(/^\//, '')}`;
  return s;
}

function pickLink(obj, productId) {
  if (!obj || typeof obj !== 'object') return '';
  const o = unwrapProductNode(obj);

  const candidates = [
    o.seo_url,
    o.seoUrl,
    o.pdp_url,
    o.pdpUrl,
    o.product_url,
    o.productUrl,
    o.detail_url,
    o.detailUrl,
    o.enter_shop_pdp_schema,
    o.schema_url,
    o.share_url,
    o.link,
    o.web_url,
    o.webUrl,
    o.redirect_url,
    o.share_info?.share_url,
    o.share_info?.shareUrl,
  ];

  for (const c of candidates) {
    const url = expandProductUrl(c, productId);
    if (url && (url.includes('tiktok.com') || url.includes('shop.'))) return url;
  }

  if (productId) {
    const tpl = process.env.TIKTOK_PRODUCT_URL_TEMPLATE || 'https://shop.tiktok.com/view/product/{{id}}';
    return tpl.replace(/\{\{\s*id\s*\}\}/gi, productId);
  }

  return '';
}

export function isProductLike(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;

  const node = o.product && typeof o.product === 'object' ? { ...o, ...o.product } : o;
  const pid = node.product_id ?? node.productId;
  if (pid != null && String(pid).length >= 8) {
    return Boolean(
      pickTitle(node) ||
        getProductPriceInfo(node) ||
        getSoldInfo(node) ||
        pickPrecoAtual(node) ||
        pickSold(node)
    );
  }

  const title = pickTitle(node);
  if (!title) return false;
  if (getProductPriceInfo(node) || getSoldInfo(node)) return true;
  if (pickPrecoAtual(node) || pickSold(node)) return true;

  const genericId = node.item_id ?? node.itemId ?? node.id;
  return genericId != null && String(genericId).length >= 8;
}

/**
 * Normaliza um objeto produto vindo do JSON da API.
 * @param {object} raw
 * @param {string} taxonomia caminho completo de categorias (ex.: A > B > C)
 */
export function normalizeProduct(raw, taxonomia) {
  const node = raw?.product && typeof raw.product === 'object' ? { ...raw, ...raw.product } : raw;
  const sku = pickId(node);

  if (
    process.env.DEBUG_NETWORK_PICK_ID === 'true' ||
    process.env.DEBUG_NETWORK_PICK_ID === '1'
  ) {
    const { field } = inspectPickIdFieldUsed(node);
    console.log(
      JSON.stringify(
        {
          chosen_id: sku,
          field_used: field,
          has_product_id_anywhere: raw != null && typeof raw === 'object' ? treeHasProductIdAnywhere(raw) : false,
        },
        null,
        2
      )
    );
  }

  if (!sku) return null;

  const imgs = pickImagesList(node);
  const mainImg = imgs[0] || pickImage(node);
  const ppi = getProductPriceInfo(node);
  const skuId =
    ppi && typeof ppi === 'object'
      ? String(ppi.sku_id ?? ppi.skuId ?? sku)
      : sku;

  /** @type {Record<string, unknown>} */
  const row = {
    sku,
    sku_id: skuId,
    nome: pickTitle(node),
    preco_atual: pickPrecoAtual(node),
    preco_original: pickPrecoOriginal(node),
    nota_avaliacao: pickRating(node),
    total_vendas: pickSold(node),
    taxonomia: taxonomia || '',
    link_do_produto: pickLink(node, sku),
    link_imagem: mainImg,
    images: imgs,
    data_coleta: '',
  };

  const freeFromLabels = extractFreeShippingFromListingLabels(node);
  if (freeFromLabels) {
    row.shipping = freeFromLabels;
  } else {
    row.shipping = {
      price: null,
      is_free: false,
      text: 'unknown',
      original_price: null,
      delivery_name: '',
      shipping_type: '',
    };
  }

  if (ppi && typeof ppi === 'object' && ppi.discount != null) {
    const d = Number(ppi.discount);
    if (Number.isFinite(d) && d > 0) row.discount = String(d);
  }

  return row;
}

export function extractProductsFromJson(value, out = []) {
  if (value === null || value === undefined) return out;

  if (Array.isArray(value)) {
    for (const item of value) {
      extractProductsFromJson(item, out);
    }
    return out;
  }

  if (typeof value === 'object') {
    if (isProductLike(value)) {
      out.push({ raw: value });
      return out;
    }
    for (const k of Object.keys(value)) {
      extractProductsFromJson(value[k], out);
    }
  }
  return out;
}
