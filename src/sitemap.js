/**
 * Coleta URLs de categorias a partir de uma página tipo sitemap do TikTok Shop.
 * Heurística: links shop que não são PDP.
 * @param {import('puppeteer').Page} page
 * @param {string} sitemapUrl
 */
export async function collectCategoryUrlsFromSitemapPage(page, sitemapUrl) {
  await page.goto(sitemapUrl, { waitUntil: 'networkidle2', timeout: 120_000 });

  const hrefs = await page.evaluate(() => {
    const out = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href?.split('#')[0];
      if (!href) continue;
      const u = href.toLowerCase();
      if (!u.includes('tiktok.com')) continue;
      if (u.includes('/pdp/') || u.includes('/view/product')) continue;
      const path = (() => {
        try {
          return new URL(href).pathname.toLowerCase();
        } catch {
          return '';
        }
      })();
      const isBrCategoryDir = path === '/br/c' || path.startsWith('/br/c/');
      if (
        u.includes('/c/') ||
        isBrCategoryDir ||
        u.includes('category') ||
        u.includes('/shop/') ||
        u.endsWith('shop.tiktok.com/br') ||
        u.endsWith('shop.tiktok.com/')
      ) {
        out.add(href);
      }
    }
    return Array.from(out);
  });

  return [...new Set(hrefs)].sort();
}
