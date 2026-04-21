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

## Executar

```bash
npm start
```

Equivale a `node src/index.js`. O `dotenv` carrega o ficheiro `.env` na raiz.

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

- **Catálogo canónico:** `output/produtos.json` (caminho configurável com `OUTPUT_JSON`)
- **Métricas da corrida:** `output/metrics.json` (`METRICS_JSON_PATH`)

## Referência completa de opções

Ver **`.env.example`** (URLs, categorias, Postgres, `RUN_DURATION_MINUTES`, `STOP_AFTER_PDP_OK`, CAPTCHA, etc.).
