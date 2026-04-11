function asString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return String(v).trim();
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

/** Preço promocional / atual (evita confundir com preço original). */
function pickPrecoAtual(obj) {
  if (!obj || typeof obj !== 'object') return '';

  const ppi = getProductPriceInfo(obj);
  if (ppi && typeof ppi === 'object') {
    const formatted =
      ppi.sale_price_format ||
      ppi.sale_price_integer_part_format ||
      ppi.price_text ||
      ppi.show_price ||
      ppi.format_price;
    if (formatted != null && String(formatted).trim()) return asString(formatted);

    const sym = ppi.currency_symbol || ppi.currency || '';
    const dec = ppi.sale_price_decimal ?? ppi.min_price_decimal ?? ppi.price_val;
    if (dec != null && String(dec).trim()) {
      const joined = [sym, dec].filter(Boolean).join(sym && !String(sym).endsWith(' ') ? ' ' : '');
      if (joined.trim()) return joined.trim();
    }
  }

  const pb = getProductBase(obj);
  const priceBlock = pb?.price;
  if (priceBlock && typeof priceBlock === 'object') {
    const rp = priceBlock.real_price || priceBlock.min_sku_price || priceBlock.current_price;
    if (rp != null) return asString(rp);
  }

  const direct =
    obj.format_discount_price ??
    obj.discount_price_format ??
    obj.min_sale_price ??
    obj.sale_price ??
    obj.price ??
    obj.current_price ??
    obj.display_price;
  if (direct !== undefined && direct !== null) return asString(direct);

  const pi = obj.price_info || obj.priceInfo;
  if (pi && typeof pi === 'object') {
    const min = pi.min_price ?? pi.minPrice ?? pi.price;
    if (min && typeof min === 'object') {
      return asString(
        min.formatted_price ?? min.formattedPrice ?? min.price_str ?? min.amount ?? min.value ?? ''
      );
    }
    return asString(pi.min_sale_price ?? pi.sale_price ?? '');
  }

  const fmt = obj.format_price ?? obj.formatted_price ?? obj.formattedPrice;
  if (fmt) return asString(fmt);

  return '';
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
  if (!obj || typeof obj !== 'object') return '';
  const o = unwrapProductNode(obj);

  const img = o.image || o.cover || o.main_image || o.mainImage || o.pic;
  if (img && typeof img === 'object') {
    const list = img.url_list || img.urlList || img.urls;
    if (Array.isArray(list) && list[0]) return expandCdnUrl(list[0]);
    if (img.url) return expandCdnUrl(img.url);
    if (img.uri) return expandCdnUrl(img.uri);
  }
  if (typeof img === 'string') return expandCdnUrl(img);

  const imgs = o.images || o.image_list;
  if (Array.isArray(imgs) && imgs[0]) {
    const first = imgs[0];
    if (typeof first === 'string') return expandCdnUrl(first);
    if (first?.url_list?.[0]) return expandCdnUrl(first.url_list[0]);
  }

  return '';
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
    o.id ??
    o.sku;
  return asString(id);
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
  if (!sku) return null;

  return {
    sku,
    nome: pickTitle(node),
    preco_atual: pickPrecoAtual(node),
    preco_original: pickPrecoOriginal(node),
    nota_avaliacao: pickRating(node),
    total_vendas: pickSold(node),
    taxonomia: taxonomia || '',
    link_do_produto: pickLink(node, sku),
    link_imagem: pickImage(node),
    data_coleta: '',
  };
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
