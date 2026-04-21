import { sleep } from './util.js';

/**
 * Heurística: modal de verificação TikTok (puzzle / "Verify to continue").
 * @param {import('puppeteer').Page} page
 */
export async function isCaptchaBlocking(page) {
  try {
    return await page.evaluate(() => {
      const text = (document.body?.innerText || '').slice(0, 80_000);
      if (/verify\s+to\s+continue/i.test(text)) return true;
      if (/drag\s+the\s+puzzle\s+piece/i.test(text)) return true;
      if (/verification\s+required/i.test(text)) return true;
      for (const el of document.querySelectorAll('[class*="captcha" i], [id*="captcha" i]')) {
        const r = el.getBoundingClientRect?.();
        if (r && r.width > 80 && r.height > 40) return true;
      }
      for (const f of document.querySelectorAll('iframe')) {
        const s = (f.getAttribute('src') || '').toLowerCase();
        if (s && /captcha|verify|sec|challenge/.test(s)) return true;
      }
      return false;
    });
  } catch {
    return false;
  }
}

/**
 * Se o site mostrar CAPTCHA, bloqueia até o modal sumir (tu resolves à mão no browser)
 * ou até `maxWaitMs`. Não resolve o puzzle por ti.
 *
 * @param {import('puppeteer').Page} page
 * @param {{
 *   enabled?: boolean;
 *   maxWaitMs?: number;
 *   pollMs?: number;
 *   onBlockingFirstSeen?: () => void;
 * }} [opts]
 */
export async function waitIfCaptchaBlocking(page, opts = {}) {
  const { enabled = true, maxWaitMs = 30 * 60 * 1000, pollMs = 1500, onBlockingFirstSeen } = opts;
  if (!enabled) return;

  const start = Date.now();
  let logged = false;

  while (Date.now() - start < maxWaitMs) {
    const blocking = await isCaptchaBlocking(page);
    if (!blocking) return;

    if (!logged) {
      if (typeof onBlockingFirstSeen === 'function') {
        try {
          onBlockingFirstSeen();
        } catch {
          /* diagnóstico não deve quebrar o wait */
        }
      }
      console.warn(
        '[captcha] Modal de verificação detetado. Resolva no browser (arrastar o puzzle). O scraper aguarda…'
      );
      logged = true;
    }
    await sleep(pollMs);
  }

  console.warn('[captcha] Tempo máximo de espera atingido; a continuar (a extração pode falhar).');
}
