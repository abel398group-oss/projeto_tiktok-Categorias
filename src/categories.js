/**
 * URLs de página de produto (PDP) — não são categorias.
 * @param {string} href
 */
export function isProductDetailUrl(href) {
  const u = href.toLowerCase();
  return (
    u.includes('/pdp/') ||
    u.includes('/view/product') ||
    u.includes('/product/detail') ||
    u.includes('/shop/p/')
  );
}

/**
 * Heurística: link que provavelmente lista vitrine / categoria.
 * @param {string} href
 */
export function isLikelyCategoryBrowseUrl(href) {
  if (isProductDetailUrl(href)) return false;
  let hostname = '';
  try {
    hostname = new URL(href).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!hostname.includes('tiktok.com')) return false;

  const u = href.toLowerCase();
  if (u.includes('/c/')) return true;
  /** Diretório de categorias BR: /br/c ou /br/c?params (sem slug numérico ainda) */
  if (/\/br\/c(\?|$|\/)/.test(u) || u.endsWith('/br/c')) return true;
  if (u.includes('/category')) return true;
  if (u.includes('/shop/c')) return true;
  if (u.includes('/shop/category')) return true;
  if (u.includes('/shop/distillery')) return true;
  if (u.includes('/shop/') && !isProductDetailUrl(href)) return true;

  return u.endsWith('shop.tiktok.com/') || u.endsWith('shop.tiktok.com/br');
}

/**
 * Coleta links de categorias/subcategorias, excluindo PDPs.
 * @param {import('puppeteer').Page} page
 * @param {string} hubUrl
 */
export async function collectCategoryLinks(page, hubUrl) {
  const hrefs = await page.evaluate(() => {
    const out = new Set();
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      const href = a.href || '';
      if (!href) continue;
      const u = href.toLowerCase();
      if (
        u.includes('/shop/') ||
        u.includes('shop.tiktok.com') ||
        u.includes('/category') ||
        u.includes('/c/')
      ) {
        out.add(href.split('#')[0]);
      }
    }
    return Array.from(out);
  });

  const base = new URL(hubUrl);
  const sameHost = hrefs.filter((h) => {
    try {
      return new URL(h).hostname === base.hostname;
    } catch {
      return false;
    }
  });

  const pool = sameHost.length ? sameHost : hrefs;
  const filtered = pool.filter((h) => isLikelyCategoryBrowseUrl(h) && !isProductDetailUrl(h));

  const unique = Array.from(new Set(filtered.length ? filtered : [hubUrl.split('#')[0]]));
  unique.sort();
  return unique;
}
