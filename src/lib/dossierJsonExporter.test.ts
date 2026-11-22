import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_HIGH_RISK } from './__fixtures__/testContracts';
import { evaluateContractRisk } from './riskEngine';
import {
  buildDossierJsonFilename,
  buildStructuredDossierJson,
  verifyDossierExportIntegrity,
} from './dossierJsonExporter';
import { getNextTheme, resolveInitialTheme, THEME_STORAGE_KEY } from './theme';
import type { EvaluatedContract, FindingReviewRecord } from '../types/audit';

test('buildStructuredDossierJson includes complete contract data, evidences, indicators, reviews, OCDS and valid SHA-256', () => {
  const base = FIXTURE_HIGH_RISK;
  const assessment = evaluateContractRisk(base);
  const evaluated: EvaluatedContract = { ...base, assessment, reviews: [] };

  const firstIndicator = assessment.indicators[0];
  assert.ok(firstIndicator, 'Expected at least one indicator on high-risk synthetic fixture');

  const reviews: FindingReviewRecord[] = [
    {
      id: 'REV-TEST-1',
      contractId: base.id,
      findingId: firstIndicator.findingId,
      ruleVersion: firstIndicator.ruleVersion,
      action: 'dismiss',
      rationale: 'Justificativa técnica documentada no processo administrativo 2026/001.',
      author: 'auditor@controladoria.gov.br',
      actorRole: 'analyst',
      createdAt: '2026-11-22T12:00:00.000Z',
    },
  ];

  const pkg = buildStructuredDossierJson(evaluated, {
    analystNote: 'Encaminhado para arquivamento externo.',
    reviews,
    exportedAt: '2026-11-22T12:05:00.000Z',
  });

  assert.equal(pkg.schema, 'nexofis.audit-dossier.v1');
  assert.equal(pkg.softwareLicense, 'AGPL-3.0-only');
  assert.equal(pkg.integrity.algorithm, 'SHA-256');
  assert.match(pkg.integrity.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(verifyDossierExportIntegrity(pkg), true);

  // Preserves all data & evidences
  assert.equal(pkg.payload.contract.id, base.id);
  assert.equal(pkg.payload.contract.documents.length, base.documents.length);
  assert.equal(pkg.payload.contract.sourceRecords.length, base.sourceRecords.length);
  assert.equal(pkg.payload.forensicAssessment.evidences.length, assessment.evidences.length);
  assert.equal(pkg.payload.forensicAssessment.indicators.length, assessment.indicators.length);
  assert.equal(pkg.payload.auditorReviews.length, 1);
  assert.equal(pkg.payload.archiveMetadata.analystNote, 'Encaminhado para arquivamento externo.');
  assert.equal(pkg.payload.archiveMetadata.dismissedFindingCount, 1);
  assert.ok(pkg.payload.archiveMetadata.effectiveRiskScore < assessment.score);
  assert.ok(pkg.payload.ocdsRelease.ocid);

  // Tamper detection: modifying any evidence breaks SHA-256 verification
  const tampered = structuredClone(pkg);
  tampered.payload.archiveMetadata.analystNote = 'Nota adulterada';
  assert.equal(verifyDossierExportIntegrity(tampered), false);
});

test('buildDossierJsonFilename produces safe archive filenames', () => {
  const filename = buildDossierJsonFilename({
    id: 'CTR-1',
    municipalityIbge: '2902906',
    contractNumber: '053/2025 FMS',
  });
  assert.equal(filename, 'dossie-nexofis-2902906-053-2025-FMS.json');
});

test('theme helpers resolve stored preference before system preference and toggle cleanly', () => {
  assert.equal(THEME_STORAGE_KEY, 'nexofis:theme');
  assert.equal(resolveInitialTheme('dark', false), 'dark');
  assert.equal(resolveInitialTheme('light', true), 'light');
  assert.equal(resolveInitialTheme(null, true), 'dark');
  assert.equal(resolveInitialTheme(null, false), 'light');
  assert.equal(getNextTheme('light'), 'dark');
  assert.equal(getNextTheme('dark'), 'light');
});
