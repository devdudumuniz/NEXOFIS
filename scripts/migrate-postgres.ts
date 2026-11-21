/**
 * NEXOFIS — Runner de Migrações PostgreSQL
 * Execução no ambiente do usuário:
 *   DATABASE_URL="postgres://nexofis:SENHA@localhost:5432/nexofis" npx tsx scripts/migrate-postgres.ts
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('Erro: variável DATABASE_URL não definida no ambiente ou .env.');
    process.exit(1);
  }

  let pg: {
    Client: new (cfg: { connectionString: string }) => {
      connect(): Promise<void>;
      query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
      end(): Promise<void>;
    };
  };
  try {
    const modName = 'pg';
    pg = (await import(modName)) as typeof pg;
  } catch {
    console.error('Erro: pacote "pg" não instalado. Execute: npm install pg');
    process.exit(1);
  }

  const migrationsDir = path.resolve(process.cwd(), 'db', 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.error(`Erro: diretório de migrações não encontrado em ${migrationsDir}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum_sha256 TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const appliedRes = await client.query<{ version: number; checksum_sha256: string }>(
      'SELECT version, checksum_sha256 FROM schema_migrations'
    );
    const appliedMap = new Map(appliedRes.rows.map((r) => [r.version, r.checksum_sha256]));

    for (const file of files) {
      const version = Number(file.split('_')[0]);
      const fullPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(fullPath, 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');

      if (appliedMap.has(version)) {
        if (appliedMap.get(version) !== checksum) {
          throw new Error(
            `Divergência de checksum na migração ${file} (versão ${version}). Nunca altere uma migração já aplicada; crie uma nova migração incremental.`
          );
        }
        console.log(`[SKIP] Migração ${file} já aplicada.`);
        continue;
      }

      console.log(`[APPLY] Aplicando migração ${file}...`);
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum_sha256) VALUES ($1, $2, $3)',
        [version, file, checksum]
      );
      console.log(`[OK] Migração ${file} concluída.`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Falha na migração PostgreSQL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
