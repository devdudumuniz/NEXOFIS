import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNexofisStore } from '../storage';

/**
 * Defeito 1.1 — INEP persistence: API retornava 201 sem persistir.
 *
 * Causa raiz: v5 CHECK(source_kind IN ('siaps','sinapi','camara_personnel'))
 * nao incluia 'inep'. INSERT OR IGNORE silenciava a violacao e o metodo
 * devolvia sucesso sem confirmar a gravacao.
 *
 * Correcao:
 * - Migracao v6 recria a tabela com 'inep' no CHECK.
 * - INSERT sem OR IGNORE (throws on violation).
 * - Verificacao changes === 1 + re-leitura do registro.
 */
test('1.1 INEP snapshot persistence: v6 migration + INSERT verification + restart recovery', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexofis-inep-persist-'));
  const dbPath = path.join(tmpDir, 'test.db');

  try {
    const store1 = createNexofisStore(dbPath);
    assert.equal(store1.getSchemaVersion(), 6, 'Schema must reach v6 after first boot');

    const siapsResult = store1.saveOfficialSnapshot({
      id: 'snap_siaps_test_001',
      sourceKind: 'siaps',
      filename: 'siaps-test.csv',
      sha256: 'a'.repeat(64),
      competencia: '2026-01',
      uf: null,
      metadataJson: JSON.stringify({ rowCount: 10 }),
      payloadJson: JSON.stringify([{ indicator: 'test' }]),
      importedBy: 'test-auditor',
    });
    assert.equal(siapsResult.alreadyExisted, false, 'SIAPS snapshot must insert on first call');

    const inepResult = store1.saveOfficialSnapshot({
      id: 'snap_inep_test_001',
      sourceKind: 'inep',
      filename: 'inep-test.csv',
      sha256: 'b'.repeat(64),
      competencia: '2026',
      uf: 'SP',
      metadataJson: JSON.stringify({ rowCount: 5 }),
      payloadJson: JSON.stringify([{ school: 'test' }]),
      importedBy: 'test-auditor',
    });
    assert.equal(inepResult.alreadyExisted, false, 'INEP snapshot must insert on first call');
    assert.equal(inepResult.id, 'snap_inep_test_001');

    const allSnapshots = store1.listOfficialSnapshots();
    const inepSnapshots = store1.listOfficialSnapshots('inep');
    assert.ok(
      allSnapshots.some((s) => s.sourceKind === 'inep' && s.id === 'snap_inep_test_001'),
      'INEP snapshot must appear in full listing'
    );
    assert.equal(inepSnapshots.length, 1, 'INEP filter must return exactly 1 snapshot');
    assert.equal(inepSnapshots[0].sourceKind, 'inep');
    assert.equal(inepSnapshots[0].sha256, 'b'.repeat(64));

    store1.close();

    const store2 = createNexofisStore(dbPath);
    assert.equal(store2.getSchemaVersion(), 6, 'Reopened DB must still report v6');

    const inepAfterRestart = store2.listOfficialSnapshots('inep');
    assert.equal(
      inepAfterRestart.length,
      1,
      'INEP snapshot must survive process restart — was silently dropped before fix'
    );
    assert.equal(inepAfterRestart[0].id, 'snap_inep_test_001');
    assert.equal(inepAfterRestart[0].sourceKind, 'inep');
    assert.equal(inepAfterRestart[0].filename, 'inep-test.csv');

    const dup = store2.saveOfficialSnapshot({
      id: 'snap_inep_duplicate',
      sourceKind: 'inep',
      filename: 'inep-dup.csv',
      sha256: 'b'.repeat(64),
      competencia: '2026',
      uf: 'SP',
      metadataJson: '{}',
      payloadJson: '[]',
      importedBy: 'test-auditor-2',
    });
    assert.equal(dup.alreadyExisted, true, 'Same SHA-256 must return alreadyExisted=true');
    assert.equal(dup.id, 'snap_inep_test_001', 'Must return original ID on duplicate');

    store2.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('1.1b Invalid sourceKind throws explicit error (no silent drop)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexofis-inep-invalid-'));
  const dbPath = path.join(tmpDir, 'test.db');

  try {
    const store = createNexofisStore(dbPath);

    assert.throws(
      () =>
        store.saveOfficialSnapshot({
          id: 'snap_invalid',
          sourceKind: 'invalid_source' as 'inep',
          filename: 'invalid.csv',
          sha256: 'c'.repeat(64),
          competencia: '2026',
          uf: null,
          metadataJson: '{}',
          payloadJson: '[]',
          importedBy: 'test',
        }),
      /CHECK constraint failed|did not persist|Persistence verification failed/i,
      'Invalid sourceKind must throw CHECK constraint error, not silently succeed'
    );

    const all = store.listOfficialSnapshots();
    assert.equal(all.length, 0, 'No snapshot should exist after failed insert');

    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
