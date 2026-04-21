import { sleep } from './util.js';
import { waitIfCaptchaBlocking } from './captchaWait.js';
import { config } from './config.js';
import { scrollSitemapPageForLazyContent } from './sitemap.js';

/**
 * Vitrine BR: /br/c/slug/123456 (sem query para chave estável).
 * @param {string} href
 */
export function isLeafCategoryListingUrl(href) {
  try {
    const u = new URL(href, 'https://shop.tiktok.com');
    if (!u.hostname.toLowerCase().includes('tiktok.com')) return false;
    return /^\/[a-z]{2}\/c\/[^/]+\/\d+$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Árvore de categorias do Sitemap (nível 1 + filhos vindos do router, tipicamente nível 2).
 *
 * - **Fonte principal:** `__MODERN_ROUTER_DATA__` → `category_directory` → `directoryRoots`
 *   (estrutura recursiva; sem ordenar alfabeticamente — mantém ordem do sitemap).
 * - **Nomes:** texto visível no DOM (`a` com mesmo path) quando existir; senão `category_name` do JSON.
 * - **Fallback:** blocos DOM `H3-Semibold` + `ul` irmão com links de categoria.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<{ items: object[]; extraction_source: string }>}
 */
export async function extractCategoryTree(page) {
  return page.evaluate(() => {
    function normUrl(href) {
      try {
        return new URL(href, location.href).href.split(/[?#]/)[0];
      } catch {
        return String(href || '').split(/[?#]/)[0];
      }
    }

    function pathRegion() {
      const m = location.pathname.match(/^\/([a-z]{2})\//i);
      return (m && m[1] ? m[1] : 'br').toLowerCase();
    }

    /** pathname tipo /br/c/slug/123 → primeiro texto de link encontrado (ordem DOM). */
    function buildDomNameByPathname() {
      /** @type {Map<string, string>} */
      const map = new Map();
      for (const a of document.querySelectorAll('a[href]')) {
        try {
          const u = new URL(a.href, location.href);
          if (!u.hostname.toLowerCase().includes('tiktok.com')) continue;
          const p = u.pathname.split(/[?#]/)[0];
          if (!/^\/[a-z]{2}\/c\/[^/]+\/\d+$/i.test(p)) continue;
          const text = (a.innerText || a.textContent || '')
            .replace(/\s+/g, ' ')
            .trim()
            .split('\n')[0]
            .slice(0, 400);
          if (!text || /^sitemap$/i.test(text)) continue;
          if (!map.has(p)) map.set(p, text);
        } catch {
          /* ignore */
        }
      }
      return map;
    }

    function parseDirectoryRoots() {
      const el = document.querySelector('script#__MODERN_ROUTER_DATA__');
      if (!el?.textContent?.trim()) return null;
      let router;
      try {
        router = JSON.parse(el.textContent);
      } catch {
        return null;
      }
      const ld = router?.loaderData;
      if (!ld || typeof ld !== 'object') return null;
      for (const key of Object.keys(ld)) {
        const map = ld[key]?.page_config?.components_map;
        if (!Array.isArray(map)) continue;
        for (const comp of map) {
          if (
            comp?.component_type === 'category_directory' &&
            Array.isArray(comp?.component_data?.directoryRoots)
          ) {
            return comp.component_data.directoryRoots;
          }
        }
      }
      return null;
    }

    /**
     * @param {object} treeNode
     * @param {string} host
     * @param {string} region
     * @param {Map<string, string>} domNames
     * @param {{ id: string; name: string } | null} parent
     */
    function walkTreeNode(treeNode, host, region, domNames, parent) {
      const s = treeNode?.self;
      if (!s || typeof s !== 'object') return null;
      const level = Number(s.category_level);
      const id = String(s.category_id || '').trim();
      const slug = String(s.category_name_en || '').trim();
      if (!id || !slug || !Number.isFinite(level) || level < 1) return null;

      const pathname = `/${region}/c/${slug}/${id}`;
      const url = `${host}${pathname}`;
      const fromDom = domNames.get(pathname);
      const fromJson = String(s.category_name || '')
        .replace(/\s+/g, ' ')
        .trim()
        .split('\n')[0]
        .slice(0, 400);
      const name = (fromDom || fromJson).trim();
      if (!name || /^sitemap$/i.test(name)) return null;

      /** @type {Record<string, unknown>} */
      const node = {
        name,
        url,
        category_id: id,
        category_name_en: slug,
        level,
        parent_category_id: parent ? String(parent.id) : null,
        parent_name: parent ? parent.name : null,
      };

      const rawKids = treeNode.children;
      if (!Array.isArray(rawKids) || rawKids.length === 0) return node;

      /** @type {object[]} */
      const children = [];
      for (const ch of rawKids) {
        const w = walkTreeNode(ch, host, region, domNames, { id, name });
        if (w) children.push(w);
      }
      if (children.length) node.children = children;
      return node;
    }

    function fromModernRouter() {
      const roots = parseDirectoryRoots();
      if (!roots?.length) return [];

      const region = pathRegion();
      const host = `${location.protocol}//${location.host}`.replace(/\/$/, '');
      const domNames = buildDomNameByPathname();
      /** @type {object[]} */
      const items = [];
      const seenUrl = new Set();

      for (const root of roots) {
        const s = root?.self;
        if (!s) continue;
        if (Number(s.category_level) !== 1) continue;
        if (String(s.parent_category_id || '0') !== '0') continue;
        const node = walkTreeNode(root, host, region, domNames, null);
        if (!node || seenUrl.has(node.url)) continue;
        seenUrl.add(node.url);
        items.push(node);
      }

      return items;
    }

    /** Fallback: mesma estrutura visual do hub (H3 + lista). */
    function fromDomSections() {
      const root = document.querySelector('main') || document.body;
      const region = pathRegion();
      const host = `${location.protocol}//${location.host}`.replace(/\/$/, '');
      /** @type {object[]} */
      const items = [];
      const seenM = new Set();

      for (const h3a of root.querySelectorAll('a[class*="H3-Semibold"][href]')) {
        let href = h3a.href;
        if (!href || !href.toLowerCase().includes('tiktok.com')) continue;
        let pathname;
        try {
          pathname = new URL(href).pathname.split(/[?#]/)[0];
        } catch {
          continue;
        }
        if (!new RegExp(`^\\/${region}\\/c\\/[^/]+\\/\\d+$`, 'i').test(pathname)) continue;
        const mUrl = normUrl(href);
        if (seenM.has(mUrl)) continue;
        seenM.add(mUrl);

        const mName = (h3a.innerText || h3a.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
          .split('\n')[0]
          .slice(0, 400);
        if (!mName || /^sitemap$/i.test(mName)) continue;

        const parts = pathname.split('/').filter(Boolean);
        const id = parts[parts.length - 1] || '';
        const slug = parts[parts.length - 2] || '';

        /** @type {object} */
        const master = {
          name: mName,
          url: mUrl,
          category_id: id,
          category_name_en: slug,
          level: 1,
          parent_category_id: null,
          parent_name: null,
        };

        const wrap = h3a.closest('div');
        const ul = wrap?.querySelector('ul');
        /** @type {object[]} */
        const children = [];
        if (ul) {
          const seenC = new Set();
          for (const a of ul.querySelectorAll('a[href]')) {
            let chref = a.href;
            if (!chref) continue;
            let p2;
            try {
              p2 = new URL(chref).pathname.split(/[?#]/)[0];
            } catch {
              continue;
            }
            if (!new RegExp(`^\\/${region}\\/c\\/[^/]+\\/\\d+$`, 'i').test(p2)) continue;
            const cUrl = normUrl(chref);
            if (cUrl === mUrl || seenC.has(cUrl)) continue;
            seenC.add(cUrl);
            const cName = (a.innerText || a.textContent || '')
              .replace(/\s+/g, ' ')
              .trim()
              .split('\n')[0]
              .slice(0, 400);
            if (!cName) continue;
            const segs = p2.split('/').filter(Boolean);
            const cid = segs[segs.length - 1] || '';
            const cslug = segs[segs.length - 2] || '';
            children.push({
              name: cName,
              url: cUrl,
              category_id: cid,
              category_name_en: cslug,
              level: 2,
              parent_category_id: id,
              parent_name: mName,
            });
          }
        }
        if (children.length) master.children = children;
        items.push(master);
      }

      return items;
    }

    const fromR = fromModernRouter();
    if (fromR.length > 0) {
      return { items: fromR, extraction_source: 'modern_router_category_directory' };
    }

    const fromD = fromDomSections();
    return {
      items: fromD,
      extraction_source: fromD.length ? 'dom_sections_h3_ul' : 'none',
    };
  });
}

/**
 * Conta nós em profundidade (inclui raízes).
 * @param {object[]} nodes
 */
export function countTreeNodes(nodes) {
  let n = 0;
  const stack = [...nodes];
  while (stack.length) {
    const x = stack.pop();
    if (!x) continue;
    n += 1;
    const ch = x.children;
    if (Array.isArray(ch)) for (const c of ch) stack.push(c);
  }
  return n;
}

/**
 * Abre o Sitemap/hub, faz scroll lazy e devolve a árvore de categorias.
 * @param {import('puppeteer').Page} page
 * @param {string} sitemapUrl
 */
export async function extractTaxonomyFromSitemapPage(page, sitemapUrl) {
  await page.goto(sitemapUrl, { waitUntil: 'networkidle2', timeout: 120_000 });
  await waitIfCaptchaBlocking(page, {
    enabled: config.captchaWaitEnabled,
    maxWaitMs: config.captchaMaxWaitMs,
  });
  await sleep(1500);
  await scrollSitemapPageForLazyContent(page);

  return extractCategoryTree(page);
}
