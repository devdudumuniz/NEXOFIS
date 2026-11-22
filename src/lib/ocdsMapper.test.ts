import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_COMPLIANT, FIXTURE_HIGH_RISK } from './__fixtures__/testContracts';
import { evaluateContractRisk } from './riskEngine';
import { buildAuditDossierMarkdown, mapContractToOCDS } from './ocdsMapper';

test('OCDS 1.1 release maps contracts[0].implementation with payment-only transactions', () => {
  const evaluated = { ...FIXTURE_HIGH_RISK, assessment: evaluateContractRisk(FIXTURE_HIGH_RISK) };
  const release = mapContractToOCDS(evaluated);

  assert.equal(release.ocid, 'ocds-br-pncp-2910800-syn-2026-123');
  assert.deepEqual(release.tag, ['tender', 'award', 'contract', 'implementation']);
  assert.equal(release.planning, undefined);
  assert.equal(release.tender.numberOfTenderers, 1);
  assert.equal(release.contracts[0].value?.amount, 5480000);
  assert.equal(release.contracts[0].amendments.length, 3);
  const expectedPaidCount = FIXTURE_HIGH_RISK.payments.filter((p) => p.type === 'Pagamento').length;
  assert.equal(release.contracts[0].implementation.transactions.length, expectedPaidCount);
});

test('OCDS release omits fabricated monetary fields when originalValue is 0', () => {
  const zeroVal = { ...FIXTURE_COMPLIANT, originalValue: 0, updatedValue: 0, payments: [] };
  const evaluated = { ...zeroVal, assessment: evaluateContractRisk(zeroVal) };
  const release = mapContractToOCDS(evaluated);

  assert.equal(release.planning, undefined);
  assert.equal(release.tender.value, undefined);
  assert.equal(release.contracts[0].value, undefined);
  assert.equal(release.contracts[0].implementation.transactions.length, 0);
});

test('Markdown audit dossier contains reproducible evidence, hashes, license separation, and methodological disclaimer', () => {
  const evaluated = { ...FIXTURE_HIGH_RISK, assessment: evaluateContractRisk(FIXTURE_HIGH_RISK) };
  const md = buildAuditDossierMarkdown(evaluated, 'Encaminhar para diligência na SMS.');

  assert.ok(md.includes('RISCO '));
  assert.ok(md.includes('IBGE `2910800`'));
  assert.ok(md.includes('BR-SANC-001'));
  assert.ok(md.includes('BR-L14133-DEC12807-2026'));
  assert.ok(md.includes('estimated_monthly_contract_value'));
  assert.ok(md.includes('SHA-256'));
  assert.ok(md.includes('AGPL-3.0-only'));
  assert.ok(md.includes('Encaminhar para diligência na SMS.'));
  assert.ok(md.includes('Não constituem declaração automática de fraude'));
});
