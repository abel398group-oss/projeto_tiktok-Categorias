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

/** Limite opcional de produtos armazenados (teste rápido). `null` = sem limite. */
function optionalPositiveIntEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === '') return null;
  const n = Number(String(v).trim());
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}

/** Saída canónica JSON + CSV opcional (planilha legada). */
const outputJson = process.env.OUTPUT_JSON || './output/produtos.json';
/** CSV só é escrito quando true (reversível: ENABLE_CSV=true no .env). */
const enableCsv = boolEnv('ENABLE_CSV', false);
const legacyCsvExplicit = process.env.OUTPUT_CSV ?? process.env.OUTPUT_FILE;
const outputCsvPathIfEnabled =
  legacyCsvExplicit !== undefined && String(legacyCsvExplicit).trim() === ''
    ? ''
    : legacyCsvExplicit || './output/produtos.csv';
const outputCsv = enableCsv ? outputCsvPathIfEnabled : '';
const maxProducts = optionalPositiveIntEnv('MAX_PRODUCTS');
/** Após N PDPs bem-sucedidos no run, encerra o fluxo com gravação normal (omitir = sem limite). */
const stopAfterPdpOk = optionalPositiveIntEnv('STOP_AFTER_PDP_OK');

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
    'api/v,api/oec,oec,product,search,feed,shop,promotion,component,recommend'
  ),
  outputJson,
  enableCsv,
  outputCsv,
  headless: boolEnv('HEADLESS', false),
  userDataDir: process.env.USER_DATA_DIR || './chrome-profile',
  manualLoginWaitMs: numEnv('MANUAL_LOGIN_WAIT_MS', 180_000),
  /** Intervalo para verificar se a página/sessão já permitem continuar (após login manual). */
  manualLoginPollMs: numEnv('MANUAL_LOGIN_POLL_MS', 1500),
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
  /** Logs e amostras de sniffer; default silencioso. */
  debugScraper: boolEnv('DEBUG_SCRAPER', false),
  /** Métricas agregadas por execução (sempre escrito no fim do run). */
  metricsJsonPath: process.env.METRICS_JSON_PATH || './output/metrics.json',
  /**
   * Se não vazio, grava JSON leve com by_reason + sample de descartados (ENV opt-in).
   * Default: desligado.
   */
  discardedDebugPath: process.env.DISCARDED_DEBUG_PATH || '',
  /**
   * Modo teste: parar de processar novos produtos quando `store.byId.size` >= este valor.
   * Omitir ou inválido = execução normal sem teto.
   */
  maxProducts,
  stopAfterPdpOk,
};
