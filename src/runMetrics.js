import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const DISCARD_SAMPLE_MAX = 30;
const SNIFFER_DEBUG_MAX = 40;
const CATEGORY_SUMMARY_MAX = 80;

export class RunMetrics {
  constructor() {
    this.run_started_at = new Date().toISOString();
    this.run_finished_at = '';
    /** @type {{ ssr_rows: number; network_rows: number; pdp_attempts: number; pdp_ok: number; pdp_errors: number }} */
    this.extracted = { ssr_rows: 0, network_rows: 0, pdp_attempts: 0, pdp_ok: 0, pdp_errors: 0 };
    /** @type {{ added: number; updated: number }} */
    this.stored = { added: 0, updated: 0 };
    this.discarded = {
      total: 0,
      /** @type {Record<string, number>} */
      by_reason: {},
      /** @type {Array<Record<string, unknown>>} */
      sample: [],
    };
    /** @type {Array<Record<string, unknown>>} */
    this.categories = [];
    /** @type {Array<Record<string, unknown>>} */
    this.sniffer_debug = [];
  }

  /**
   * @param {Record<string, unknown>} entry
   */
  addSnifferDebug(entry) {
    if (!config.debugScraper) return;
    if (this.sniffer_debug.length >= SNIFFER_DEBUG_MAX) return;
    this.sniffer_debug.push(entry);
  }

  /**
   * @param {Record<string, unknown>} summary
   */
  recordCategorySummary(summary) {
    if (this.categories.length >= CATEGORY_SUMMARY_MAX) return;
    this.categories.push(summary);
  }

  /**
   * @param {string} provenance
   * @param {{ added: number; updated: number; skipped: number; reason: string; product_id?: string }} result
   * @param {Record<string, unknown>} [legacyRow]
   */
  onUpsertResult(provenance, result, legacyRow = {}) {
    this.stored.added += result.added || 0;
    this.stored.updated += result.updated || 0;
    if (!result.skipped || !result.reason) return;
    this.discarded.total += 1;
    const r = result.reason;
    this.discarded.by_reason[r] = (this.discarded.by_reason[r] || 0) + 1;
    if (this.discarded.sample.length >= DISCARD_SAMPLE_MAX) return;
    this.discarded.sample.push({
      t: new Date().toISOString(),
      provenance,
      reason: r,
      product_id: String(result.product_id || legacyRow.sku || '').slice(0, 64),
      name_hint: String(legacyRow.nome || '').slice(0, 80),
    });
  }

  toJSON() {
    /** @type {Record<string, unknown>} */
    const base = {
      run_started_at: this.run_started_at,
      run_finished_at: this.run_finished_at,
      extracted: { ...this.extracted },
      stored: { ...this.stored },
      discarded: {
        total: this.discarded.total,
        by_reason: { ...this.discarded.by_reason },
        sample: [...this.discarded.sample],
      },
      categories: [...this.categories],
    };
    if (config.debugScraper && this.sniffer_debug.length) {
      base.sniffer_debug = [...this.sniffer_debug];
    }
    return base;
  }
}

/**
 * Grava métricas agregadas e, se configurado, ficheiro leve de descartados.
 * @param {RunMetrics} metrics
 */
export async function flushRunArtifacts(metrics) {
  metrics.run_finished_at = new Date().toISOString();
  const mp = path.resolve(config.metricsJsonPath);
  await fs.mkdir(path.dirname(mp), { recursive: true });
  await fs.writeFile(mp, JSON.stringify(metrics.toJSON(), null, 2), 'utf8');

  const dd = config.discardedDebugPath && String(config.discardedDebugPath).trim();
  if (!dd) return;
  const dp = path.resolve(dd);
  await fs.mkdir(path.dirname(dp), { recursive: true });
  await fs.writeFile(
    dp,
    JSON.stringify(
      {
        generated_at: metrics.run_finished_at,
        by_reason: { ...metrics.discarded.by_reason },
        sample: [...metrics.discarded.sample],
      },
      null,
      2
    ),
    'utf8'
  );
}
