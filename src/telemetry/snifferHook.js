import {
  buildEndpointKey,
  sha256Utf8,
  classifyError,
  shouldStoreInlineBody,
} from './rawEventStore.js';

/** Limite defensivo: SHA-256 sobre o texto cru da resposta (antes de strip JSONP). */
const BODY_SHA256_MAX_CHARS = 25_000_000;

/**
 * Enfileira telemetria (síncrono, sem I/O). O flush ao Postgres é feito pelo RawEventWriteBuffer.
 *
 * @param {import('./rawEventBuffer.js').RawEventWriteBuffer | null | undefined} buffer
 * @param {object} params
 */
export function enqueueSnifferRawEvent(buffer, params) {
  if (!buffer) return;

  const {
    method,
    url,
    httpStatus,
    bodyText,
    readError,
    parsedJson,
    runId,
    sessionEpoch,
    sampleRate,
    extractorVersion = 'productExtract@v1',
  } = params;

  try {
    let errorClass = classifyError(readError, httpStatus, parsedJson);
    if (readError && errorClass === 'non_json') errorClass = 'body_read_error';

    const bytesLength =
      typeof bodyText === 'string' ? Buffer.byteLength(bodyText, 'utf8') : null;

    let bodySha256 = null;
    if (typeof bodyText === 'string' && bodyText.length <= BODY_SHA256_MAX_CHARS) {
      bodySha256 = sha256Utf8(bodyText);
    }

    const endpointKey = buildEndpointKey(method, url);

    const rate =
      sampleRate !== undefined && sampleRate !== null
        ? Number(sampleRate)
        : Number(process.env.RAW_EVENT_SAMPLE_RATE ?? 0.005);

    const storeInline = shouldStoreInlineBody({
      errorClass,
      sampleRate: Number.isFinite(rate) ? rate : 0.005,
      endpointKey,
    });

    buffer.enqueue({
      capturedAt: new Date(),
      source: 'sniffer',
      endpointKey,
      extractorVersion,
      url,
      httpStatus,
      bytesLength,
      bodySha256,
      bodyStorage: storeInline ? 'inline' : 'skipped',
      bodyJson: storeInline ? parsedJson : null,
      errorClass,
      runId,
      sessionEpoch,
    });
  } catch (e) {
    console.warn('[telemetry] raw_events enqueue:', e?.message || e);
  }
}

/**
 * Caminho legado: insert imediato (1 row). Preferir enqueue + RawEventWriteBuffer no sniffer.
 * @param {import('./rawEventStore.js').RawEventStore} rawEventStore
 */
export async function recordSnifferRawEvent(rawEventStore, params) {
  if (!rawEventStore) return;

  const {
    method,
    url,
    httpStatus,
    bodyText,
    readError,
    parsedJson,
    runId,
    sessionEpoch,
    sampleRate,
    extractorVersion = 'productExtract@v1',
  } = params;

  try {
    let errorClass = classifyError(readError, httpStatus, parsedJson);
    if (readError && errorClass === 'non_json') errorClass = 'body_read_error';
    const bytesLength =
      typeof bodyText === 'string' ? Buffer.byteLength(bodyText, 'utf8') : null;

    let bodySha256 = null;
    if (typeof bodyText === 'string' && bodyText.length <= BODY_SHA256_MAX_CHARS) {
      bodySha256 = sha256Utf8(bodyText);
    }

    const endpointKey = buildEndpointKey(method, url);

    const rate =
      sampleRate !== undefined && sampleRate !== null
        ? Number(sampleRate)
        : Number(process.env.RAW_EVENT_SAMPLE_RATE ?? 0.005);

    const storeInline = shouldStoreInlineBody({
      errorClass,
      sampleRate: Number.isFinite(rate) ? rate : 0.005,
      endpointKey,
    });

    await rawEventStore.insertRawEvent({
      source: 'sniffer',
      endpointKey,
      extractorVersion,
      url,
      httpStatus,
      bytesLength,
      bodySha256,
      bodyStorage: storeInline ? 'inline' : 'skipped',
      bodyJson: storeInline ? parsedJson : null,
      errorClass,
      runId,
      sessionEpoch,
    });
  } catch (e) {
    console.warn('[telemetry] raw_events insert falhou:', e?.message || e);
  }
}
