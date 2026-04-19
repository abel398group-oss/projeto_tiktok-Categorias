import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createObjectCsvWriter } from 'csv-writer';
import { config } from './config.js';
import { emptyProduct, fromLegacyRow, toLegacyRow } from './productSchema.js';
import { COLUMN_DEFS } from './dataStore.js';
import {
  mergeCanonicalForUpsert,
  normalizeProductRecord,
  validateStorable,
} from './recordNormalizer.js';
import { writeFileAtomic } from './util.js';

const CSV_HEADERS = COLUMN_DEFS.map((c) => ({ id: c.key, title: c.header }));

/**
 * Armazém canónico (produtos.json) + CSV opcional; processo único.
 */
export class CanonicalJsonStore {
  /**
   * @param {string} jsonPath
   * @param {string} [csvPath] se definido, exporta CSV compatível com DataStore
   * @param {{ metrics?: import('./runMetrics.js').RunMetrics }} [opts]
   */
  constructor(jsonPath, csvPath = '', opts = {}) {
    this.jsonPath = path.resolve(jsonPath);
    this.csvPath = csvPath ? path.resolve(csvPath) : '';
    /** @type {Map<string, import('./productSchema.js').CanonicalProduct>} */
    this.byId = new Map();
    this.meta = { version: 1, updated_at: '' };
    /** @type {import('./runMetrics.js').RunMetrics | null} */
    this.metrics = opts.metrics ?? null;
    /** Produtos alterados desde o último sync Postgres (quando `PRODUCTS_DB_SYNC`). */
    this.pgDirtyIds = new Set();
  }

  clearPgDirtyIds() {
    this.pgDirtyIds.clear();
  }

  /**
   * @param {string} jsonPath
   * @param {string} [csvPath]
   * @param {{ metrics?: import('./runMetrics.js').RunMetrics }} [opts]
   */
  static async create(jsonPath, csvPath = '', opts = {}) {
    const s = new CanonicalJsonStore(jsonPath, csvPath, opts);
    await s.load();
    return s;
  }

  async load() {
    const dir = path.dirname(this.jsonPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.jsonPath)) return;

    try {
      const raw = await fsPromises.readFile(this.jsonPath, 'utf8');
      if (!raw.trim()) return;
      const data = JSON.parse(raw);
      this.meta = data.meta && typeof data.meta === 'object' ? data.meta : this.meta;
      const items = data.items && typeof data.items === 'object' ? data.items : {};
      for (const v of Object.values(items)) {
        if (!v || typeof v !== 'object') continue;
        const id = String(v.product_id || '').trim();
        if (!id) continue;
        this.byId.set(id, normalizeProductRecord({ ...emptyProduct(), ...v }));
      }
    } catch {
      /* ignorar JSON inválido */
    }
  }

  /**
   * @param {Record<string, unknown>} legacyRow
   * @param {string} provenance ex.: category_ssr, listing_network, pdp
   */
  upsertLegacy(legacyRow, provenance) {
    const incoming = fromLegacyRow(legacyRow);
    const id = incoming.product_id;
    if (!id) {
      const st = { added: 0, updated: 0, skipped: 1, reason: 'missing_id', product_id: '' };
      this.metrics?.onUpsertResult(provenance, st, legacyRow);
      return st;
    }

    const prev = this.byId.get(id) || emptyProduct();
    const merged = mergeCanonicalForUpsert(prev, incoming, provenance);
    const norm = normalizeProductRecord(merged);
    const v = validateStorable(norm, provenance);
    if (!v.ok) {
      const st = { added: 0, updated: 0, skipped: 1, reason: v.reason, product_id: id };
      this.metrics?.onUpsertResult(provenance, st, legacyRow);
      return st;
    }

    const isNew = !this.byId.has(id);
    this.byId.set(id, norm);
    if (config.productsDbSync) this.pgDirtyIds.add(id);
    const st = { added: isNew ? 1 : 0, updated: isNew ? 0 : 1, skipped: 0, reason: '', product_id: id };
    this.metrics?.onUpsertResult(provenance, st, legacyRow);
    return st;
  }

  /**
   * @param {Array<Record<string, unknown>>} rows
   * @param {string} provenance
   */
  upsertManyLegacy(rows, provenance) {
    let added = 0;
    let updated = 0;
    let skipped = 0;
    for (const r of rows) {
      const st = this.upsertLegacy(r, provenance);
      added += st.added;
      updated += st.updated;
      skipped += st.skipped;
    }
    return { added, updated, skipped };
  }

  async writeJson() {
    const items = {};
    for (const [k, v] of this.byId) {
      items[k] = normalizeProductRecord({ ...v });
    }
    const payload = {
      meta: {
        ...this.meta,
        version: 1,
        updated_at: new Date().toISOString(),
        count: this.byId.size,
      },
      items,
    };
    await fsPromises.mkdir(path.dirname(this.jsonPath), { recursive: true });
    await writeFileAtomic(this.jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  }

  async writeCsvIfConfigured() {
    if (!config.enableCsv || !this.csvPath) return;
    const writer = createObjectCsvWriter({
      path: this.csvPath,
      header: CSV_HEADERS,
    });
    const records = Array.from(this.byId.values())
      .map((p) => toLegacyRow(p))
      .sort((a, b) => a.sku.localeCompare(b.sku));
    await writer.writeRecords(records);
  }

  async flush() {
    await this.writeJson();
    await this.writeCsvIfConfigured();
  }
}
