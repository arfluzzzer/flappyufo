import { Pool } from "pg";

const globalForPg = global as unknown as { pool: Pool };

export const pool =
  globalForPg.pool ||
  new Pool({
    connectionString: process.env.DATABASE_URL,
  });

if (process.env.NODE_ENV !== "production") globalForPg.pool = pool;

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(32) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      score INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}
