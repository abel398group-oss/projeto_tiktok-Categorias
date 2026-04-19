import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

/**
 * Grava JSON/CSV e, se configurado, sincroniza Postgres (`products`).
 * @param {import('../canonicalJsonStore.js').CanonicalJsonStore} store
 * @param {import('pg').Pool | null} pgPool
 */
export async function persistCanonicalStore(store, pgPool) {
  await store.flush();
  if (!pgPool || !config.productsDbSync) return;
  try {
    await syncProductsToPostgres(pgPool, store);
  } catch (e) {
    console.error('[db/products] sync:', e?.message || e);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let schemaEnsured = false;

/**
 * Campos que ficam só no JSONB (cold).
 * @param {import('../productSchema.js').CanonicalProduct} p
 */
export function buildProductPayloadCold(p) {
  return {
    normalized_sales: p.normalized_sales,
    price_history: p.price_history,
    categories: p.categories,
    images: p.images,
    image_main: p.image_main,
    variants: p.variants,
    description: p.description,
    shop_logo: p.shop_logo,
    shop_product_count: p.shop_product_count,
    shop_review_count: p.shop_review_count,
    shop_sold_count: p.shop_sold_count,
    url: p.url,
    url_primary: p.url_primary,
    url_type: p.url_type,
    canonical_url_hash: p.canonical_url_hash,
    product_category_from_breadcrumb: p.product_category_from_breadcrumb,
    rating_distribution: p.rating_distribution,
    review_samples: p.review_samples,
    product_video: p.product_video,
    product_properties: p.product_properties,
    sku_offers: p.sku_offers,
    shipping: p.shipping,
    missing_fields: p.missing_fields,
    suspect: p.suspect,
    incomplete: p.incomplete,
    _provenance: p._provenance,
  };
}

/** @param {unknown} v */
function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** @param {string} s */
function tsOrNull(s) {
  if (!s || typeof s !== 'string') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {import('../productSchema.js').CanonicalProduct} p
 * @returns {unknown[]}
 */
function rowValues(p) {
  const po = numOrNull(p.price_original);
  const payload = buildProductPayloadCold(p);
  return [
    String(p.product_id || '').trim(),
    String(p.sku_id || '').trim(),
    String(p.name || '').trim(),
    numOrNull(p.price_current) ?? 0,
    po != null && po > 0 ? po : null,
    Math.max(0, Math.floor(Number(p.sales_count) || 0)),
    numOrNull(p.rating) ?? 0,
    p.rating_count == null || p.rating_count === '' ? null : Math.floor(Number(p.rating_count)),
    Math.max(0, Math.floor(Number(p.discount) || 0)),
    String(p.shop_name || '').trim(),
    String(p.seller_id || '').trim(),
    String(p.shop_link || '').trim(),
    String(p.taxonomy_path || '').trim(),
    Math.max(0, Math.floor(Number(p.rank_position) || 0)),
    numOrNull(p.score),
    numOrNull(p.completeness_score),
    tsOrNull(p.collected_at),
    payload,
  ];
}

const UPSERT_SQL = `
INSERT INTO products (
  product_id, sku_id, name, price_current, price_original, sales_count,
  rating, rating_count, discount, shop_name, seller_id, shop_link,
  taxonomy_path, rank_position, score, completeness_score,
  collected_at, payload, synced_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, NOW())
ON CONFLICT (product_id) DO UPDATE SET
  sku_id = EXCLUDED.sku_id,
  name = EXCLUDED.name,
  price_current = EXCLUDED.price_current,
  price_original = EXCLUDED.price_original,
  sales_count = EXCLUDED.sales_count,
  rating = EXCLUDED.rating,
  rating_count = EXCLUDED.rating_count,
  discount = EXCLUDED.discount,
  shop_name = EXCLUDED.shop_name,
  seller_id = EXCLUDED.seller_id,
  shop_link = EXCLUDED.shop_link,
  taxonomy_path = EXCLUDED.taxonomy_path,
  rank_position = EXCLUDED.rank_position,
  score = EXCLUDED.score,
  completeness_score = EXCLUDED.completeness_score,
  collected_at = EXCLUDED.collected_at,
  payload = EXCLUDED.payload,
  synced_at = NOW()
`;

/**
 * Cria tabela + índices na primeira utilização (idempotente).
 * @param {import('pg').Pool} pool
 */
export async function ensureProductsTable(pool) {
  if (schemaEnsured) return;
  const sqlPath = path.join(__dirname, '../../db/migrations/002_products.sql');
  let sql = '';
  try {
    sql = fs.readFileSync(sqlPath, 'utf8');
  } catch {
    console.warn('[db/products] Não foi possível ler 002_products.sql; assumindo que a tabela já existe.');
    schemaEnsured = true;
    return;
  }
  await pool.query(sql);
  schemaEnsured = true;
  console.info('[db/products] Tabela products verificada/criada.');
}

/**
 * @param {import('pg').Pool} pool
 */
export async function countProductsInDb(pool) {
  const r = await pool.query('SELECT COUNT(*)::bigint AS c FROM products');
  return Number(r.rows[0]?.c || 0);
}

/**
 * @param {import('pg').Pool} pool
 * @param {import('../canonicalJsonStore.js').CanonicalJsonStore} store
 */
export async function syncProductsToPostgres(pool, store) {
  if (!config.productsDbSync || !pool) return;

  await ensureProductsTable(pool);

  const totalInDb = await countProductsInDb(pool);
  const allIds = [...store.byId.keys()];

  /** @type {string[]} */
  let idsToSync;
  if (totalInDb === 0 && allIds.length > 0) {
    idsToSync = allIds;
    console.info(`[db/products] Primeira sincronização: ${idsToSync.length} produtos.`);
    store.clearPgDirtyIds();
  } else if (store.pgDirtyIds.size > 0) {
    idsToSync = [...store.pgDirtyIds];
    store.clearPgDirtyIds();
  } else {
    return;
  }

  if (idsToSync.length === 0) return;

  const CHUNK = 250;
  let ok = 0;
  let failed = 0;
  const client = await pool.connect();
  try {
    for (let i = 0; i < idsToSync.length; i += CHUNK) {
      const slice = idsToSync.slice(i, i + CHUNK);
      await client.query('BEGIN');
      try {
        for (const id of slice) {
          const p = store.byId.get(id);
          if (!p || !String(p.product_id || '').trim()) {
            failed += 1;
            continue;
          }
          const vals = rowValues(p);
          try {
            await client.query(UPSERT_SQL, vals);
            ok += 1;
          } catch (e) {
            failed += 1;
            console.warn(`[db/products] upsert falhou product_id=${id}:`, e?.message || e);
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[db/products] chunk rollback:', e?.message || e);
        slice.forEach((id) => store.pgDirtyIds.add(id));
      }
    }
  } finally {
    client.release();
  }

  console.info(`[db/products] sincronizado ok=${ok} falha=${failed}`);
}
