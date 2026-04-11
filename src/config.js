import 'dotenv/config';

function boolEnv(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return String(v).toLowerCase() === 'true' || v === '1';
}

function numEnv(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultValue;
}

function listEnv(name, fallbackCsv) {
  const raw = process.env[name] || fallbackCsv;
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Arquivo de saída: .csv ou .xlsx (exceljs). */
const outputFile =
  process.env.OUTPUT_FILE ||
  process.env.OUTPUT_CSV ||
  process.env.OUTPUT_XLSX ||
  './output/produtos.csv';

export const config = {
  startUrl: process.env.TIKTOK_START_URL || 'https://shop.tiktok.com/br',
  /** Hub de categorias BR (/br/c = diretório tipo “sitemap” no app). Sobrescreva no .env com o link completo se quiser. */
  categoryHubUrl:
    process.env.TIKTOK_CATEGORY_HUB_URL || process.env.TIKTOK_START_URL || 'https://shop.tiktok.com/br/c',
  /** Página de sitemap com links de categorias (opcional). Pode ser o mesmo hub /br/c?… */
  sitemapUrl: process.env.TIKTOK_SITEMAP_URL || '',
  /**
   * URLs de vitrine por categoria. Ex. Womenswear BR (ID 601152 no path).
   * Query string pode ser omitida no .env — o scraper normaliza pela path.
   */
  /** Primeira vitrine: Womenswear & Underwear (ID 601152 no path). */
  categoryUrls: listEnv('TIKTOK_CATEGORY_URLS', 'https://shop.tiktok.com/br/c/womenswear-underwear/601152'),
  categoryNames: listEnv('TIKTOK_CATEGORY_NAMES', ''),
  apiUrlIncludes: listEnv(
    'TIKTOK_API_URL_INCLUDES',
    'api/v,api/oec,oec,product,search,feed,shop,promotion,component'
  ),
  outputFile,
  headless: boolEnv('HEADLESS', false),
  userDataDir: process.env.USER_DATA_DIR || './chrome-profile',
  manualLoginWaitMs: numEnv('MANUAL_LOGIN_WAIT_MS', 180_000),
  categoryDelayMinMs: numEnv('CATEGORY_DELAY_MIN_MS', 8000),
  categoryDelayMaxMs: numEnv('CATEGORY_DELAY_MAX_MS', 25000),
  viewMoreMaxClicks: numEnv('VIEW_MORE_MAX_CLICKS', 200),
  categoryStagnantPasses: numEnv('CATEGORY_STAGNANT_PASSES', 3),
  pdpDelayMinMs: numEnv('PDP_DELAY_MIN_MS', 2000),
  pdpDelayMaxMs: numEnv('PDP_DELAY_MAX_MS', 6000),
  listScrollMaxRounds: numEnv('LIST_SCROLL_MAX_ROUNDS', 28),
  listScrollIdleLimit: numEnv('LIST_SCROLL_IDLE_LIMIT', 4),
  tiktokEmail: process.env.TIKTOK_EMAIL || '',
  tiktokPassword: process.env.TIKTOK_PASSWORD || '',
  tryPasswordLogin: boolEnv('TIKTOK_TRY_PASSWORD_LOGIN', false),
};
