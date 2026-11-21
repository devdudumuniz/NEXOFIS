import test from 'node:test';
import assert from 'node:assert/strict';
import { SEED_CONTRACTS } from '../data/brazilianSeedData';
import { evaluateContractRisk } from './riskEngine';
import { buildAuditDossierMarkdown, mapContractToOCDS } from './ocdsMapper';

test('OCDS release maps all five procurement stages faithfully', () => {
  const raw = SEED_CONTRACTS.find((c) => c.id === 'FSA-2026-123')!;
  const evaluated = { ...raw, assessment: evaluateContractRisk(raw) };
  const release = mapContractToOCDS(evaluated);

  assert.equal(release.ocid, 'ocds-br-pncp-2910800-fsa-2026-123');
  assert.deepEqual(release.tag, ['planning', 'tender', 'award', 'contract', 'implementation']);
  assert.equal(release.tender.numberOfTenderers, 1);
  assert.equal(release.contracts[0].value.amount, 5480000);
  assert.equal(release.contracts[0].amendments.length, 3);
  assert.equal(release.implementation.transactions.length, 6);
});

test('Markdown audit dossier contains reproducible evidence, hashes, and methodological disclaimer', () => {
  const raw = SEED_CONTRACTS.find((c) => c.id === 'FSA-2026-123')!;
  const evaluated = { ...raw, assessment: evaluateContractRisk(raw) };
  const md = buildAuditDossierMarkdown(evaluated, 'Encaminhar para diligência na SMS.');

  assert.ok(md.includes('RISCO 82/100 — revisão humana recomendada'));
  assert.ok(md.includes('IBGE `2910800`'));
  assert.ok(md.includes('BR-SANC-001'));
  assert.ok(md.includes('BR-L14133-DEC12807-2026'));
  assert.ok(md.includes('estimated_monthly_contract_value'));
  assert.ok(md.includes('SHA-256'));
  assert.ok(md.includes('Encaminhar para diligência na SMS.'));
  assert.ok(md.includes('Não constituem declaração automática de fraude'));
});
