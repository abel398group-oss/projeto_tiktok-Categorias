import 'dotenv/config';

function boolEnv(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return String(v).toLowerCase() === 'true' || v === '1';
}

/** Modo conservador: delays maiores, menos scroll/view-more, menos repetição de categoria, teto de PDP/tempo quando o env não fixa o valor. */
const safeScraping = boolEnv('SAFE_SCRAPING', false);
/** Diagnóstico: ritmo mínimo + logs `[diag]` + secção `diagnostic` em metrics (quando env não define o valor, prevalece sobre SAFE). */
const ultraSafeDiagnostic = boolEnv('ULTRA_SAFE_DIAGNOSTIC', false);

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

/**
 * Limite opcional (MAX_PRODUCTS, STOP_AFTER_PDP_OK). `null` = sem limite se env omitido.
 * `ULTRA_SAFE_DIAGNOSTIC` ganha do `SAFE_SCRAPING` quando ambos aplicam default.
 */
function optionalPositiveIntEnv(name, ultraDefaultWhenUnset = null, safeDefaultWhenUnset = null) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (ultraSafeDiagnostic && ultraDefaultWhenUnset != null) {
      const u = Number(ultraDefaultWhenUnset);
      if (Number.isFinite(u) && u >= 1) return Math.floor(u);
    }
    if (safeScraping && safeDefaultWhenUnset != null) {
      const s = Number(safeDefaultWhenUnset);
      if (Number.isFinite(s) && s >= 1) return Math.floor(s);
    }
    return null;
  }
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
const maxProducts = optionalPositiveIntEnv('MAX_PRODUCTS', null, null);
/** Após N PDPs bem-sucedidos no run, encerra o fluxo com gravação normal (omitir = sem limite). */
const stopAfterPdpOk = optionalPositiveIntEnv('STOP_AFTER_PDP_OK', 5, 20);

/**
 * Limite de tempo da corrida inteira. `null` = sem limite (até acabar a fila ou erro).
 * `RUN_DURATION_MINUTES=0` = sem limite.
 * ULTRA (env omitido): 8 min · SAFE (env omitido): 30 min.
 */
function optionalRunDurationMs() {
  const raw = process.env.RUN_DURATION_MINUTES;
  if (raw === undefined || String(raw).trim() === '') {
    if (ultraSafeDiagnostic) return 8 * 60 * 1000;
    if (safeScraping) return 30 * 60 * 1000;
    return null;
  }
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * 60 * 1000;
}

export const config = {
  /** Preset conservador (ritmo / limites); variáveis no .env continuam a prevalecer quando definidas. */
  safeScraping,
  /** Ultra conservador + diagnóstico no console e em `metrics.json`. */
  ultraSafeDiagnostic,
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
  /**
   * Vitrines explícitas (CSV). Se `TIKTOK_CATEGORY_URLS=` estiver definido mas vazio no .env,
   * não usa o default — útil com `TIKTOK_SITEMAP_URL` para fila só a partir do hub.
   */
  categoryUrls: (() => {
    if (
      Object.prototype.hasOwnProperty.call(process.env, 'TIKTOK_CATEGORY_URLS') &&
      String(process.env.TIKTOK_CATEGORY_URLS ?? '').trim() === ''
    ) {
      return [];
    }
    return listEnv('TIKTOK_CATEGORY_URLS', 'https://shop.tiktok.com/br/c/womenswear-underwear/601152');
  })(),
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
  categoryDelayMinMs: numEnv(
    'CATEGORY_DELAY_MIN_MS',
    ultraSafeDiagnostic ? 30_000 : safeScraping ? 22_000 : 8000
  ),
  categoryDelayMaxMs: numEnv(
    'CATEGORY_DELAY_MAX_MS',
    ultraSafeDiagnostic ? 90_000 : safeScraping ? 60_000 : 25000
  ),
  viewMoreMaxClicks: numEnv('VIEW_MORE_MAX_CLICKS', ultraSafeDiagnostic ? 8 : safeScraping ? 40 : 200),
  categoryStagnantPasses: numEnv(
    'CATEGORY_STAGNANT_PASSES',
    ultraSafeDiagnostic ? 1 : safeScraping ? 2 : 3
  ),
  pdpDelayMinMs: numEnv('PDP_DELAY_MIN_MS', ultraSafeDiagnostic ? 12_000 : safeScraping ? 8000 : 2000),
  pdpDelayMaxMs: numEnv('PDP_DELAY_MAX_MS', ultraSafeDiagnostic ? 25_000 : safeScraping ? 18_000 : 6000),
  listScrollMaxRounds: numEnv('LIST_SCROLL_MAX_ROUNDS', ultraSafeDiagnostic ? 6 : safeScraping ? 12 : 28),
  listScrollIdleLimit: numEnv('LIST_SCROLL_IDLE_LIMIT', safeScraping || ultraSafeDiagnostic ? 3 : 4),
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
  /** `null` = sem limite de tempo. */
  runDurationMs: optionalRunDurationMs(),
  /**
   * Amostra de reviews na PDP (texto + URLs de fotos + sku_id). `0` = não gravar reviews.
   */
  reviewSampleMaxCount: numEnv('REVIEW_SAMPLE_MAX', 5),
  reviewSampleMaxText: numEnv('REVIEW_SAMPLE_MAX_TEXT', 320),
  reviewSampleMaxPhotos: numEnv('REVIEW_SAMPLE_MAX_PHOTOS', 2),
  /** SKUs completos na PDP (router). Reduza para JSON menor. */
  pdpSkuOffersMax: numEnv('PDP_SKU_OFFERS_MAX', 120),
  pdpPropertyMaxProps: numEnv('PDP_PROPERTY_MAX', 24),
  pdpPropertyMaxValues: numEnv('PDP_PROPERTY_VALUES_MAX', 80),
  /** Se true, pausa quando detetar CAPTCHA até desaparecer (tens de resolver no browser). */
  captchaWaitEnabled: boolEnv('CAPTCHA_WAIT', true),
  /** Máximo de espera pelo CAPTCHA (ms). */
  captchaMaxWaitMs: numEnv('CAPTCHA_MAX_WAIT_MS', 30 * 60 * 1000),
  /**
   * Se true e `DATABASE_URL` válida, faz upsert na tabela `products` (colunas + JSONB `payload`)
   * após cada `flush` quando houver alterações (ou sync completo na primeira vez).
   */
  productsDbSync: boolEnv('PRODUCTS_DB_SYNC', false),
};
