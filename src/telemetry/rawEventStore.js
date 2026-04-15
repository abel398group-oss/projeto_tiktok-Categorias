import crypto from 'node:crypto';

/**
 * Gera hash SHA-256 de string UTF-8.
 * Retorna null se input não for string.
 */
export function sha256Utf8(input) {
  if (typeof input !== 'string') return null;
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Chave estável: METHOD + hostname + pathname (sem querystring).
 * Ex.: GET https://shop.tiktok.com/api/foo?x=1 → GET shop.tiktok.com /api/foo
 */
export function buildEndpointKey(method, rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = (url.hostname || '').toLowerCase() || 'unknown_host';
    const path = url.pathname || '/';
    return `${String(method || 'GET').toUpperCase()} ${host} ${path}`;
  } catch {
    return `${String(method || 'GET').toUpperCase()} unknown_host unknown_path`;
  }
}

/**
 * Lista de endpoint_key (exact match) para sempre gravar body_json inline — estudo de endpoints novos.
 * Env: RAW_EVENT_FORCE_INLINE_ENDPOINT_KEYS=GET shop.tiktok.com /api/a,...
 */
export function parseForceInlineEndpointKeys() {
  const raw = process.env.RAW_EVENT_FORCE_INLINE_ENDPOINT_KEYS ?? '';
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Classifica erro de forma simples e previsível.
 */
export function classifyError(error, httpStatus, parsedJson) {
  if (error?.name === 'AbortError') return 'timeout';
  if (error?.code === 'ETIMEDOUT') return 'timeout';
  if (error?.code === 'ECONNRESET') return 'connection_reset';
  if (httpStatus === 401) return 'unauthorized';
  if (httpStatus === 403) return 'forbidden';
  if (httpStatus === 404) return 'not_found';
  if (httpStatus === 429) return 'rate_limit';
  if (httpStatus >= 500) return 'server_error';
  if (parsedJson === null) return 'non_json';
  return null;
}

/**
 * Decide se body_json deve ser persistido inline.
 * - erro (qualquer errorClass)
 * - amostragem aleatória (sampleRate)
 * - endpoint em estudo: RAW_EVENT_FORCE_INLINE_ENDPOINT_KEYS (match exacto a buildEndpointKey)
 */
export function shouldStoreInlineBody({
  errorClass,
  sampleRate = 0.005,
  endpointKey = '',
  forceInlineEndpointKeys = null,
}) {
  if (errorClass) return true;
  const keys = forceInlineEndpointKeys ?? parseForceInlineEndpointKeys();
  if (endpointKey && keys.length > 0 && keys.includes(endpointKey)) return true;
  return Math.random() < sampleRate;
}

export class RawEventStore {
  constructor({ pgPool, extractorVersion = 'productExtract@v1' }) {
    this.pgPool = pgPool;
    this.extractorVersion = extractorVersion;
  }

  async insertRawEvent(event) {
    const query = `
      INSERT INTO raw_events (
        captured_at,
        source,
        endpoint_key,
        extractor_version,
        url,
        http_status,
        bytes_length,
        body_sha256,
        body_storage,
        body_json,
        error_class,
        session_epoch,
        run_id
      )
      VALUES (
        COALESCE($1, now()),
        $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13
      )
      RETURNING id
    `;

    const values = [
      event.capturedAt ?? null,
      event.source,
      event.endpointKey,
      event.extractorVersion ?? this.extractorVersion,
      event.url,
      event.httpStatus ?? null,
      event.bytesLength ?? null,
      event.bodySha256 ?? null,
      event.bodyStorage ?? 'skipped',
      event.bodyJson ? JSON.stringify(event.bodyJson) : null,
      event.errorClass ?? null,
      event.sessionEpoch ?? null,
      event.runId ?? null,
    ];

    const result = await this.pgPool.query(query, values);
    return result.rows[0];
  }

  /**
   * INSERT multi-linha (uma ida ao Postgres).
   * @param {Array<Record<string, unknown>>} events
   */
  async insertRawEventsBatch(events) {
    if (!events.length) return { inserted: 0 };
    const placeholders = [];
    const values = [];
    let p = 1;
    for (const event of events) {
      placeholders.push(
        `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb, $${p++}, $${p++}, $${p++})`
      );
      values.push(
        event.capturedAt ?? null,
        event.source,
        event.endpointKey,
        event.extractorVersion ?? this.extractorVersion,
        event.url,
        event.httpStatus ?? null,
        event.bytesLength ?? null,
        event.bodySha256 ?? null,
        event.bodyStorage ?? 'skipped',
        event.bodyJson != null ? JSON.stringify(event.bodyJson) : null,
        event.errorClass ?? null,
        event.sessionEpoch ?? null,
        event.runId ?? null
      );
    }
    const sql = `
      INSERT INTO raw_events (
        captured_at,
        source,
        endpoint_key,
        extractor_version,
        url,
        http_status,
        bytes_length,
        body_sha256,
        body_storage,
        body_json,
        error_class,
        session_epoch,
        run_id
      )
      VALUES ${placeholders.join(', ')}
    `;
    await this.pgPool.query(sql, values);
    return { inserted: events.length };
  }
}
