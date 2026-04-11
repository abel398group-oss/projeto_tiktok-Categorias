import { sleep, randomBetween } from './util.js';

/**
 * @param {import('puppeteer').Page} page
 */
export async function collectPdpLinks(page) {
  const hrefs = await page.evaluate(() => {
    const out = new Set();
    for (const a of document.querySelectorAll(
      'a[href*="/pdp/"], a[href*="/br/pdp/"], a[href*="/view/product"]'
    )) {
      try {
        const abs = new URL(a.getAttribute('href') || '', location.href).href;
        const u = new URL(abs);
        const p = u.pathname.toLowerCase();
        if (p.includes('/pdp/') || p.includes('/br/pdp/') || p.includes('/view/product')) {
          out.add(u.href.split('#')[0]);
        }
      } catch {
        /* ignore */
      }
    }
    return Array.from(out);
  });
  return [...new Set(hrefs)].sort();
}

/**
 * @param {string} href
 */
export function extractProductIdFromPdpUrl(href) {
  try {
    const u = new URL(href);
    const m = u.pathname.match(/\/(\d{10,})\/?$/);
    if (m) return m[1];
    const parts = u.pathname.split('/').filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (/^\d{10,}$/.test(parts[i])) return parts[i];
    }
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * Scroll na listagem para disparar lazy-load antes de coletar URLs.
 * @param {import('puppeteer').Page} page
 * @param {{ maxRounds?: number, idleLimit?: number }} opts
 */
export async function scrollListingToLoadProducts(page, opts = {}) {
  const maxRounds = opts.maxRounds ?? 28;
  const idleLimit = opts.idleLimit ?? 4;
  let idle = 0;
  let lastH = 0;

  for (let i = 0; i < maxRounds; i += 1) {
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.evaluate(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    });
    await sleep(randomBetween(500, 1200));

    if (h <= lastH) idle += 1;
    else idle = 0;
    lastH = h;
    if (idle >= idleLimit) break;
  }
}

/**
 * Clica em "View more" / "Ver mais" até sumir ou parar de crescer a lista.
 * @param {import('puppeteer').Page} page
 * @param {{ maxClicks: number, settleMs: number, noGrowthLimit: number }} opts
 */
export async function expandViewMoreUntilDone(page, opts) {
  const maxClicks = opts.maxClicks ?? 200;
  const settleMs = opts.settleMs ?? 2500;
  const noGrowthLimit = opts.noGrowthLimit ?? 4;

  let noGrowth = 0;
  let lastCount = (await collectPdpLinks(page)).length;

  for (let i = 0; i < maxClicks; i += 1) {
    await page
      .evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
      })
      .catch(() => {});

    await sleep(randomBetween(400, 900));

    const label = await page.evaluate(() => {
      const rx =
        /^(view more|ver mais|carregar mais|load more|mostrar mais|see more products?|show more)$/i;
      const nodes = [
        ...document.querySelectorAll('button, [role="button"], a, div[tabindex="0"], span[role="button"]'),
      ];
      for (const el of nodes) {
        const raw = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!raw || raw.length > 120) continue;
        const firstLine = raw.split('\n')[0].trim();
        if (!rx.test(firstLine) && !rx.test(raw)) continue;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        el.click();
        return firstLine.slice(0, 80);
      }
      return null;
    });

    if (!label) {
      noGrowth += 1;
      if (noGrowth >= noGrowthLimit) break;
      await sleep(600);
      continue;
    }

    await sleep(settleMs);
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 25_000 }).catch(() => {});

    const n = (await collectPdpLinks(page)).length;
    if (n <= lastCount) noGrowth += 1;
    else noGrowth = 0;
    lastCount = n;

    if (noGrowth >= noGrowthLimit) break;
  }
}
