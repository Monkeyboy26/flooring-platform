import pg from 'pg';

export const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  // A single storefront page load fans out ~15+ concurrent queries (the facets
  // endpoint runs one COUNT per attribute + brand/price/tag, alongside the skus,
  // suggest and related calls). The pg default max of 10 serialized them into a
  // ~12s wait and, under a second concurrent visitor, exhausted the pool and
  // 500'd. Postgres (max_connections=100) comfortably handles more.
  max: parseInt(process.env.DB_POOL_MAX || '30', 10),
  // A query awaiting a half-dead connection (laptop sleep, network blip) hangs
  // forever by default — scrapers then freeze silently until the 4h reaper.
  keepAlive: true,
  connectionTimeoutMillis: 15000,
  statement_timeout: 120000,   // server-side, per statement
  query_timeout: 130000        // client-side backstop, slightly above so the server errors first
});
