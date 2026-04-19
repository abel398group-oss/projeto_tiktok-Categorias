-- Produtos canónicos: colunas “quentes” para filtros/agregações + payload flexível (JSONB).
-- Aplicar: psql "$DATABASE_URL" -f db/migrations/002_products.sql
-- O código também tenta criar a tabela em runtime (idempotente) se sync estiver ligado.

CREATE TABLE IF NOT EXISTS products (
  product_id          TEXT PRIMARY KEY,
  sku_id              TEXT NOT NULL DEFAULT '',
  name                TEXT NOT NULL DEFAULT '',
  price_current       NUMERIC(14, 2) NOT NULL DEFAULT 0,
  price_original      NUMERIC(14, 2),
  sales_count         BIGINT NOT NULL DEFAULT 0,
  rating              NUMERIC(5, 2) NOT NULL DEFAULT 0,
  rating_count        INTEGER,
  discount            SMALLINT NOT NULL DEFAULT 0,
  shop_name           TEXT NOT NULL DEFAULT '',
  seller_id           TEXT NOT NULL DEFAULT '',
  shop_link           TEXT NOT NULL DEFAULT '',
  taxonomy_path       TEXT NOT NULL DEFAULT '',
  rank_position       INTEGER NOT NULL DEFAULT 0,
  score               NUMERIC(18, 8),
  completeness_score  NUMERIC(10, 6),
  collected_at        TIMESTAMPTZ,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_products_shop_name ON products(shop_name);
CREATE INDEX IF NOT EXISTS idx_products_taxonomy ON products(taxonomy_path);
CREATE INDEX IF NOT EXISTS idx_products_collected ON products(collected_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_products_price ON products(price_current);
CREATE INDEX IF NOT EXISTS idx_products_sales ON products(sales_count DESC);
CREATE INDEX IF NOT EXISTS idx_products_synced ON products(synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_payload_gin ON products USING GIN (payload);
