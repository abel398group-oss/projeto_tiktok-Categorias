# z — Execução do scraper (TikTok Shop)

Guia rápido para rodar o projeto localmente.

## Pré-requisitos

- **Node.js 18+**
- Conta/sessão TikTok Shop válida (login manual no browser quando o scraper abrir, salvo em `USER_DATA_DIR`)

## Primeira vez

```bash
npm install
```

Copie as variáveis de ambiente e ajuste o que precisar:

```bash
cp .env.example .env
```

(No Windows PowerShell pode usar `Copy-Item .env.example .env`.)

## Executar (scraper de produtos — fluxo clássico)

```bash
npm start
```

Equivale a `node src/index.js`. O `dotenv` carrega o ficheiro `.env` na raiz.

---

## Taxonomia e snapshots (ficheiros separados de `produtos.json`)

Estes dois comandos **não** usam o pipeline de `npm start` e **não** escrevem em `output/produtos.json` por defeito.

| Comando | Saída | O quê |
|--------|--------|--------|
| **`npm run taxonomy`** | `output/categories.json` (ou `TAXONOMY_OUTPUT_JSON`) | Árvore de categorias do Sitemap (masters + subcategorias), fonte estática. |
| **`npm run master-snapshots`** | `output/master_category_snapshots.json` (ou `MASTER_SNAPSHOT_OUTPUT_JSON`) | Snapshot dinâmico: produtos visíveis no dashboard de **cada categoria master**; lê `categories.json` como entrada. |

Ordem sugerida: primeiro a taxonomia, depois os snapshots (os snapshots dependem de `categories.json` com as masters).

```bash
npm run taxonomy
npm run master-snapshots
```

Variáveis úteis: `TAXONOMY_OUTPUT_JSON`, `TAXONOMY_SITEMAP_URL`, `MASTER_SNAPSHOT_CATEGORIES_JSON`, `MASTER_SNAPSHOT_OUTPUT_JSON`, `MASTER_SNAPSHOT_MAX_MASTERS` (testes) — ver `.env.example`.

### Só mapear categorias (taxonomia)

```bash
npm run taxonomy
```

Gera **`output/categories.json`** a partir do hub/sitemap. Inclui categorias **master** (nível 1) e **subcategorias** aninhadas em `children`. Não altera `produtos.json`. URLs e paths: `TAXONOMY_*` e `TIKTOK_SITEMAP_URL` no `.env.example`.

### Só snapshot por categoria master

```bash
npm run master-snapshots
```

Lê as masters (`level === 1`) de **`categories.json`**, abre cada URL de categoria, grava os produtos do dashboard noutro ficheiro. Ver secção **Onde ver o resultado** abaixo.

## Modo mais conservador (menos ritmo agressivo)

No `.env`:

```env
SAFE_SCRAPING=true
```

Delays e limites padrão ficam mais altos; variáveis que você definir no `.env` continuam a prevalecer. Detalhes dos valores: comentários em `.env.example`.

### Modo diagnóstico (ainda mais lento + logs `[diag]`)

```env
ULTRA_SAFE_DIAGNOSTIC=true
```

Útil para correlacionar puzzle/captcha com fase (listagem vs PDP). Ver `.env.example`.

## Onde ver o resultado

- **Catálogo canónico (fluxo `npm start`):** `output/produtos.json` (`OUTPUT_JSON`)
- **Taxonomia (árvore de categorias):** `output/categories.json` — **`npm run taxonomy`** — (`TAXONOMY_OUTPUT_JSON`)
- **Snapshots por master (dashboard, dinâmico):** `output/master_category_snapshots.json` — **`npm run master-snapshots`** — (`MASTER_SNAPSHOT_OUTPUT_JSON`)
- **Métricas da corrida (`npm start`):** `output/metrics.json` (`METRICS_JSON_PATH`)

## Referência completa de opções

Ver **`.env.example`** (URLs, categorias, Postgres, `RUN_DURATION_MINUTES`, `STOP_AFTER_PDP_OK`, CAPTCHA, etc.).
