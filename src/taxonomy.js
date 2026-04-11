/**
 * Extrai caminho de categorias (breadcrumb) da PDP ou listagem.
 * @param {import('puppeteer').Page} page
 * @param {string} [fallback] valor se o DOM não tiver breadcrumb
 */
export async function extractTaxonomyPath(page, fallback = '') {
  const pathStr = await page
    .evaluate(() => {
      const crumbs = document.querySelectorAll(
        'nav[aria-label*="breadcrumb" i] a, [class*="breadcrumb" i] a, [data-e2e*="breadcrumb" i] a'
      );
      if (crumbs.length) {
        const parts = [...crumbs]
          .map((a) => (a.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        if (parts.length) return parts.join(' > ');
      }
      const jsonLd = document.querySelector('script[type="application/ld+json"]');
      if (jsonLd?.textContent) {
        try {
          const j = JSON.parse(jsonLd.textContent);
          const items = j?.itemListElement || j?.breadcrumb?.itemListElement;
          if (Array.isArray(items)) {
            const names = items
              .map((x) => x?.name || x?.item?.name)
              .filter(Boolean);
            if (names.length) return names.join(' > ');
          }
        } catch {
          /* ignore */
        }
      }
      return '';
    })
    .catch(() => '');

  const t = (pathStr || '').trim();
  return t || fallback || '';
}
