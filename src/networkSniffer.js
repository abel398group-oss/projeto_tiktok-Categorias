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
   */
  constructor(page, urlIncludes) {
    this.page = page;
    this.urlIncludes = urlIncludes;
    this.buffer = [];
    this.seenProductIds = new Set();
    this._roundNewCount = 0;
    this._attached = false;
    /** @type {string} */
    this.categoriaPaiAtual = '';
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

      const cat = this.categoriaPaiAtual || '';
      const normalized = extracted.map((e) => normalizeProduct(e.raw, cat)).filter(Boolean);

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
