/**
 * Buffer em memória + flush periódico em lote para raw_events (sem await no hot path do sniffer).
 */
export class RawEventWriteBuffer {
  /**
   * @param {{
   *   rawEventStore: import('./rawEventStore.js').RawEventStore;
   *   maxBuffer?: number;
   *   flushIntervalMs?: number;
   *   batchSize?: number;
   * }} opts
   */
  constructor({ rawEventStore, maxBuffer = 5000, flushIntervalMs = 2000, batchSize = 100 }) {
    this.store = rawEventStore;
    this.maxBuffer = Math.max(1, maxBuffer);
    this.flushIntervalMs = Math.max(200, flushIntervalMs);
    this.batchSize = Math.max(1, batchSize);
    /** @type {Record<string, unknown>[]} */
    this._queue = [];
    /** @type {ReturnType<typeof setInterval> | null} */
    this._timer = null;
    this._flushRunning = false;
    /** impede _flushTick após stop; evita corrida com stopAndFlushAll */
    this._stopping = false;
    this.metrics = { totalInserted: 0, totalFailed: 0, totalDropped: 0 };
    /** último aviso de buffer cheio (evita spam) */
    this._lastFullWarnAt = 0;
    /** contador de lotes gravados (logs periódicos) */
    this._flushBatchCount = 0;
  }

  getMetrics() {
    return {
      bufferLength: this._queue.length,
      totalInserted: this.metrics.totalInserted,
      totalFailed: this.metrics.totalFailed,
      totalDropped: this.metrics.totalDropped,
    };
  }

  /**
   * Enfileira uma linha já normalizada (campos alinhados a insertRawEventsBatch).
   * @returns {boolean} false se buffer cheio (evento descartado)
   */
  enqueue(row) {
    if (this._queue.length >= this.maxBuffer) {
      this.metrics.totalDropped += 1;
      const now = Date.now();
      if (now - this._lastFullWarnAt > 10_000) {
        this._lastFullWarnAt = now;
        console.warn(
          `[telemetry] raw_events: buffer cheio (max=${this.maxBuffer}); novos eventos são descartados. ` +
            `descartados_total=${this.metrics.totalDropped}`
        );
      }
      return false;
    }
    this._queue.push(row);
    return true;
  }

  start() {
    if (this._timer || !this.store) return;
    this._timer = setInterval(() => {
      void this._flushTick();
    }, this.flushIntervalMs);
    console.info(
      `[telemetry] RawEventWriteBuffer.start() · flush a cada ${this.flushIntervalMs}ms · até ${this.batchSize} registos/lote · fila máx ${this.maxBuffer}`
    );
  }

  async _flushTick() {
    if (this._stopping || this._flushRunning || !this.store) return;
    this._flushRunning = true;
    try {
      let guard = 0;
      while (this._queue.length > 0 && guard < 10_000) {
        guard += 1;
        const n = Math.min(this.batchSize, this._queue.length);
        const batch = this._queue.splice(0, n);
        const ok = await this._insertBatchWithRetry(batch);
        if (!ok) break;
      }
    } finally {
      this._flushRunning = false;
    }
  }

  /**
   * @param {Record<string, unknown>[]} batch
   */
  async _insertBatchWithRetry(batch) {
    if (!batch.length) return true;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.store.insertRawEventsBatch(batch);
        this.metrics.totalInserted += batch.length;
        this._flushBatchCount += 1;
        if (process.env.RAW_EVENT_LOG_FLUSH !== 'silent') {
          const every = Math.max(1, Number(process.env.RAW_EVENT_LOG_FLUSH_EVERY) || 1);
          if (this._flushBatchCount <= 3 || this._flushBatchCount % every === 0) {
            console.info(
              `[telemetry] raw_events batch INSERT ok: +${batch.length} (acumulado ${this.metrics.totalInserted} · ainda na fila ${this._queue.length})`
            );
          }
        }
        return true;
      } catch (e) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        console.error('[telemetry] raw_events batch insert falhou após retry; lote descartado:', e?.message || e);
        this.metrics.totalFailed += batch.length;
        return false;
      }
    }
    return false;
  }

  /** Para o intervalo e esvazia a fila (shutdown limpo). */
  async stopAndFlushAll() {
    this._stopping = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    for (let i = 0; i < 10_000 && this._flushRunning; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    while (this._queue.length > 0) {
      const n = Math.min(this.batchSize, this._queue.length);
      const batch = this._queue.splice(0, n);
      await this._insertBatchWithRetry(batch);
    }
    this._stopping = false;
  }
}
