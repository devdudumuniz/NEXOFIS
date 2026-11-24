import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateContractConflictTrail } from '@nexofis/shared/lib/publicIntegrityTrails';
import type { ContractConflictInput } from '@nexofis/shared/lib/publicIntegrityTrails';
import {
  executeMultiHopCorporateNetworkQuery,
  type ForensicGraphSnapshot,
} from '@nexofis/shared/lib/forensicGraphCypher';

/**
 * Defeito 1.3a — Grafo: relacoes dismissed reaparecem como documented.
 * Correcao: composicao exaustiva trata 'dismissed' explicitamente.
 */
test('1.3a Dismissed shareholder edges do not produce documented multi-hop paths', () => {
  const snapshot: ForensicGraphSnapshot = {
    people: [
      { personId: 'person-x', nome: 'Pessoa X', cpfMascarado: '***123456**', identityResolved: true },
    ],
    companies: [
      { cnpj: '11111111000111', razaoSocial: 'Empresa A' },
      { cnpj: '22222222000122', razaoSocial: 'Empresa B' },
    ],
    agencies: [{ orgaoId: 'org-1', nome: 'Orgao Teste' }],
    offices: [],
    contracts: [
      { contratoId: 'c1', numero: '001/2026', objeto: 'Teste', valorTotal: 500000, ano: 2026, cnpjFornecedor: '22222222000122', orgaoId: 'org-1' },
    ],
    kinshipEdges: [],
    shareholderEdges: [
      { personId: 'person-x', cnpj: '11111111000111', qualificacao: 'socio', assertionState: 'dismissed', evidenceRef: 'ev-1' },
      { personId: 'person-x', cnpj: '22222222000122', qualificacao: 'socio', assertionState: 'dismissed', evidenceRef: 'ev-2' },
    ],
    officeHoldingEdges: [],
  };

  const results = executeMultiHopCorporateNetworkQuery(snapshot, '11111111000111', {
    onlyDocumented: true,
  });

  const documentedResults = results.filter((r) => r.assertionState === 'documented');
  assert.equal(documentedResults.length, 0, 'No path through dismissed edges should be labeled documented');
});

test('1.3a.2 Documented shareholder edges still produce multi-hop paths', () => {
  const snapshot: ForensicGraphSnapshot = {
    people: [
      { personId: 'person-y', nome: 'Pessoa Y', cpfMascarado: '***789012**', identityResolved: true },
    ],
    companies: [
      { cnpj: '33333333000133', razaoSocial: 'Empresa C' },
      { cnpj: '44444444000144', razaoSocial: 'Empresa D' },
    ],
    agencies: [{ orgaoId: 'org-2', nome: 'Orgao Teste 2' }],
    offices: [],
    contracts: [
      { contratoId: 'c2', numero: '002/2026', objeto: 'Teste', valorTotal: 300000, ano: 2026, cnpjFornecedor: '44444444000144', orgaoId: 'org-2' },
    ],
    kinshipEdges: [],
    shareholderEdges: [
      { personId: 'person-y', cnpj: '33333333000133', qualificacao: 'socio', assertionState: 'documented', evidenceRef: 'ev-3' },
      { personId: 'person-y', cnpj: '44444444000144', qualificacao: 'socio', assertionState: 'documented', evidenceRef: 'ev-4' },
    ],
    officeHoldingEdges: [],
  };

  const results = executeMultiHopCorporateNetworkQuery(snapshot, '33333333000133', {
    onlyDocumented: true,
  });

  assert.ok(results.length > 0, 'Documented shareholder edges must produce multi-hop results');
  assert.ok(
    results.every((r) => r.assertionState === 'documented'),
    'All results in onlyDocumented=true must be documented state'
  );
});

/**
 * Defeito 1.3b — Sociedade de person-A atribuida a person-B.
 * Correcao: exigir corporateLink.person.personId === appointment.person.personId.
 */
test('1.3b Contract conflict: distinct resolved identities produce SEM_SINAL', () => {
  const input: ContractConflictInput = {
    contractId: 'CONTRACT-001',
    contractSignatureDate: '2026-06-15',
    contractOrganKey: 'org-sms',
    contractJurisdiction: 'municipal',
    supplierCnpj: '27841920000163',
    corporateLink: {
      person: { personId: 'person-a', fullName: 'Joao da Silva', identityStatus: 'resolved_documentary', documentBasis: 'contrato-social-junta-2024' },
      role: 'socio-administrador',
      startDate: '2024-01-01',
      endDate: null,
      endSemantics: 'ongoing_undocumented',
      evidenceRefs: ['ev-qsa-001'],
    },
    appointment: {
      id: 'appt-001',
      person: { personId: 'person-b', fullName: 'Maria dos Santos', identityStatus: 'resolved_documentary', documentBasis: 'diario-oficial-municipal-2026' },
      actReference: 'Decreto no 123/2026',
      appointingAuthority: { personId: 'mayor-001', fullName: 'Prefeito Municipal', identityStatus: 'resolved_documentary' },
      roleTitle: 'Secretaria Municipal de Saude',
      bondNature: 'comissionado',
      lotacao: 'Secretaria Municipal de Saude',
      organKey: 'org-sms',
      jurisdiction: 'municipal',
      startDate: '2026-01-01',
      endDate: null,
      endSemantics: 'ongoing_undocumented',
      sourceLabel: 'Diario Oficial Municipal',
      evidenceRefs: ['ev-dom-001'],
    },
    pertinentToContract: true,
  };

  const result = evaluateContractConflictTrail([input]);

  const overlapFindings = result.findings.filter((f) => f.code === 'CONFLICT_OVERLAP_REQUIRES_REVIEW');
  assert.equal(overlapFindings.length, 0, 'Must not claim overlap when personIds differ');

  const distinctFindings = result.findings.filter((f) => f.code === 'CONFLICT_DISTINCT_IDENTITIES');
  assert.equal(distinctFindings.length, 1);
  assert.equal(distinctFindings[0].status, 'SEM_SINAL');

  const detail = distinctFindings[0].detail;
  assert.ok(!detail.includes('Maria dos Santos figura em vinculo societario'), 'Detail must not attribute person-A corporate link to person-B');
  assert.ok(detail.includes('identidades documentalmente distintas'), 'Detail must explain identities are distinct');
  assert.equal(result.requiresLegalReview, false);
});

test('1.3b.2 Same identity with overlap still produces finding (no false negative)', () => {
  const input: ContractConflictInput = {
    contractId: 'CONTRACT-002',
    contractSignatureDate: '2026-06-15',
    contractOrganKey: 'org-sms',
    contractJurisdiction: 'municipal',
    supplierCnpj: '27841920000163',
    corporateLink: {
      person: { personId: 'person-c', fullName: 'Carlos Pereira', identityStatus: 'resolved_documentary' },
      role: 'socio',
      startDate: '2024-01-01',
      endDate: '2026-12-31',
      endSemantics: 'confirmed_end',
      evidenceRefs: ['ev-qsa-002'],
    },
    appointment: {
      id: 'appt-002',
      person: { personId: 'person-c', fullName: 'Carlos Pereira', identityStatus: 'resolved_documentary' },
      actReference: 'Decreto no 124/2026',
      appointingAuthority: { personId: 'mayor-001', fullName: 'Prefeito Municipal', identityStatus: 'resolved_documentary' },
      roleTitle: 'Secretario Municipal de Saude',
      bondNature: 'comissionado',
      lotacao: 'Secretaria Municipal de Saude',
      organKey: 'org-sms',
      jurisdiction: 'municipal',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      endSemantics: 'confirmed_end',
      sourceLabel: 'Diario Oficial Municipal',
      evidenceRefs: ['ev-dom-002'],
    },
    pertinentToContract: true,
  };

  const result = evaluateContractConflictTrail([input]);
  const overlapFindings = result.findings.filter((f) => f.code === 'CONFLICT_OVERLAP_REQUIRES_REVIEW');
  assert.equal(overlapFindings.length, 1, 'Same identity + overlap must produce finding');
  assert.equal(result.requiresLegalReview, true);
  assert.ok(overlapFindings[0].detail.includes('Carlos Pereira figura em vinculo societario'), 'Detail must attribute corporate link to correct person');
});
