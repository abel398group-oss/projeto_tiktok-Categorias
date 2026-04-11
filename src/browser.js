import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { config } from './config.js';
import { pickRandomUserAgent } from './userAgents.js';

puppeteer.use(StealthPlugin());

export async function launchBrowser() {
  const userAgent = pickRandomUserAgent();

  const browser = await puppeteer.launch({
    headless: config.headless,
    userDataDir: config.userDataDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1366,768',
      `--user-agent=${userAgent}`,
    ],
  });

  return { browser, userAgent };
}
