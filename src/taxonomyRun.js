/**
 * Etapa paralela: extrair taxonomia do Sitemap/hub (árvore: categorias master + subcategorias).
 * Uso: npm run taxonomy
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from './config.js';
import { launchBrowser } from './browser.js';
import { writeFileAtomic } from './util.js';
import {
  extractTaxonomyFromSitemapPage,
  countTreeNodes,
} from './sitemapTaxonomy.js';

async function main() {
  const sitemapUrl = config.taxonomySitemapUrl;
  const outPath = path.resolve(config.taxonomyOutputJson);

  console.info('[taxonomy] URL:', sitemapUrl);
  console.info('[taxonomy] saída:', outPath);

  const { browser } = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    const { items, extraction_source } = await extractTaxonomyFromSitemapPage(
      page,
      sitemapUrl,
    );

    const totalNodes = countTreeNodes(items);

    const payload = {
      meta: {
        version: 2,
        extraction: 'category_tree',
        extraction_source,
        source_url: sitemapUrl,
        updated_at: new Date().toISOString(),
        master_count: items.length,
        total_nodes: totalNodes,
      },
      items,
    };

    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await writeFileAtomic(outPath, JSON.stringify(payload, null, 2), 'utf8');
    console.info(
      `[taxonomy] concluído: ${items.length} masters, ${totalNodes} nós no total (fonte: ${extraction_source}).`,
    );
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('[taxonomy]', e);
  process.exitCode = 1;
});
