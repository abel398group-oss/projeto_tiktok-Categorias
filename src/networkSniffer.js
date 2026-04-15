import { extractProductsFromJson, normalizeProduct } from './productExtract.js';

function urlMatches(url, includesList) {
  const u = url.toLowerCase();
  return includesList.some((frag) => u.includes(frag.toLowerCase()));
}

function stripJsonPrefix(text) {
  return String(text)
    .replace(/^\s*while\s*\(1\);\s*/i, '')
    .replace(/^\s*\)\]\}'\s*/, '')
    .trim();
}

export class NetworkSniffer {
  /**
   * @param {import('puppeteer').Page} page
   * @param {string[]} urlIncludes
   * @param {{ debug?: boolean; onDebugSample?: (e: Record<string, unknown>) => void; debugLogBudget?: number }} [opts]
   */
  constructor(page, urlIncludes, opts = {}) {
    this.page = page;
    this.urlIncludes = urlIncludes;
    this.buffer = [];
    this.seenProductIds = new Set();
    this._roundNewCount = 0;
    this._attached = false;
    /** @type {string} */
    this.categoriaPaiAtual = '';
    this._debug = Boolean(opts.debug);
    this._onDebugSample = typeof opts.onDebugSample === 'function' ? opts.onDebugSample : null;
    this._debugLogBudget = Number.isFinite(opts.debugLogBudget) ? opts.debugLogBudget : 120;
    this._debugLogsEmitted = 0;
  }

  attach() {
    if (this._attached) return;
    this._attached = true;
    this.page.on('response', (response) => {
      void this._onResponse(response);
    });
  }

  beginScrollRound() {
    this._roundNewCount = 0;
  }

  getRoundNewProductCount() {
    return this._roundNewCount;
  }

  drainBuffer() {
    const b = this.buffer;
    this.buffer = [];
    return b;
  }

  resetForNewCategory() {
    this.seenProductIds.clear();
    this.buffer = [];
    this._roundNewCount = 0;
  }

  async _onResponse(response) {
    try {
      const req = response.request();
      const rt = req.resourceType();
      if (rt !== 'xhr' && rt !== 'fetch') return;

      const url = response.url();
      if (!urlMatches(url, this.urlIncludes)) return;

      const status = response.status();
      if (status < 200 || status >= 300) return;

      const ct = (response.headers()['content-type'] || '').toLowerCase();
      const looksJson =
        ct.includes('json') ||
        ct.includes('javascript') ||
        ct.includes('text/plain') ||
        ct === '';

      if (!looksJson) return;

      const rawText = await response.text();
      const text = stripJsonPrefix(rawText);
      if (!text || text.length > 6_000_000) return;

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return;
      }

      const extracted = extractProductsFromJson(json, []);
      if (!extracted.length) return;

      if (this._debug) {
        if (this._debugLogsEmitted < this._debugLogBudget) {
          this._debugLogsEmitted += 1;
          console.error(
            `[sniffer-debug] #${this._debugLogsEmitted} status=${status} raw=${extracted.length} ${url.slice(0, 180)}`
          );
        }
      }

      const cat = this.categoriaPaiAtual || '';
      const normalized = extracted.map((e) => normalizeProduct(e.raw, cat)).filter(Boolean);

      if (this._onDebugSample) {
        this._onDebugSample({
          t: new Date().toISOString(),
          status,
          url: url.slice(0, 400),
          extracted: extracted.length,
          normalized: normalized.length,
        });
      }

      for (const n of normalized) {
        const id = n.sku;
        if (!id) continue;
        const isNew = !this.seenProductIds.has(id);
        if (isNew) {
          this.seenProductIds.add(id);
          this._roundNewCount += 1;
        }
        this.buffer.push(n);
      }
    } catch {
      // resposta cancelada, corpo vazio, etc.
    }
  }
}
