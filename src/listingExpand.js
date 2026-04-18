import { sleep } from './util.js';

const PDP_LINK_SEL = 'a[href*="/pdp/"], a[href*="/br/pdp/"], a[href*="/view/product"]';

/** Só diagnóstico: âncoras que parecem loja/produto sem alterar o seletor definitivo. */
const PDP_LINK_DIAG_BROAD_SEL = 'a[href*="shop.tiktok"], a[href*="/product"]';

const HREF_DIAG_TRUNC = 140;

/**
 * @param {import('puppeteer').Page} page
 */
export async function collectPdpLinks(page) {
  const result = await page.evaluate((sel, broadSel, truncLen) => {
    function trunc(s) {
      if (s.length <= truncLen) return s;
      return `${s.slice(0, truncLen)}…`;
    }
    function resolveHref(a) {
      try {
        return new URL(a.getAttribute('href') || '', location.href).href.split('#')[0];
      } catch {
        return String(a.getAttribute('href') || '').trim();
      }
    }

    const pdpAnchors = [...document.querySelectorAll(sel)];
    const broadAnchors = [...document.querySelectorAll(broadSel)];

    let anchorHrefNonEmpty = 0;
    for (const a of document.querySelectorAll('a[href]')) {
      if ((a.getAttribute('href') || '').trim()) anchorHrefNonEmpty += 1;
    }

    const out = new Set();
    for (const a of pdpAnchors) {
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

    const sampleBroad = [...new Set(broadAnchors.map((a) => trunc(resolveHref(a))))].slice(0, 10);
    const samplePdp = [...new Set(pdpAnchors.map((a) => trunc(resolveHref(a))))].slice(0, 10);

    return {
      hrefs: Array.from(out),
      countPdpSel: pdpAnchors.length,
      countAnchorsHref: anchorHrefNonEmpty,
      countBroad: broadAnchors.length,
      sampleBroad,
      samplePdp,
    };
  }, PDP_LINK_SEL, PDP_LINK_DIAG_BROAD_SEL, HREF_DIAG_TRUNC);

  console.info('[collectPdpLinks] diagnóstico', {
    matches_seletor_atual: result.countPdpSel,
    total_a_com_href_nao_vazio: result.countAnchorsHref,
    matches_seletor_amplo_shop_tiktok_ou_product: result.countBroad,
    amostra_seletor_amplo_ate10: result.sampleBroad,
    amostra_seletor_atual_ate10: result.samplePdp,
  });

  return [...new Set(result.hrefs)].sort();
}

/**
 * @param {import('puppeteer').Page} page
 */
async function countPdpLinks(page) {
  return page.evaluate((sel) => {
    const out = new Set();
    for (const a of document.querySelectorAll(sel)) {
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
    return out.size;
  }, PDP_LINK_SEL);
}

/**
 * Scroll ao fundo e dá um tick de layout (sem “smooth”, que atrasa o botão).
 * @param {import('puppeteer').Page} page
 */
async function scrollListingBottomForMoreButton(page) {
  await page.evaluate(() => {
    window.scrollTo({ left: 0, top: document.documentElement.scrollHeight, behavior: 'auto' });
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  });
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
    await sleep(450);

    if (h <= lastH) idle += 1;
    else idle = 0;
    lastH = h;
    if (idle >= idleLimit) break;
  }
}

/**
 * Clica em "View more" / "Ver mais" até sumir ou parar de crescer a lista.
 * Usa espera por crescimento de links PDP (rápido) em vez de network idle + sleep longo.
 * @param {import('puppeteer').Page} page
 * @param {{
 *   maxClicks: number,
 *   settleMs?: number,
 *   noGrowthLimit: number,
 *   growWaitMs?: number,
 *   growPollMs?: number,
 *   preClickDelayMs?: number,
 * }} opts
 */
export async function expandViewMoreUntilDone(page, opts) {
  const maxClicks = opts.maxClicks ?? 200;
  /** Fallback curto se o contador de PDP não subir a tempo (ex.: lazy render). */
  const settleMs = opts.settleMs ?? 700;
  const noGrowthLimit = opts.noGrowthLimit ?? 4;
  const growWaitMs = opts.growWaitMs ?? 12_000;
  const growPollMs = opts.growPollMs ?? 120;
  const preClickDelayMs = opts.preClickDelayMs ?? 90;

  let noGrowth = 0;
  let lastCount = await countPdpLinks(page);

  for (let i = 0; i < maxClicks; i += 1) {
    await scrollListingBottomForMoreButton(page).catch(() => {});
    if (preClickDelayMs > 0) await sleep(preClickDelayMs);

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
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.05) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        try {
          el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        } catch {
          el.scrollIntoView(true);
        }
        el.click();
        return firstLine.slice(0, 80);
      }
      return null;
    });

    if (!label) {
      noGrowth += 1;
      if (noGrowth >= noGrowthLimit) break;
      await sleep(320);
      continue;
    }

    const grew = await page
      .waitForFunction(
        (prev, sel) => {
          const out = new Set();
          for (const a of document.querySelectorAll(sel)) {
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
          return out.size > prev;
        },
        { timeout: growWaitMs, polling: growPollMs },
        lastCount,
        PDP_LINK_SEL
      )
      .then(() => true)
      .catch(() => false);

    if (!grew) await sleep(settleMs);

    const n = await countPdpLinks(page);
    if (n <= lastCount) noGrowth += 1;
    else noGrowth = 0;
    lastCount = n;

    if (noGrowth >= noGrowthLimit) break;
  }
}
