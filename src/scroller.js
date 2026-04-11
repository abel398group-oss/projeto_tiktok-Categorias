import { sleep, randomBetween } from './util.js';

/**
 * Scroll suave até parar quando várias rodadas não trouxerem novos produtos na rede.
 * @param {import('puppeteer').Page} page
 * @param {{ getRoundNewProductCount: () => number, beginScrollRound: () => void }} sniffer
 * @param {{ idleRounds: number, maxRounds: number }} opts
 */
export async function scrollUntilNetworkIdle(page, sniffer, opts) {
  const { idleRounds, maxRounds } = opts;
  let idle = 0;

  for (let i = 0; i < maxRounds; i += 1) {
    sniffer.beginScrollRound();

    await page.evaluate(() => {
      const step = Math.floor(window.innerHeight * (0.75 + Math.random() * 0.2));
      window.scrollBy({ top: step, left: 0, behavior: 'smooth' });
    });

    await sleep(randomBetween(900, 2200));

    await page.evaluate(() => {
      const h = document.documentElement.scrollHeight;
      window.scrollTo({ top: h, behavior: 'smooth' });
    });

    await sleep(randomBetween(1200, 2800));

    const fresh = sniffer.getRoundNewProductCount();
    if (fresh === 0) idle += 1;
    else idle = 0;

    if (idle >= idleRounds) break;
  }
}
