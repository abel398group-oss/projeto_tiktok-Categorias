import pg from 'pg';

const { Pool } = pg;

/**
 * @param {string} [connectionString] se omitido, usa process.env.DATABASE_URL (sempre trim)
 */
export function createPgPool(connectionString) {
  const raw =
    connectionString !== undefined && connectionString !== null
      ? connectionString
      : process.env.DATABASE_URL || '';
  const cs = String(raw).trim();
  if (!cs) {
    throw new Error('DATABASE_URL não configurada.');
  }

  return new Pool({
    connectionString: cs,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
}
