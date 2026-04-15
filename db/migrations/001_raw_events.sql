-- Fase 1: ingestão append-only de respostas capturadas (sniffer / shadow / browser).
-- Aplicar: psql "$DATABASE_URL" -f db/migrations/001_raw_events.sql

CREATE TABLE IF NOT EXISTS raw_events (
  id                bigserial PRIMARY KEY,
  captured_at       timestamptz NOT NULL DEFAULT now(),
  source            text NOT NULL,
  endpoint_key      text NOT NULL,
  extractor_version text NOT NULL,
  url               text NOT NULL,
  http_status       int,
  bytes_length      int,
  body_sha256       text,
  body_storage      text,
  body_json         jsonb,
  error_class       text,
  session_epoch     bigint,
  run_id            uuid
);

CREATE INDEX IF NOT EXISTS idx_raw_events_endpoint_time
  ON raw_events (endpoint_key, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_raw_events_sha
  ON raw_events (body_sha256);
