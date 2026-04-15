import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { createObjectCsvWriter } from 'csv-writer';
import ExcelJS from 'exceljs';

/** Definição das colunas (CSV e Excel). */
export const COLUMN_DEFS = [
  { key: 'sku', header: 'sku', width: 22 },
  { key: 'nome', header: 'nome', width: 48 },
  { key: 'preco_atual', header: 'preco_atual', width: 16 },
  { key: 'preco_original', header: 'preco_original', width: 16 },
  { key: 'nota_avaliacao', header: 'nota_avaliacao', width: 14 },
  { key: 'total_vendas', header: 'total_vendas', width: 16 },
  { key: 'taxonomia', header: 'taxonomia', width: 40 },
  { key: 'link_do_produto', header: 'link_do_produto', width: 56 },
  { key: 'link_imagem', header: 'link_imagem', width: 56 },
  { key: 'data_coleta', header: 'data_coleta', width: 28 },
];

const CSV_HEADERS = COLUMN_DEFS.map((c) => ({ id: c.key, title: c.header }));

function norm(s) {
  return String(s ?? '').trim();
}

/** Migra linhas antigas (ex.: quantidade_vendida, categoria_pai). */
function normalizeLoadedRow(row) {
  return {
    sku: norm(row.sku),
    nome: norm(row.nome),
    preco_atual: norm(row.preco_atual),
    preco_original: norm(row.preco_original),
    nota_avaliacao: norm(row.nota_avaliacao),
    total_vendas: norm(row.total_vendas || row.quantidade_vendida),
    taxonomia: norm(row.taxonomia || row.categoria_pai),
    link_do_produto: norm(row.link_do_produto),
    link_imagem: norm(row.link_imagem),
    data_coleta: norm(row.data_coleta),
  };
}

function looksLikePdpPath(s) {
  return /\/pdp\//i.test(String(s || ''));
}

/** @param {import('exceljs').Cell} cell */
function cellToPlainString(cell) {
  const v = cell.value;
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  if (typeof v === 'object' && Array.isArray(v.richText)) {
    return v.richText.map((t) => t.text || '').join('').trim();
  }
  if (typeof v === 'object' && 'text' in v && v.text != null) return String(v.text).trim();
  if (typeof v === 'object' && 'result' in v && v.result != null) return String(v.result).trim();
  return String(v).trim();
}

/**
 * Armazenamento com upsert: novo SKU, ou atualização se preço / nota / vendas mudarem.
 */
export class DataStore {
  /**
   * @param {string} filePath caminho .json, .csv ou .xlsx
   * @param {'json' | 'csv' | 'xlsx'} format
   */
  constructor(filePath, format) {
    this.filePath = filePath;
    this.format = format;
    /** @type {Map<string, Record<string, string>>} */
    this.bySku = new Map();
  }

  /**
   * @param {string} filePath
   */
  static async create(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const format = ext === '.xlsx' ? 'xlsx' : ext === '.json' ? 'json' : 'csv';
    const store = new DataStore(filePath, format);
    await store.load();
    return store;
  }

  async load() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(this.filePath)) return;

    if (this.format === 'xlsx') await this._loadXlsx();
    else if (this.format === 'json') this._loadJson();
    else this._loadCsv();
  }

  _loadJson() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) return;
      const data = JSON.parse(raw);
      const items = data.items && typeof data.items === 'object' ? data.items : {};
      for (const row of Object.values(items)) {
        const r = normalizeLoadedRow(row);
        if (!r.sku) continue;
        this.bySku.set(r.sku, r);
      }
    } catch {
      /* ficheiro inválido ou vazio */
    }
  }

  _loadCsv() {
    const raw = fs.readFileSync(this.filePath, 'utf8');
    if (!raw.trim()) return;

    const rows = parse(raw, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });

    for (const row of rows) {
      const r = normalizeLoadedRow(row);
      if (!r.sku) continue;
      this.bySku.set(r.sku, r);
    }
  }

  async _loadXlsx() {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(this.filePath);
    const ws = wb.worksheets[0];
    if (!ws) return;

    const headerRow = ws.getRow(1);
    /** @type {Record<number, string>} */
    const colKey = {};
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const h = norm(cell.value);
      if (h) colKey[colNumber] = h;
    });

    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      /** @type {Record<string, string>} */
      const obj = {};
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const key = colKey[colNumber];
        if (!key) return;
        obj[key] = cellToPlainString(cell);
      });
      const r = normalizeLoadedRow(obj);
      if (r.sku) this.bySku.set(r.sku, r);
    });
  }

  /**
   * @param {Array<Record<string, string>>} products
   * @returns {{ added: number, updated: number, skipped: number }}
   */
  upsertMany(products) {
    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const p of products) {
      const incoming = normalizeLoadedRow(p);
      if (!incoming.sku) continue;

      const prev = this.bySku.get(incoming.sku);
      if (!prev) {
        this.bySku.set(incoming.sku, { ...incoming });
        added += 1;
        continue;
      }

      const precoChanged = norm(prev.preco_atual) !== norm(incoming.preco_atual);
      const origChanged = norm(prev.preco_original) !== norm(incoming.preco_original);
      const ratingChanged = norm(prev.nota_avaliacao) !== norm(incoming.nota_avaliacao);
      const soldChanged = norm(prev.total_vendas) !== norm(incoming.total_vendas);

      const linkFilled = !norm(prev.link_do_produto) && norm(incoming.link_do_produto);
      const imgFilled = !norm(prev.link_imagem) && norm(incoming.link_imagem);
      const nomeFilled = !norm(prev.nome) && norm(incoming.nome);
      const taxoFixed =
        looksLikePdpPath(prev.taxonomia) &&
        norm(incoming.taxonomia) &&
        !looksLikePdpPath(incoming.taxonomia);

      if (
        !precoChanged &&
        !origChanged &&
        !ratingChanged &&
        !soldChanged &&
        !linkFilled &&
        !imgFilled &&
        !nomeFilled &&
        !taxoFixed
      ) {
        skipped += 1;
        continue;
      }

      let taxonomia = prev.taxonomia;
      if (taxoFixed) taxonomia = incoming.taxonomia;
      else if (norm(incoming.taxonomia) && !looksLikePdpPath(incoming.taxonomia)) {
        taxonomia = incoming.taxonomia;
      }

      this.bySku.set(incoming.sku, {
        ...prev,
        nome: norm(incoming.nome) || prev.nome,
        preco_atual: norm(incoming.preco_atual) || prev.preco_atual,
        preco_original: norm(incoming.preco_original) || prev.preco_original,
        nota_avaliacao: norm(incoming.nota_avaliacao) || prev.nota_avaliacao,
        total_vendas: norm(incoming.total_vendas) || prev.total_vendas,
        taxonomia: norm(taxonomia) || prev.taxonomia,
        link_do_produto: norm(incoming.link_do_produto) || prev.link_do_produto,
        link_imagem: norm(incoming.link_imagem) || prev.link_imagem,
        data_coleta: norm(incoming.data_coleta) || prev.data_coleta,
        sku: incoming.sku,
      });
      updated += 1;
    }

    return { added, updated, skipped };
  }

  async writeAll() {
    if (this.format === 'xlsx') await this._writeXlsx();
    else if (this.format === 'json') await this._writeJson();
    else await this._writeCsv();
  }

  async _writeJson() {
    const records = Array.from(this.bySku.values()).sort((a, b) => a.sku.localeCompare(b.sku));
    const items = {};
    for (const r of records) items[r.sku] = { ...r };
    const payload = {
      meta: {
        version: 1,
        updated_at: new Date().toISOString(),
        count: records.length,
      },
      items,
    };
    await fs.promises.writeFile(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  async _writeCsv() {
    const writer = createObjectCsvWriter({
      path: this.filePath,
      header: CSV_HEADERS,
    });
    const records = Array.from(this.bySku.values()).sort((a, b) => a.sku.localeCompare(b.sku));
    await writer.writeRecords(records);
  }

  async _writeXlsx() {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Produtos', { properties: { defaultColWidth: 14 } });
    ws.columns = COLUMN_DEFS.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width,
    }));

    const records = Array.from(this.bySku.values()).sort((a, b) => a.sku.localeCompare(b.sku));
    for (const r of records) {
      ws.addRow(r);
    }

    ws.getRow(1).font = { bold: true };
    await wb.xlsx.writeFile(this.filePath);
  }
}
