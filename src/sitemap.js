import { sleep, randomBetween } from './util.js';
import { waitIfCaptchaBlocking } from './captchaWait.js';
import { config } from './config.js';

/**
 * Scroll no hub/sitemap para carregar blocos lazy (reutilizado por coleta plana e taxonomia).
 * @param {import('puppeteer').Page} page
 */
export async function scrollSitemapPageForLazyContent(page) {
  const scrollRounds = Number(process.env.TIKTOK_HUB_SCROLL_ROUNDS) || 22;
  for (let r = 0; r < scrollRounds; r += 1) {
    await page.evaluate(() => {
      const step = Math.floor(window.innerHeight * (0.7 + Math.random() * 0.25));
      window.scrollBy({ top: step, left: 0, behavior: 'instant' });
    });
    await sleep(randomBetween(400, 900));
    await page.evaluate(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    });
    await sleep(randomBetween(500, 1100));
  }
}

/**
 * Coleta URLs de categorias a partir de uma página tipo sitemap do TikTok Shop.
 * Heurística: links shop que não são PDP. Faz scroll porque o hub costuma lazy-load.
 * @param {import('puppeteer').Page} page
 * @param {string} sitemapUrl
 */
export async function collectCategoryUrlsFromSitemapPage(page, sitemapUrl) {
  await page.goto(sitemapUrl, { waitUntil: 'networkidle2', timeout: 120_000 });
  await waitIfCaptchaBlocking(page, {
    enabled: config.captchaWaitEnabled,
    maxWaitMs: config.captchaMaxWaitMs,
  });
  await sleep(1500);

  await scrollSitemapPageForLazyContent(page);

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

  const uniq = [...new Set(hrefs)].sort();
  const leafOnly = uniq.filter((h) => {
    try {
      const p = new URL(h).pathname;
      return /^\/br\/c\/[^/]+\/\d+$/i.test(p);
    } catch {
      return false;
    }
  });
  return leafOnly.length ? leafOnly : uniq;
}
