import test from 'node:test';
import assert from 'node:assert/strict';
import { SEED_CONTRACTS } from '../data/brazilianSeedData';
import { evaluateContractRisk } from './riskEngine';
import { buildAuditDossierMarkdown, mapContractToOCDS } from './ocdsMapper';

test('OCDS 1.1 release maps contracts[0].implementation with payment-only transactions', () => {
  const raw = SEED_CONTRACTS.find((c) => c.id === 'FSA-2026-123')!;
  const evaluated = { ...raw, assessment: evaluateContractRisk(raw) };
  const release = mapContractToOCDS(evaluated);

  assert.equal(release.ocid, 'ocds-br-pncp-2910800-fsa-2026-123');
  assert.deepEqual(release.tag, ['tender', 'award', 'contract', 'implementation']);
  assert.equal(release.planning, undefined);
  assert.equal(release.tender.numberOfTenderers, 1);
  assert.equal(release.contracts[0].value?.amount, 5480000);
  assert.equal(release.contracts[0].amendments.length, 3);
  // Only actual Pagamento records (never Empenho/Liquidação/Medição) enter OCDS transactions
  const expectedPaidCount = raw.payments.filter((p) => p.type === 'Pagamento').length;
  assert.equal(release.contracts[0].implementation.transactions.length, expectedPaidCount);
});

test('OCDS release omits fabricated monetary fields when originalValue is 0', () => {
  const raw = SEED_CONTRACTS.find((c) => c.id === 'FSA-2026-041')!;
  const zeroVal = { ...raw, originalValue: 0, updatedValue: 0, payments: [] };
  const evaluated = { ...zeroVal, assessment: evaluateContractRisk(zeroVal) };
  const release = mapContractToOCDS(evaluated);

  assert.equal(release.planning, undefined);
  assert.equal(release.tender.value, undefined);
  assert.equal(release.contracts[0].value, undefined);
  assert.equal(release.contracts[0].implementation.transactions.length, 0);
});

test('Markdown audit dossier contains reproducible evidence, hashes, license separation, and methodological disclaimer', () => {
  const raw = SEED_CONTRACTS.find((c) => c.id === 'FSA-2026-123')!;
  const evaluated = { ...raw, assessment: evaluateContractRisk(raw) };
  const md = buildAuditDossierMarkdown(evaluated, 'Encaminhar para diligência na SMS.');

  assert.ok(md.includes('RISCO 82/100 — revisão humana recomendada'));
  assert.ok(md.includes('IBGE `2910800`'));
  assert.ok(md.includes('BR-SANC-001'));
  assert.ok(md.includes('BR-L14133-DEC12807-2026'));
  assert.ok(md.includes('estimated_monthly_contract_value'));
  assert.ok(md.includes('SHA-256'));
  assert.ok(md.includes('AGPL-3.0-only'));
  assert.ok(md.includes('Encaminhar para diligência na SMS.'));
  assert.ok(md.includes('Não constituem declaração automática de fraude'));
});

