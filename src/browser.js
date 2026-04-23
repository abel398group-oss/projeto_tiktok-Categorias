import fs from 'node:fs';
import path from 'node:path';
import { executablePath as puppeteerExecutablePath } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { config } from './config.js';
import { pickRandomUserAgent } from './userAgents.js';

puppeteer.use(StealthPlugin());

/**
 * Evita "Failed to launch the browser process! undefined" (Chromium em cache,
 * Chrome do sistema, perfil em OneDrive a bloquear ./chrome-profile).
 */
function resolveBrowserExecutable() {
  const fromEnv = String(process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (fromEnv && fs.existsSync(fromEnv)) {
    return { executablePath: fromEnv, channel: undefined };
  }
  if (String(process.env.PUPPETEER_CHANNEL || '').trim()) {
    return {
      executablePath: undefined,
      channel: String(process.env.PUPPETEER_CHANNEL).trim(),
    };
  }
  const winChromePaths = [
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')
      : '',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  for (const p of winChromePaths) {
    if (p && fs.existsSync(p)) return { executablePath: p, channel: undefined };
  }
  try {
    const bundled = puppeteerExecutablePath();
    if (bundled && fs.existsSync(bundled)) {
      return { executablePath: bundled, channel: undefined };
    }
  } catch {
    /* ignore */
  }
  return { executablePath: undefined, channel: 'chrome' };
}

/**
 * @param {{ noUserDir: boolean; exe: string | undefined; ch: string | undefined; userAgent: string }} a
 */
async function doLaunch(/** @type {boolean} */ noUserDir, /** @type {string | undefined} */ exe, /** @type {string | undefined} */ ch, userAgent) {
  return puppeteer.launch({
    headless: config.headless,
    ...(noUserDir ? {} : { userDataDir: config.userDataDir }),
    ...(exe ? { executablePath: exe } : {}),
    ...(ch && !exe ? { channel: ch } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1366,768',
      `--user-agent=${userAgent}`,
    ],
  });
}

export async function launchBrowser() {
  const userAgent = pickRandomUserAgent();
  const noUserDir =
    String(process.env.USE_PUPPETEER_NO_USER_DIR || '').toLowerCase() === 'true' ||
    process.env.USE_PUPPETEER_NO_USER_DIR === '1';
  const { executablePath: exe, channel: ch } = resolveBrowserExecutable();
  if (!noUserDir && config.userDataDir) {
    try {
      const browser = await doLaunch(false, exe, ch, userAgent);
      return { browser, userAgent };
    } catch (err) {
      console.warn(
        '[browser] Falha com userDataDir (%s). A repetir sem perfil. Defina USE_PUPPETEER_NO_USER_DIR=true ou USER_DATA_DIR fora do OneDrive.\n  %s',
        config.userDataDir,
        err && /** @type {Error} */ (err).message ? /** @type {Error} */ (err).message : err
      );
      const browser = await doLaunch(true, exe, ch, userAgent);
      return { browser, userAgent };
    }
  }
  const browser = await doLaunch(true, exe, ch, userAgent);
  return { browser, userAgent };
}
