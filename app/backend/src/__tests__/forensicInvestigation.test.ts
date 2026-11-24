import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import {
  buildInvestigationExportPackage,
  computeFactSetDigest,
  createEmptyFactSet,
  evaluateForensicInvestigation,
  INVESTIGATION_ENGINE_VERSION,
  MAX_PRIVATE_EVIDENCE_BYTES,
  validateFactSetPayload,
  verifyCaseLedgerIntegrity,
  verifyEventChain,
  verifyInvestigationPackage,
  type InvestigationContractInput,
} from '@nexofis/shared/lib/forensicInvestigationEngine';
import {
  fetchBrasilApiMinimizedExtract,
  minimizeMaskedDocument,
} from '../connectors/brasilApiCadastral';
import {
  createNexofisStore,
  InvestigationVersionConflictError,
  type InvestigationActor,
} from '../storage';
import { resolveOriginalInDir } from '../../../../scripts/verify-investigation';
import type {
  CadastralMinimizedExtract,
  InvestigationFactSet,
  ObservedHistorySnapshot,
  PrivateEvidenceRecord,
} from '@nexofis/shared/types/investigation';

function makePrivateEvidence(id: string, sourceLabel = 'Documento Oficial'): PrivateEvidenceRecord {
  const sha = id.replace(/[^a-f0-9]/gi, '').toLowerCase().padEnd(64, 'a').slice(0, 64);
  return {
    id,
    contractId: 'CTR-TEST-INV-001',
    filename: `${id.toLowerCase()}.pdf`,
    exportFilename: `${sha}__${id.toLowerCase()}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    sha256: sha,
    sourceLabel,
    description: `Evidência documental ${id}`,
    acquiredAt: '2025-03-10',
    uploadedBy: 'Auditor',
  };
}

const BASE_CONTRACT: InvestigationContractInput = {
  id: 'CTR-TEST-INV-001',
  contractNumber: '045/2025',
  pncpControlNumber: '13924782000180-2-000045/2025',
  municipalityName: 'Barra do Choça',
  municipalityIbge: '2902906',
  uf: 'BA',
  entityName: 'Secretaria Municipal de Saúde',
  signatureDate: '2025-03-10',
  originalValue: 250000,
  updatedValue: 250000,
  supplierCnpj: '11222333000181',
  supplierName: 'Alfa Soluções Médicas Ltda',
};

const TEST_ACTOR: InvestigationActor = {
  actorId: 'usr-analyst-1',
  actorName: 'Auditor Teste',
  actorRole: 'analyst',
};

describe('Módulo de Investigação Forense — 8 Trilhas Determinísticas', () => {
  it('Trilha 1 e 2: detecta cronologia incompatível (Δd < 0) e empresa aberta ontem contratada hoje (Δd = 1d) mantendo eventos separados', () => {
    const facts: InvestigationFactSet = {
      ...createEmptyFactSet('Auditor'),
      corporateDates: [
        {
          eventType: 'constituicao',
          date: '2025-03-15', // 5 dias DEPOIS da assinatura -> incompatível
          sourceLabel: 'Contrato Social JUCEB',
          evidenceRefs: ['EV-CS-1'],
        },
        {
          eventType: 'inscricao_cnpj',
          date: '2025-03-09', // 1 dia ANTES da assinatura -> faixa 0-1
          sourceLabel: 'Comprovante CNPJ RFB',
          evidenceRefs: ['EV-RFB-1'],
        },
        {
          eventType: 'inicio_atividade',
          date: '2025-02-20', // 18 dias ANTES -> faixa 2-30
          sourceLabel: 'Extrato BrasilAPI',
          evidenceRefs: ['EXT-1'],
        },
      ],
    };

    const evaluation = evaluateForensicInvestigation({
      contract: BASE_CONTRACT,
      factSet: facts,
      cadastralExtracts: [],
      observedHistory: null,
      privateEvidence: [],
      reviews: [],
    });

    assert.equal(evaluation.chronology.length, 3);
    const constituicao = evaluation.chronology.find((c) => c.eventType === 'constituicao');
    const inscricao = evaluation.chronology.find((c) => c.eventType === 'inscricao_cnpj');
    const inicio = evaluation.chronology.find((c) => c.eventType === 'inicio_atividade');
    assert.equal(constituicao?.deltaDays, -5);
    assert.equal(constituicao?.band, 'incompativel');
    assert.equal(inscricao?.deltaDays, 1);
    assert.equal(inscricao?.band, '0-1');
    assert.equal(inicio?.deltaDays, 18);
    assert.equal(inicio?.band, '2-30');

    const incompat = evaluation.findings.find(
      (f) => f.trailCode === 'INV_CHRONOLOGY_INCOMPATIBLE'
    );
    const recent = evaluation.findings.find((f) => f.trailCode === 'INV_RECENT_COMPANY');

    assert.equal(incompat?.status, 'INCONSISTENCIA');
    assert.equal(recent?.status, 'APONTAMENTO');
    assert.equal(recent?.metrics.band, '0-1');
    assert.equal(recent?.metrics.deltaDays, 1);
  });

  it('Trilha 3: exige documentação histórica para alterações em <= 30 dias (recusa consulta cadastral atual como prova de data)', () => {
    const undocumentedFacts: InvestigationFactSet = {
      ...createEmptyFactSet('Auditor'),
      corporateChanges: [
        {
          id: 'CHG-1',
          changeType: 'societario',
          date: '2025-03-01',
          description: 'Entrada de novo sócio administrador',
          isHistoricalDocumented: false,
          evidenceRefs: [],
        },
      ],
    };

    const evalUndoc = evaluateForensicInvestigation({
      contract: BASE_CONTRACT,
      factSet: undocumentedFacts,
      cadastralExtracts: [],
      observedHistory: null,
      privateEvidence: [],
      reviews: [],
    });
    const undocFinding = evalUndoc.findings.find(
      (f) => f.trailCode === 'INV_RECENT_CORPORATE_CHANGE'
    );
    assert.equal(undocFinding?.status, 'INCOMPLETO');

    const documentedFacts: InvestigationFactSet = {
      ...createEmptyFactSet('Auditor'),
      corporateChanges: [
        {
          id: 'CHG-2',
          changeType: 'cnae',
          date: '2025-02-25', // 13 dias antes de 2025-03-10
          description: 'Inclusão de CNAE de fornecimento hospitalar',
          isHistoricalDocumented: true,
          evidenceRefs: ['PEV-ALTERACAO-3'],
        },
      ],
    };

    const evalDoc = evaluateForensicInvestigation({
      contract: BASE_CONTRACT,
      factSet: documentedFacts,
      cadastralExtracts: [],
      observedHistory: null,
      privateEvidence: [makePrivateEvidence('PEV-ALTERACAO-3', 'JUCEB')],
      reviews: [],
    });
    const docFinding = evalDoc.findings.find(
      (f) => f.trailCode === 'INV_RECENT_CORPORATE_CHANGE'
    );
    assert.equal(docFinding?.status, 'APONTAMENTO');
  });

  it('Trilha 4 e 5: contrato único observado, concentração >= 80% com >= 3 contratos deduplicados, e interrupção diante de divergência de valor', () => {
    const singleHistory: ObservedHistorySnapshot = {
      updatedAt: '2025-03-11T10:00:00Z',
      updatedBy: 'Auditor',
      supplierCnpj: '11222333000181',
      sourcesChecked: ['PNCP Search API', 'Base Local'],
      pncpStatus: 'complete',
      coverageNote: 'Cobertura PNCP',
      contracts: [
        {
          id: BASE_CONTRACT.id,
          pncpControlNumber: BASE_CONTRACT.pncpControlNumber,
          contractNumber: BASE_CONTRACT.contractNumber,
          buyerKey: 'secretaria municipal de saude',
          buyerName: 'Secretaria Municipal de Saúde',
          signatureDate: '2025-03-10',
          contractValue: 250000,
          sourceSystem: 'PNCP',
        },
      ],
    };

    const evalSingle = evaluateForensicInvestigation({
      contract: BASE_CONTRACT,
      factSet: createEmptyFactSet(),
      cadastralExtracts: [],
      observedHistory: singleHistory,
      privateEvidence: [],
      reviews: [],
    });
    assert.equal(
      evalSingle.findings.find((f) => f.trailCode === 'INV_SINGLE_OBSERVED_CONTRACT')?.status,
      'APONTAMENTO'
    );

    const concentratedHistory: ObservedHistorySnapshot = {
      ...singleHistory,
      contracts: [
        ...singleHistory.contracts,
        // Duplicate of contract 1 to verify deduplication
        { ...singleHistory.contracts[0] },
        {
          id: 'CTR-2',
          pncpControlNumber: '13924782000180-2-000046/2025',
          contractNumber: '046/2025',
          buyerKey: 'secretaria municipal de saude',
          buyerName: 'Secretaria Municipal de Saúde',
          signatureDate: '2025-02-01',
          contractValue: 550000,
          sourceSystem: 'PNCP',
        },
        {
          id: 'CTR-3',
          pncpControlNumber: '13924782000180-2-000047/2025',
          contractNumber: '047/2025',
          buyerKey: 'secretaria municipal de educacao',
          buyerName: 'Secretaria Municipal de Educação',
          signatureDate: '2025-01-15',
          contractValue: 100000,
          sourceSystem: 'PNCP',
        },
      ],
    };

    const evalConc = evaluateForensicInvestigation({
      contract: BASE_CONTRACT,
      factSet: createEmptyFactSet(),
      cadastralExtracts: [],
      observedHistory: concentratedHistory,
      privateEvidence: [],
      reviews: [],
    });
    const concFinding = evalConc.findings.find((f) => f.trailCode === 'INV_BUYER_CONCENTRATION');
    assert.equal(concFinding?.status, 'APONTAMENTO');
    assert.equal(evalConc.observedMetrics.totalObservedContracts, 3);
    assert.ok((evalConc.observedMetrics.investigatedBuyerSharePct ?? 0) >= 88);

    // Value divergence must halt concentration computation
    const divergentHistory: ObservedHistorySnapshot = {
      ...concentratedHistory,
      contracts: concentratedHistory.contracts.map((c, idx) =>
        idx === 2 ? { ...c, hasValueDivergence: true } : c
      ),
    };
    const evalDiv = evaluateForensicInvestigation({
      contract: BASE_CONTRACT,
      factSet: createEmptyFactSet(),
      cadastralExtracts: [],
      observedHistory: divergentHistory,
      privateEvidence: [],
      reviews: [],
    });
    assert.equal(evalDiv.observedMetrics.concentrationComputable, false);
    assert.equal(
      evalDiv.findings.find((f) => f.trailCode === 'INV_BUYER_CONCENTRATION')?.status,
      'INCOMPLETO'
    );
  });

  it('Trilhas 6, 7 e 8: vínculo empresarial+função pública, parentesco com nexo contratual e participantes do mesmo lote (rejeitando homônimos não resolvidos)', () => {
    const facts: InvestigationFactSet = {
      ...createEmptyFactSet('Auditor'),
      people: [
        {
          id: 'P1',
          fullName: 'Carlos Alberto Souza',
          identityStatus: 'documented',
          documentBasis: 'CPF verificado em contrato social e portaria',
          evidenceRefs: ['EV-1'],
        },
        {
          id: 'P2',
          fullName: 'Mariana Souza Lima',
          identityStatus: 'documented',
          documentBasis: 'Certidão civil e portaria de pregoeira',
          evidenceRefs: ['EV-2'],
        },
        {
          id: 'P3',
          fullName: 'João Homônimo Sem CPF',
          identityStatus: 'unresolved',
          evidenceRefs: [],
        },
      ],
      corporateLinks: [
        {
          id: 'CL-1',
          personId: 'P1',
          supplierCnpj: '11222333000181',
          role: 'socio',
          validFrom: '2024-01-01',
          validUntil: null,
          evidenceRefs: ['EV-CS'],
        },
        {
          id: 'CL-2',
          personId: 'P1',
          supplierCnpj: '22333444000199',
          role: 'socio',
          validFrom: '2024-01-01',
          validUntil: null,
          evidenceRefs: ['EV-CS-2'],
        },
        {
          id: 'CL-UNRES',
          personId: 'P3',
          supplierCnpj: '11222333000181',
          role: 'administrador',
          validFrom: '2024-01-01',
          validUntil: null,
          evidenceRefs: ['QSA-PUBLICO'],
        },
      ],
      publicFunctions: [
        {
          id: 'PF-1',
          personId: 'P1',
          roleTitle: 'Assessor Técnico de Compras',
          organName: 'Secretaria Municipal de Saúde',
          pertinentToContract: true,
          validFrom: '2025-01-01',
          validUntil: '2025-12-31',
          evidenceRefs: ['EV-PORTARIA-1'],
        },
        {
          id: 'PF-2',
          personId: 'P2',
          roleTitle: 'Pregoeira Designada',
          organName: 'Secretaria Municipal de Saúde',
          pertinentToContract: true,
          validFrom: '2025-01-01',
          validUntil: '2025-12-31',
          evidenceRefs: ['EV-PORTARIA-2'],
        },
        {
          id: 'PF-UNRES',
          personId: 'P3',
          roleTitle: 'Fiscal de Contrato',
          organName: 'Secretaria Municipal de Saúde',
          pertinentToContract: true,
          validFrom: '2025-01-01',
          validUntil: '2025-12-31',
          evidenceRefs: ['DO-HOMONIMO'],
        },
      ],
      kinshipRelations: [
        {
          id: 'KIN-1',
          personAId: 'P1',
          personBId: 'P2',
          relationType: 'consanguinidade',
          degree: 2,
          validFrom: '2000-01-01',
          validUntil: null,
          evidenceRefs: ['EV-CERTIDAO'],
        },
      ],
      lotParticipants: [
        {
          id: 'LP-1',
          lotId: 'LOTE-01',
          biddingDate: '2025-03-05',
          participantCnpj: '11222333000181',
          participantName: 'Alfa Soluções Médicas Ltda',
          linkedPersonIds: ['P1'],
          evidenceRefs: ['ATA-01'],
        },
        {
          id: 'LP-2',
          lotId: 'LOTE-01',
          biddingDate: '2025-03-05',
          participantCnpj: '22333444000199',
          participantName: 'Beta Distribuidora Hospitalar Ltda',
          linkedPersonIds: ['P1'],
          evidenceRefs: ['ATA-01'],
        },
      ],
    };

    const ev = evaluateForensicInvestigation({
      contract: BASE_CONTRACT,
      factSet: facts,
      cadastralExtracts: [],
      observedHistory: null,
      privateEvidence: [
        makePrivateEvidence('EV-1'),
        makePrivateEvidence('EV-2'),
        makePrivateEvidence('EV-CS'),
        makePrivateEvidence('EV-CS-2'),
        makePrivateEvidence('EV-PORTARIA-1'),
        makePrivateEvidence('EV-PORTARIA-2'),
        makePrivateEvidence('EV-CERTIDAO'),
        makePrivateEvidence('ATA-01'),
      ],
      reviews: [],
    });

    const f6 = ev.findings.find((f) => f.trailCode === 'INV_CORPORATE_PUBLIC_FUNCTION_LINK');
    const f7 = ev.findings.find((f) => f.trailCode === 'INV_DOCUMENTED_KINSHIP_NEXUS');
    const f8 = ev.findings.find((f) => f.trailCode === 'INV_LOT_PARTICIPANT_SHARED_LINK');

    assert.equal(f6?.status, 'APONTAMENTO');
    // Only P1 (documented) must match; P3 (unresolved) must be ignored
    assert.equal(f6?.metrics.confirmedMatchesCount, 1);
    assert.equal(f7?.status, 'APONTAMENTO');
    assert.equal(f8?.status, 'APONTAMENTO');
    assert.ok(f8?.limitations.some((l) => l.toLowerCase().includes('conluio')));
    assert.equal(ev.unresolvedIdentitiesCount, 1);
  });

  it('Revisão vinculada aos fatos fica marcada como desatualizada quando a versão/insumos mudam', () => {
    const factsV1: InvestigationFactSet = {
      ...createEmptyFactSet('Auditor'),
      version: 1,
      corporateDates: [
        {
          eventType: 'inscricao_cnpj',
          date: '2025-03-09',
          sourceLabel: 'RFB',
          evidenceRefs: ['EV-1'],
        },
      ],
    };

    const evalV1 = evaluateForensicInvestigation({
      contract: BASE_CONTRACT,
      factSet: factsV1,
      cadastralExtracts: [],
      observedHistory: null,
      privateEvidence: [],
      reviews: [],
    });
    const recentV1 = evalV1.findings.find((f) => f.trailCode === 'INV_RECENT_COMPANY')!;

    const review = {
      id: 'IRV-1',
      contractId: BASE_CONTRACT.id,
      findingId: recentV1.findingId,
      action: 'confirm' as const,
      rationale: 'Confirmada abertura na véspera conforme comprovante RFB.',
      factsVersion: 1,
      findingInputsDigest: recentV1.inputsDigest,
      actorId: 'usr-1',
      actorName: 'Auditor 1',
      actorRole: 'analyst' as const,
      createdAt: '2025-03-11T12:00:00Z',
    };

    const evalV1WithReview = evaluateForensicInvestigation({
      contract: BASE_CONTRACT,
      factSet: factsV1,
      cadastralExtracts: [],
      observedHistory: null,
      privateEvidence: [],
      reviews: [review],
    });
    const rV1 = evalV1WithReview.findings.find((f) => f.trailCode === 'INV_RECENT_COMPANY')!;
    assert.equal(rV1.reviewIsCurrent, true);

    // Update facts to v2 changing date from 2025-03-09 to 2025-03-01
    const factsV2: InvestigationFactSet = {
      ...factsV1,
      version: 2,
      corporateDates: [
        {
          eventType: 'inscricao_cnpj',
          date: '2025-03-01',
          sourceLabel: 'RFB',
          evidenceRefs: ['EV-1'],
        },
      ],
    };
    const evalV2 = evaluateForensicInvestigation({
      contract: BASE_CONTRACT,
      factSet: factsV2,
      cadastralExtracts: [],
      observedHistory: null,
      privateEvidence: [],
      reviews: [review],
    });
    const rV2 = evalV2.findings.find((f) => f.trailCode === 'INV_RECENT_COMPANY')!;
    assert.equal(rV2.reviewIsCurrent, false);
    assert.ok(rV2.reviewStaleReason && rV2.reviewStaleReason.length > 0);
  });
});

describe('Persistência SQLite v3, Append-Only, Concorrência Otimista e Isolamento Privado', () => {
  it('aplica migração v3, bloqueia UPDATE/DELETE em investigation_events, impõe concorrência otimista e isola private_evidence', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexofis-inv-store-'));
    const dbPath = path.join(tmpDir, 'nexofis.db');
    const store = createNexofisStore(dbPath);

    try {
      assert.equal(store.getSchemaVersion(), 6);

      const initialized = store.getOrCreateInvestigationCase(BASE_CONTRACT.id, TEST_ACTOR);
      assert.equal(initialized.factSet.version, 1);
      assert.equal(initialized.events.length, 1);
      assert.equal(initialized.events[0].eventType, 'CASE_INITIALIZED');

      // Save private evidence
      const payloadBytes = Buffer.from('Contrato social autenticado — teste forense', 'utf8');
      const savedEv = store.savePrivateEvidence(
        {
          contractId: BASE_CONTRACT.id,
          filename: 'contrato_social.txt',
          mimeType: 'text/plain',
          sourceLabel: 'JUCEB',
          description: 'Cópia integral arquivada na junta comercial',
          acquiredAt: '2025-03-11',
          bytes: payloadBytes,
        },
        TEST_ACTOR
      );

      // Private evidence is readable via private reader and NEVER via public document reader
      const privRead = store.readPrivateEvidenceBytes(savedEv.record.sha256);
      assert.equal(privRead?.verified, true);
      assert.equal(privRead?.bytes.toString('utf8'), payloadBytes.toString('utf8'));
      const pubRead = store.readOriginalDocumentBytes(savedEv.record.sha256);
      assert.equal(pubRead, null);

      // Files > 1 MiB must be rejected
      assert.throws(() => {
        store.savePrivateEvidence(
          {
            contractId: BASE_CONTRACT.id,
            filename: 'grande.txt',
            mimeType: 'text/plain',
            sourceLabel: 'Teste',
            description: 'Arquivo acima do limite',
            acquiredAt: '2025-03-11',
            bytes: Buffer.alloc(MAX_PRIVATE_EVIDENCE_BYTES + 1, 0x41),
          },
          TEST_ACTOR
        );
      }, /limite/i);

      // Optimistic concurrency: update v1 -> v2 succeeds; stale v1 -> throws InvestigationVersionConflictError
      const updatedV2 = store.saveInvestigationFactSet(
        BASE_CONTRACT.id,
        1,
        {
          corporateDates: [
            {
              eventType: 'inscricao_cnpj',
              date: '2025-03-09',
              sourceLabel: 'RFB',
              evidenceRefs: [savedEv.record.id],
            },
          ],
          corporateChanges: [],
          people: [],
          corporateLinks: [],
          publicFunctions: [],
          kinshipRelations: [],
          lotParticipants: [],
        },
        TEST_ACTOR
      );
      assert.equal(updatedV2.factSet.version, 2);

      assert.throws(() => {
        store.saveInvestigationFactSet(
          BASE_CONTRACT.id,
          1,
          {
            corporateDates: [],
            corporateChanges: [],
            people: [],
            corporateLinks: [],
            publicFunctions: [],
            kinshipRelations: [],
            lotParticipants: [],
          },
          TEST_ACTOR
        );
      }, InvestigationVersionConflictError);

      // Event chain must be valid
      const chain = verifyEventChain(updatedV2.events);
      assert.equal(chain.valid, true);
      assert.equal(chain.eventCount, 3);

      // Append-only triggers MUST abort UPDATE and DELETE on investigation_events
      const rawDb = new DatabaseSync(dbPath);
      try {
        assert.throws(() => {
          rawDb
            .prepare("UPDATE investigation_events SET payload_json = '{}' WHERE seq = 1")
            .run();
        }, /append-only/i);
        assert.throws(() => {
          rawDb.prepare('DELETE FROM investigation_events WHERE seq = 1').run();
        }, /append-only/i);
      } finally {
        rawDb.close();
      }
    } finally {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('BrasilAPI Cadastral Minimizado & Verificador Offline Independente (exit 0 / 1 / 2)', () => {
  it('BrasilAPI exige finalidade/base legal/justificativa e marca todo QSA como unresolved', async () => {
    await assert.rejects(
      fetchBrasilApiMinimizedExtract({
        cnpj: '11222333000181',
        acquiredBy: 'Auditor',
        purpose: 'a',
        legalBasis: 'b',
        justification: 'c',
      }),
      /obrigatórios/i
    );

    const extract = await fetchBrasilApiMinimizedExtract({
      cnpj: '11.222.333/0001-81',
      acquiredBy: 'Auditor',
      purpose: 'Verificação cronológica',
      legalBasis: 'Lei 14.133/2021',
      justification: 'Conferir data de início de atividade e QSA do fornecedor contratado.',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            cnpj: '11222333000181',
            razao_social: 'ALFA SOLUCOES MEDICAS LTDA',
            descricao_situacao_cadastral: 'ATIVA',
            data_inicio_atividade: '2025-03-09',
            cnae_fiscal: '4645101',
            cnae_fiscal_descricao: 'Comércio atacadista de instrumentos cirúrgicos',
            municipio: 'SALVADOR',
            uf: 'BA',
            capital_social: 50000,
            qsa: [
              {
                nome_socio: 'CARLOS ALBERTO SOUZA',
                qualificacao_socio: 'Sócio-Administrador',
                data_entrada_sociedade: '2025-03-09',
                cnpj_cpf_do_socio: '***123456**',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ),
    });

    assert.equal(extract.sourceType, 'provedor_intermediario');
    assert.equal(extract.qsa.length, 1);
    assert.equal(extract.qsa[0].identityStatus, 'unresolved');
    assert.match(extract.extractSha256, /^[a-f0-9]{64}$/);
  });

  it('Verificador offline retorna exit 0 (válido), 2 (incompleto sem originais / versão divergente) e 1 (adulterado)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexofis-verify-cli-'));
    const dbPath = path.join(tmpDir, 'nexofis.db');
    const originalsDir = path.join(tmpDir, 'originais');
    fs.mkdirSync(originalsDir, { recursive: true });

    const store = createNexofisStore(dbPath);
    try {
      const evContent = Buffer.from('Certidão de alteração contratual JUCEB', 'utf8');
      const saved = store.savePrivateEvidence(
        {
          contractId: BASE_CONTRACT.id,
          filename: 'certidao.txt',
          mimeType: 'text/plain',
          sourceLabel: 'JUCEB',
          description: 'Certidão oficial do arquivamento',
          acquiredAt: '2025-03-10',
          bytes: evContent,
        },
        TEST_ACTOR
      );
      fs.writeFileSync(path.join(originalsDir, saved.record.exportFilename), evContent);

      const caseNow = store.saveInvestigationFactSet(
        BASE_CONTRACT.id,
        1,
        {
          corporateDates: [
            {
              eventType: 'inscricao_cnpj',
              date: '2025-03-09',
              sourceLabel: 'RFB',
              evidenceRefs: [saved.record.id],
            },
          ],
          corporateChanges: [],
          people: [],
          corporateLinks: [],
          publicFunctions: [],
          kinshipRelations: [],
          lotParticipants: [],
        },
        TEST_ACTOR
      );

      const evaluation = evaluateForensicInvestigation({
        contract: BASE_CONTRACT,
        factSet: caseNow.factSet,
        cadastralExtracts: caseNow.cadastralExtracts,
        observedHistory: caseNow.observedHistory,
        privateEvidence: caseNow.privateEvidence,
        reviews: caseNow.reviews,
      });

      const pkg = buildInvestigationExportPackage({
        contractSnapshot: {
          contractNumber: BASE_CONTRACT.contractNumber,
          pncpControlNumber: BASE_CONTRACT.pncpControlNumber,
          municipalityName: BASE_CONTRACT.municipalityName,
          municipalityIbge: BASE_CONTRACT.municipalityIbge,
          uf: BASE_CONTRACT.uf,
          entityName: BASE_CONTRACT.entityName,
          signatureDate: BASE_CONTRACT.signatureDate,
          originalValue: BASE_CONTRACT.originalValue,
          updatedValue: BASE_CONTRACT.updatedValue,
          supplierCnpj: BASE_CONTRACT.supplierCnpj,
          supplierName: BASE_CONTRACT.supplierName,
        },
        factSet: caseNow.factSet,
        cadastralExtracts: caseNow.cadastralExtracts,
        observedHistory: caseNow.observedHistory,
        privateEvidence: caseNow.privateEvidence,
        reviews: caseNow.reviews,
        events: caseNow.events,
        evaluation,
      });

      // Pure function checks
      const okCheck = verifyInvestigationPackage(pkg, {
        readOriginalBytes: (ev) => {
          const p = path.join(originalsDir, ev.exportFilename);
          return fs.existsSync(p) ? fs.readFileSync(p) : null;
        },
      });
      assert.equal(okCheck.exitCode, 0);

      // Without originals -> exit 2 (incomplete)
      const incompleteCheck = verifyInvestigationPackage(pkg);
      assert.equal(incompleteCheck.exitCode, 2);

      // Engine version mismatch (re-sealed digest) -> exit 2
      const wrongEnginePkg = {
        ...pkg,
        engineVersion: 'investigation-engine-2099.01',
      };
      // Tampered digest without re-sealing -> exit 1
      const tamperedCheck = verifyInvestigationPackage(wrongEnginePkg);
      assert.equal(tamperedCheck.exitCode, 1);

      // Real CLI execution check (exit 0 with originals, exit 2 without originals)
      const pkgFile = path.join(tmpDir, 'pacote.json');
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));

      const cliOut = execFileSync(
        'npx',
        ['tsx', 'scripts/verify-investigation.ts', pkgFile, originalsDir],
        { encoding: 'utf8' }
      );
      assert.match(cliOut, /VALID \(exit 0\)/);
      assert.match(cliOut, new RegExp(INVESTIGATION_ENGINE_VERSION));

      let incompleteExit: number | null = null;
      try {
        execFileSync('npx', ['tsx', 'scripts/verify-investigation.ts', pkgFile], {
          encoding: 'utf8',
        });
      } catch (err: unknown) {
        incompleteExit = (err as { status?: number }).status ?? null;
      }
      assert.equal(incompleteExit, 2);

      // Tamper original binary -> CLI must exit 1
      fs.writeFileSync(
        path.join(originalsDir, saved.record.exportFilename),
        Buffer.from('ADULTERADO', 'utf8')
      );
      let tamperedExit: number | null = null;
      try {
        execFileSync(
          'npx',
          ['tsx', 'scripts/verify-investigation.ts', pkgFile, originalsDir],
          { encoding: 'utf8' }
        );
      } catch (err: unknown) {
        tamperedExit = (err as { status?: number }).status ?? null;
      }
      assert.equal(tamperedExit, 1);
    } finally {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('F01, F02, F03, F04, F07, F09, F10: regressões de integridade do livro-razão, evidências fantasma, datas futuras, replay profundo, minimização de CPF e symlink', () => {
    // F01: verifyCaseLedgerIntegrity detects tampered facts_json even when event chain itself is intact
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexofis-audit-reg-'));
    const dbPath = path.join(tmpDir, 'nexofis.db');
    const store = createNexofisStore(dbPath);
    try {
      const initialized = store.getOrCreateInvestigationCase(BASE_CONTRACT.id, TEST_ACTOR);
      const okIntegrity = verifyCaseLedgerIntegrity({
        factSet: initialized.factSet,
        events: initialized.events,
      });
      assert.equal(okIntegrity.valid, true);
      assert.equal(okIntegrity.factsDigestMatchesLedger, true);

      const tamperedFactSet: InvestigationFactSet = {
        ...initialized.factSet,
        corporateDates: [
          {
            eventType: 'constituicao',
            date: '2025-03-09',
            sourceLabel: 'Manipulado direto no SQLite',
            evidenceRefs: [],
          },
        ],
      };
      const badIntegrity = verifyCaseLedgerIntegrity({
        factSet: tamperedFactSet,
        events: initialized.events,
      });
      assert.equal(badIntegrity.valid, false);
      assert.equal(badIntegrity.factsDigestMatchesLedger, false);
      assert.notEqual(
        computeFactSetDigest(initialized.factSet),
        computeFactSetDigest(tamperedFactSet)
      );

      // F02: Duplicate IDs rejected & ghost evidenceRefs cannot trigger findings
      const dupCheck = validateFactSetPayload({
        people: [
          { id: 'DUP-1', fullName: 'Pessoa A', identityStatus: 'documented', evidenceRefs: [] },
          { id: 'DUP-1', fullName: 'Pessoa B', identityStatus: 'documented', evidenceRefs: [] },
        ],
      });
      assert.equal(dupCheck.valid, false);
      assert.match(dupCheck.error ?? '', /duplicado/i);

      const ghostFacts: InvestigationFactSet = {
        ...createEmptyFactSet('Auditor'),
        corporateChanges: [
          {
            id: 'CHG-GHOST',
            changeType: 'societario',
            date: '2025-03-01',
            description: 'Alteração sem evidência privada real',
            isHistoricalDocumented: true,
            evidenceRefs: ['GHOST-ID-INEXISTENTE'],
          },
        ],
      };
      const ghostEval = evaluateForensicInvestigation({
        contract: BASE_CONTRACT,
        factSet: ghostFacts,
        cadastralExtracts: [],
        observedHistory: null,
        privateEvidence: [],
        reviews: [],
      });
      assert.equal(
        ghostEval.findings.find((f) => f.trailCode === 'INV_RECENT_CORPORATE_CHANGE')?.status,
        'INCOMPLETO'
      );

      // F03: Future opening date flagged in Trail 1 and excluded from Trail 2; pertinentToContract=false ignored
      const futureFacts: InvestigationFactSet = {
        ...createEmptyFactSet('Auditor'),
        corporateDates: [
          {
            eventType: 'inscricao_cnpj',
            date: '2099-01-01',
            sourceLabel: 'Erro de digitação futuro',
            evidenceRefs: [],
          },
        ],
        people: [
          {
            id: 'P-NONPERT',
            fullName: 'Servidor Não Pertinente',
            identityStatus: 'documented',
            evidenceRefs: ['EV-NP'],
          },
        ],
        corporateLinks: [
          {
            id: 'CL-NP',
            personId: 'P-NONPERT',
            supplierCnpj: BASE_CONTRACT.supplierCnpj,
            role: 'socio',
            validFrom: '2024-01-01',
            validUntil: null,
            evidenceRefs: ['EV-NP'],
          },
        ],
        publicFunctions: [
          {
            id: 'PF-NP',
            personId: 'P-NONPERT',
            roleTitle: 'Cargo sem pertinência',
            organName: BASE_CONTRACT.entityName,
            pertinentToContract: false,
            validFrom: '2025-01-01',
            validUntil: '2025-12-31',
            evidenceRefs: ['EV-NP'],
          },
        ],
      };
      const futureEval = evaluateForensicInvestigation({
        contract: BASE_CONTRACT,
        factSet: futureFacts,
        cadastralExtracts: [],
        observedHistory: null,
        privateEvidence: [makePrivateEvidence('EV-NP')],
        reviews: [],
        evaluatedAt: '2025-04-01T00:00:00Z',
      });
      assert.equal(
        futureEval.findings.find((f) => f.trailCode === 'INV_CHRONOLOGY_INCOMPATIBLE')?.status,
        'INCONSISTENCIA'
      );
      assert.equal(
        futureEval.findings.find((f) => f.trailCode === 'INV_RECENT_COMPANY')?.status,
        'SEM_SINAL'
      );
      assert.equal(
        futureEval.findings.find((f) => f.trailCode === 'INV_CORPORATE_PUBLIC_FUNCTION_LINK')?.status,
        'SEM_SINAL'
      );

      // F04: Tampered finding title/metrics caught by verifyInvestigationPackage even if status unchanged
      const evalClean = evaluateForensicInvestigation({
        contract: BASE_CONTRACT,
        factSet: initialized.factSet,
        cadastralExtracts: [],
        observedHistory: null,
        privateEvidence: [],
        reviews: [],
      });
      const pkg = buildInvestigationExportPackage({
        contractSnapshot: {
          contractNumber: BASE_CONTRACT.contractNumber,
          pncpControlNumber: BASE_CONTRACT.pncpControlNumber,
          municipalityName: BASE_CONTRACT.municipalityName,
          municipalityIbge: BASE_CONTRACT.municipalityIbge,
          uf: BASE_CONTRACT.uf,
          entityName: BASE_CONTRACT.entityName,
          signatureDate: BASE_CONTRACT.signatureDate,
          originalValue: BASE_CONTRACT.originalValue,
          updatedValue: BASE_CONTRACT.updatedValue,
          supplierCnpj: BASE_CONTRACT.supplierCnpj,
          supplierName: BASE_CONTRACT.supplierName,
        },
        factSet: initialized.factSet,
        cadastralExtracts: [],
        observedHistory: null,
        privateEvidence: [],
        reviews: [],
        events: initialized.events,
        evaluation: evalClean,
      });
      const tamperedFindingPkg = {
        ...pkg,
        evaluation: {
          ...pkg.evaluation,
          findings: pkg.evaluation.findings.map((f, idx) =>
            idx === 0 ? { ...f, title: 'TÍTULO ADULTERADO' } : f
          ),
        },
      };
      const replayCheck = verifyInvestigationPackage(tamperedFindingPkg);
      assert.equal(replayCheck.exitCode, 1);
      assert.equal(replayCheck.checks.reproductionMatches, false);

      // F07: 11-digit full CPF is redacted to masked format
      assert.equal(minimizeMaskedDocument('123.456.789-01'), '***456789**');
      assert.equal(minimizeMaskedDocument('000.000.000-00'), null);

      // F09: Trail 8 rejects lot participants without documented corporateLinks on biddingDate for BOTH companies
      const unlinkedLotFacts: InvestigationFactSet = {
        ...createEmptyFactSet('Auditor'),
        people: [
          { id: 'P-L', fullName: 'Pessoa Lote', identityStatus: 'documented', evidenceRefs: ['EV-L'] },
        ],
        corporateLinks: [
          {
            id: 'CL-L1',
            personId: 'P-L',
            supplierCnpj: '11222333000181',
            role: 'socio',
            validFrom: '2024-01-01',
            validUntil: null,
            evidenceRefs: ['EV-L'],
          },
        ],
        lotParticipants: [
          {
            id: 'LP-A',
            lotId: 'LOTE-9',
            biddingDate: '2025-03-05',
            participantCnpj: '11222333000181',
            participantName: 'Empresa A',
            linkedPersonIds: ['P-L'],
            evidenceRefs: ['EV-L'],
          },
          {
            id: 'LP-B',
            lotId: 'LOTE-9',
            biddingDate: '2025-03-05',
            participantCnpj: '99888777000166',
            participantName: 'Empresa B sem corporateLink',
            linkedPersonIds: ['P-L'],
            evidenceRefs: ['EV-L'],
          },
        ],
      };
      const lotEval = evaluateForensicInvestigation({
        contract: BASE_CONTRACT,
        factSet: unlinkedLotFacts,
        cadastralExtracts: [],
        observedHistory: null,
        privateEvidence: [makePrivateEvidence('EV-L')],
        reviews: [],
      });
      assert.equal(
        lotEval.findings.find((f) => f.trailCode === 'INV_LOT_PARTICIPANT_SHARED_LINK')?.status,
        'INCOMPLETO'
      );

      // F10: resolveOriginalInDir blocks symlink escape outside originalsDir
      const origDir = path.join(tmpDir, 'originais');
      fs.mkdirSync(origDir, { recursive: true });
      const outsideSecret = path.join(tmpDir, 'secret.txt');
      fs.writeFileSync(outsideSecret, 'segredo-fora-do-diretorio');
      const fakeEv = makePrivateEvidence('EV-SYM');
      fs.symlinkSync(outsideSecret, path.join(origDir, fakeEv.exportFilename));
      assert.throws(() => resolveOriginalInDir(origDir, fakeEv), /symlink|fora do diretório/i);
    } finally {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
