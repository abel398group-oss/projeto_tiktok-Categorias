import { sleep } from './util.js';

/**
 * Encontra URL de categoria no hub pelo texto visível (ex.: "Womenswear & Underwear").
 * @param {import('puppeteer').Page} page
 * @param {string} hubUrl
 * @param {string} nameSubstring
 */
export async function findCategoryUrlByName(page, hubUrl, nameSubstring) {
  await page.goto(hubUrl, { waitUntil: 'networkidle2', timeout: 120_000 });
  await sleep(2500);

  const href = await page.evaluate((needle) => {
    const n = needle.toLowerCase().trim();
    if (!n) return null;
    for (const a of document.querySelectorAll('a[href]')) {
      const t = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (t.toLowerCase().includes(n)) {
        const h = a.href?.split('#')[0];
        if (h && !h.toLowerCase().includes('/pdp/')) return h;
      }
    }
    return null;
  }, nameSubstring);

  return href;
}
