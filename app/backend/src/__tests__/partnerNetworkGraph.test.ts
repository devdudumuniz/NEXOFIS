import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildPartnerNetworkGraph,
  buildPartnerNetworkSuggestions,
  classifyContractTenureOverlap,
  normalizeMaskedDocument,
  normalizePersonName,
  type SupplierQsaRecord,
} from '@nexofis/shared/lib/partnerNetworkGraph';
import { createNexofisStore } from '../storage';
import type { ContractRecord } from '@nexofis/shared/types/audit';

function makeContract(overrides: {
  id: string;
  contractNumber: string;
  cnpj: string;
  companyName: string;
  entityName: string;
  municipalityName: string;
  municipalityIbge: string;
  value: number;
  signatureDate?: string;
  shareholders?: ContractRecord['supplier']['shareholders'];
}): ContractRecord {
  return {
    id: overrides.id,
    pncpControlNumber: `PNCP-${overrides.id}`,
    contractNumber: overrides.contractNumber,
    year: 2025,
    municipalityIbge: overrides.municipalityIbge,
    municipalityName: overrides.municipalityName,
    uf: 'BA',
    entityId: `ENT-${overrides.entityName}`,
    entityName: overrides.entityName,
    modality: 'Pregão Eletrônico',
    biddersCount: 3,
    objectCategory: 'Serviços',
    object: `Fornecimento técnico referente ao contrato ${overrides.contractNumber}`,
    signatureDate: overrides.signatureDate ?? '2025-04-15',
    startDate: overrides.signatureDate ?? '2025-04-15',
    endDate: '2026-04-15',
    originalValue: overrides.value,
    updatedValue: overrides.value,
    status: 'Em Execução',
    dataSourceOrigin: 'PNCP API Oficial',
    supplier: {
      cnpj: overrides.cnpj,
      legalName: overrides.companyName,
      openingDate: '2020-01-10',
      registrationStatus: 'ATIVA',
      primaryCnaeCode: '4645101',
      primaryCnaeDescription: 'Comércio atacadista',
      secondaryCnaes: [],
      shareCapital: 100000,
      municipality: overrides.municipalityName,
      uf: 'BA',
      shareholders: overrides.shareholders ?? [],
      sanctions: [],
      priorMunicipalContracts: 0,
      simultaneousActiveContracts: 1,
      dataProvenance: 'PNCP',
    },
    items: [],
    amendments: [],
    payments: [],
    sourceRecords: [],
    documents: [],
    expectedCnaePrefixes: [],
  };
}

describe('Mapa de Vínculos Societários — Motor de Grafo (partnerNetworkGraph)', () => {
  const qsaDataset: SupplierQsaRecord[] = [
    {
      cnpj: '11222333000181',
      legalName: 'EMPRESA 1 CONSTRUCOES LTDA',
      registrationStatus: 'ATIVA',
      openingDate: '2018-02-10',
      primaryCnaeCode: '4120400',
      primaryCnaeDescription: 'Construção de edifícios',
      municipality: 'BARRA DO CHOÇA',
      uf: 'BA',
      shareCapital: 500000,
      shareholders: [
        {
          name: 'CARLOS EDUARDO MENDES',
          role: 'Sócio-Administrador',
          entryDate: '2018-02-10',
          maskedDocument: '***456789**',
        },
        {
          name: 'ANA PAULA COSTA',
          role: 'Sócia',
          entryDate: '2019-06-01',
          maskedDocument: '***222333**',
        },
      ],
      sourceProvider: 'BrasilAPI CNPJ',
      fetchedAt: '2026-11-22T10:00:00.000Z',
    },
    {
      cnpj: '22333444000181',
      legalName: 'EMPRESA 2 LOGISTICA E SERVICOS LTDA',
      registrationStatus: 'ATIVA',
      openingDate: '2020-05-12',
      primaryCnaeCode: '4930202',
      primaryCnaeDescription: 'Transporte rodoviário de carga',
      municipality: 'VITÓRIA DA CONQUISTA',
      uf: 'BA',
      shareCapital: 300000,
      shareholders: [
        {
          name: 'Carlos Eduardo Mendes',
          role: 'Sócio-Administrador',
          entryDate: '2020-05-12',
          maskedDocument: '***456789**',
        },
      ],
      sourceProvider: 'BrasilAPI CNPJ',
      fetchedAt: '2026-11-22T10:00:00.000Z',
    },
    {
      cnpj: '33444555000181',
      legalName: 'EMPRESA 3 INFRAESTRUTURA LTDA',
      registrationStatus: 'ATIVA',
      openingDate: '2022-09-01',
      primaryCnaeCode: '4213800',
      primaryCnaeDescription: 'Obras de urbanização',
      municipality: 'SALVADOR',
      uf: 'BA',
      shareCapital: 250000,
      shareholders: [
        {
          name: 'CARLOS EDUARDO MENDES',
          role: 'Sócio',
          entryDate: '2022-09-01',
          maskedDocument: '***456789**',
        },
      ],
      sourceProvider: 'BrasilAPI CNPJ',
      fetchedAt: '2026-11-22T10:00:00.000Z',
    },
  ];

  const contractsDataset: ContractRecord[] = [
    makeContract({
      id: 'C-E1-1',
      contractNumber: '001/2025',
      cnpj: '11222333000181',
      companyName: 'EMPRESA 1 CONSTRUCOES LTDA',
      entityName: 'Prefeitura Municipal de Barra do Choça',
      municipalityName: 'Barra do Choça',
      municipalityIbge: '2902906',
      value: 400000,
    }),
    makeContract({
      id: 'C-E2-1',
      contractNumber: '045/2025',
      cnpj: '22333444000181',
      companyName: 'EMPRESA 2 LOGISTICA E SERVICOS LTDA',
      entityName: 'Prefeitura Municipal de Barra do Choça',
      municipalityName: 'Barra do Choça',
      municipalityIbge: '2902906',
      value: 250000,
    }),
    makeContract({
      id: 'C-E3-1',
      contractNumber: '118/2025',
      cnpj: '33444555000181',
      companyName: 'EMPRESA 3 INFRAESTRUTURA LTDA',
      entityName: 'Secretaria de Infraestrutura de Salvador',
      municipalityName: 'Salvador',
      municipalityIbge: '2927408',
      value: 600000,
    }),
    makeContract({
      id: 'C-PLACEHOLDER',
      contractNumber: '999/2025',
      cnpj: '00000000000000',
      companyName: 'Fornecedor não divulgado',
      entityName: 'Órgão X',
      municipalityName: 'Salvador',
      municipalityIbge: '2927408',
      value: 1000,
    }),
  ];

  it('expande Empresa 1 → Sócio 1 → Empresas 2 e 3 e agrega todos os contratos e órgãos em comum', () => {
    const graph = buildPartnerNetworkGraph({
      query: '11.222.333/0001-81',
      mode: 'auto',
      contracts: contractsDataset,
      qsaRecords: qsaDataset,
    });

    assert.equal(graph.resolvedMode, 'company');
    assert.equal(graph.summary.companyCount, 3);
    assert.equal(graph.summary.partnerCount, 2);
    assert.equal(graph.summary.multiCompanyPartnerCount, 1);
    assert.equal(graph.summary.contractCount, 3);
    assert.equal(graph.summary.totalContractValue, 1250000);
    assert.equal(graph.summary.sharedOrganCount, 1);

    const carlos = graph.partners.find((p) => p.normalizedName === 'CARLOS EDUARDO MENDES');
    assert.ok(carlos);
    assert.equal(carlos.companyCount, 3);
    assert.equal(carlos.confidence, 'candidate_masked_cpf_match');
    assert.equal(carlos.identityVerified, false);
    assert.equal(carlos.hasHomonymWarning, true);

    // Empresa 2 and Empresa 3 must report viaPartners containing Carlos Eduardo Mendes
    const emp2 = graph.companies.find((c) => c.cnpj === '22333444000181');
    assert.ok(emp2);
    assert.equal(emp2.isSeed, false);
    assert.ok(emp2.viaPartners.some((v) => normalizePersonName(v) === 'CARLOS EDUARDO MENDES'));

    // Shared organ alert for Prefeitura Municipal de Barra do Choça (Empresa 1 + Empresa 2)
    assert.equal(graph.sharedOrgans.length, 1);
    assert.equal(graph.sharedOrgans[0].companyCnpjs.length, 2);
    assert.equal(graph.sharedOrgans[0].totalValue, 650000);
    assert.equal(graph.sharedOrgans[0].unverifiedIdentityOnly, true);
    assert.ok(graph.sharedOrgans[0].sharedPartners.includes('CARLOS EDUARDO MENDES'));

    // Non-overlapping deterministic coordinates per column
    const byX = new Map<number, number[]>();
    for (const n of graph.nodes) {
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
      const list = byX.get(n.x) ?? [];
      list.push(n.y);
      byX.set(n.x, list);
    }
    for (const ys of byX.values()) {
      ys.sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i += 1) {
        assert.ok(ys[i] - ys[i - 1] >= 68, 'Nós na mesma coluna não devem se sobrepor');
      }
    }
  });

  it('busca diretamente por nome do empresário/sócio e retorna todas as empresas e contratos dele', () => {
    const graph = buildPartnerNetworkGraph({
      query: 'carlos eduardo',
      mode: 'partner',
      contracts: contractsDataset,
      qsaRecords: qsaDataset,
    });

    assert.equal(graph.resolvedMode, 'partner');
    assert.equal(graph.summary.companyCount, 3);
    assert.equal(graph.summary.contractCount, 3);
    assert.equal(graph.summary.totalContractValue, 1250000);
    assert.equal(graph.seedType, 'partner');
  });

  it('protege contra homonímia: NUNCA funde sócios com mesmo nome e fragmentos de CPF divergentes', () => {
    const homonymQsa: SupplierQsaRecord[] = [
      {
        cnpj: '44555666000181',
        legalName: 'ALFA COMERCIO LTDA',
        registrationStatus: 'ATIVA',
        openingDate: '2019-01-01',
        primaryCnaeCode: '4711301',
        primaryCnaeDescription: 'Comércio varejista',
        municipality: 'SALVADOR',
        uf: 'BA',
        shareCapital: 100000,
        shareholders: [
          {
            name: 'JOÃO DA SILVA',
            role: 'Sócio-Administrador',
            entryDate: '2019-01-01',
            maskedDocument: '***111222**',
          },
        ],
        sourceProvider: 'BrasilAPI CNPJ',
        fetchedAt: '2026-11-22T10:00:00.000Z',
      },
      {
        cnpj: '55666777000181',
        legalName: 'BETA SERVICOS LTDA',
        registrationStatus: 'ATIVA',
        openingDate: '2021-03-01',
        primaryCnaeCode: '8211300',
        primaryCnaeDescription: 'Serviços combinados',
        municipality: 'RECIFE',
        uf: 'PE',
        shareCapital: 80000,
        shareholders: [
          {
            name: 'JOAO DA SILVA',
            role: 'Sócio',
            entryDate: '2021-03-01',
            maskedDocument: '***999888**',
          },
        ],
        sourceProvider: 'BrasilAPI CNPJ',
        fetchedAt: '2026-11-22T10:00:00.000Z',
      },
    ];

    const graph = buildPartnerNetworkGraph({
      query: '44555666000181',
      mode: 'company',
      contracts: [],
      qsaRecords: homonymQsa,
    });

    // Must ONLY return ALFA COMERCIO LTDA — never conflate with BETA SERVICOS LTDA!
    assert.equal(graph.summary.companyCount, 1);
    assert.equal(graph.companies[0].cnpj, '44555666000181');
    assert.equal(graph.summary.partnerCount, 1);
    assert.equal(graph.partners[0].maskedDocument, '***111222**');
  });

  it('sinaliza homonym_risk e aresta tracejada quando coincidência é apenas nominal (sem CPF mascarado)', () => {
    const nominalOnlyQsa: SupplierQsaRecord[] = [
      {
        cnpj: '66777888000181',
        legalName: 'GAMA HOSPITALAR LTDA',
        registrationStatus: 'ATIVA',
        openingDate: '2020-01-01',
        primaryCnaeCode: '4645101',
        primaryCnaeDescription: 'Materiais médicos',
        municipality: 'FEIRA DE SANTANA',
        uf: 'BA',
        shareCapital: 120000,
        shareholders: [
          {
            name: 'MARIA CLARA SOUZA',
            role: 'Sócia-Administradora',
            entryDate: '2020-01-01',
          },
        ],
        sourceProvider: 'BrasilAPI CNPJ',
        fetchedAt: '2026-11-22T10:00:00.000Z',
      },
      {
        cnpj: '77888999000181',
        legalName: 'DELTA FARMACEUTICA LTDA',
        registrationStatus: 'ATIVA',
        openingDate: '2022-01-01',
        primaryCnaeCode: '4644301',
        primaryCnaeDescription: 'Medicamentos',
        municipality: 'FEIRA DE SANTANA',
        uf: 'BA',
        shareCapital: 200000,
        shareholders: [
          {
            name: 'Maria Clara Souza',
            role: 'Sócia',
            entryDate: '2022-01-01',
          },
        ],
        sourceProvider: 'BrasilAPI CNPJ',
        fetchedAt: '2026-11-22T10:00:00.000Z',
      },
    ];

    const graph = buildPartnerNetworkGraph({
      query: '66777888000181',
      mode: 'company',
      contracts: [],
      qsaRecords: nominalOnlyQsa,
    });

    assert.equal(graph.summary.companyCount, 2);
    assert.equal(graph.summary.homonymRiskPartnerCount, 1);
    assert.equal(graph.partners[0].confidence, 'candidate_nominal_match');
    assert.equal(graph.partners[0].identityVerified, false);
    assert.equal(graph.partners[0].hasHomonymWarning, true);
    const socioEdges = graph.edges.filter((e) => e.relation === 'SOCIO_DE');
    assert.equal(socioEdges.length, 2);
    assert.ok(socioEdges.every((e) => e.dashed === true));
  });

  it('normaliza nomes, documentos mascarados e gera sugestões reais de sócios multiempresa', () => {
    assert.equal(normalizePersonName('José Ávila-Júnior '), 'JOSE AVILA JUNIOR');
    assert.equal(normalizeMaskedDocument('***456.789-**'), '***456789**');
    assert.equal(normalizeMaskedDocument('******'), '');
    assert.equal(normalizeMaskedDocument('00000000000'), '');

    const suggestions = buildPartnerNetworkSuggestions({
      contracts: contractsDataset,
      qsaRecords: qsaDataset,
    });
    assert.equal(suggestions.totalUniqueSuppliers, 3);
    assert.equal(suggestions.indexedQsaCount, 3);
    assert.equal(suggestions.pendingQsaCount, 0);
    assert.equal(suggestions.multiCompanyPartners.length, 1);
    assert.equal(suggestions.multiCompanyPartners[0].label, 'CARLOS EDUARDO MENDES');
    assert.equal(suggestions.multiCompanyPartners[0].companyCount, 3);
    assert.equal(suggestions.multiCompanyPartners[0].contractCount, 3);
  });

  it('persiste supplier_qsa_cache na migração SQLite v4 entre reinicializações', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexofis-qsa-cache-'));
    const dbPath = path.join(tmpDir, 'test.db');

    try {
      const store1 = createNexofisStore(dbPath);
      assert.equal(store1.getSchemaVersion(), 7);
      store1.upsertSupplierQsa(qsaDataset[0]);
      store1.upsertSupplierQsa(qsaDataset[1]);
      store1.close();

      const store2 = createNexofisStore(dbPath);
      const fetched = store2.getSupplierQsa('11222333000181');
      assert.ok(fetched);
      assert.equal(fetched.legalName, 'EMPRESA 1 CONSTRUCOES LTDA');
      assert.equal(fetched.shareholders.length, 2);
      assert.equal(fetched.shareholders[0].maskedDocument, '***456789**');

      const all = store2.listAllSupplierQsa();
      assert.equal(all.length, 2);
      store2.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('M03: deduplica contratos espelho pelo pncpControlNumber e sinaliza divergência de valor', () => {
    const mirrorA = {
      ...makeContract({
        id: 'C-MIRROR-A',
        contractNumber: '010/2025',
        cnpj: '11222333000181',
        companyName: 'EMPRESA 1 CONSTRUCOES LTDA',
        entityName: 'Secretaria Municipal de Saúde',
        municipalityName: 'Barra do Choça',
        municipalityIbge: '2902906',
        value: 300000,
      }),
      pncpControlNumber: '13906789000196-2-000010/2025',
    };
    const mirrorB = {
      ...makeContract({
        id: 'C-MIRROR-B',
        contractNumber: '010/2025',
        cnpj: '11222333000181',
        companyName: 'EMPRESA 1 CONSTRUCOES LTDA',
        entityName: 'Secretaria Municipal de Saúde',
        municipalityName: 'Barra do Choça',
        municipalityIbge: '2902906',
        value: 420000,
      }),
      pncpControlNumber: '13906789000196-2-000010/2025',
    };

    const graph = buildPartnerNetworkGraph({
      query: '11222333000181',
      mode: 'company',
      contracts: [mirrorA, mirrorB],
      qsaRecords: [qsaDataset[0]],
    });

    assert.equal(graph.summary.contractCount, 1);
    assert.equal(graph.summary.duplicateMirrorCount, 1);
    assert.equal(graph.summary.valueDivergenceCount, 1);
    assert.equal(graph.contracts[0].hasValueDivergence, true);
  });

  it('M04: separa contratos anteriores à entrada no QSA dos contratos assinados durante a gestão', () => {
    assert.equal(classifyContractTenureOverlap('2023-06-01', '2022-01-10'), 'before_entry_date');
    assert.equal(classifyContractTenureOverlap('2023-06-01', '2024-03-15'), 'during_observed_tenure');
    assert.equal(classifyContractTenureOverlap('', '2024-03-15'), 'unknown_period');

    const preEntry = makeContract({
      id: 'C-PRE',
      contractNumber: '001/2017',
      cnpj: '11222333000181',
      companyName: 'EMPRESA 1 CONSTRUCOES LTDA',
      entityName: 'Prefeitura Municipal de Barra do Choça',
      municipalityName: 'Barra do Choça',
      municipalityIbge: '2902906',
      value: 150000,
      signatureDate: '2017-05-10',
    });
    const duringTenure = makeContract({
      id: 'C-DURING',
      contractNumber: '002/2025',
      cnpj: '11222333000181',
      companyName: 'EMPRESA 1 CONSTRUCOES LTDA',
      entityName: 'Prefeitura Municipal de Barra do Choça',
      municipalityName: 'Barra do Choça',
      municipalityIbge: '2902906',
      value: 500000,
      signatureDate: '2025-05-10',
    });

    const graph = buildPartnerNetworkGraph({
      query: '11222333000181',
      mode: 'company',
      contracts: [preEntry, duringTenure],
      qsaRecords: [qsaDataset[0]],
    });

    const carlos = graph.partners.find((p) => p.normalizedName === 'CARLOS EDUARDO MENDES')!;
    assert.equal(carlos.contractsBeforeEntryCount, 1);
    assert.equal(carlos.contractsDuringTenureCount, 1);
    assert.equal(carlos.contractsDuringTenureValue, 500000);
  });

  it('M06: distingue órgãos diferentes com mesmo nome via entityId canônico', () => {
    const c1 = {
      ...makeContract({
        id: 'C-ORG-1',
        contractNumber: '001/2025',
        cnpj: '11222333000181',
        companyName: 'EMPRESA 1 CONSTRUCOES LTDA',
        entityName: 'Secretaria Municipal de Saúde',
        municipalityName: 'Barra do Choça',
        municipalityIbge: '2902906',
        value: 100000,
      }),
      entityId: 'ENT-13906789000196-1544',
    };
    const c2 = {
      ...makeContract({
        id: 'C-ORG-2',
        contractNumber: '002/2025',
        cnpj: '22333444000181',
        companyName: 'EMPRESA 2 LOGISTICA E SERVICOS LTDA',
        entityName: 'Secretaria Municipal de Saúde',
        municipalityName: 'Salvador',
        municipalityIbge: '2927408',
        value: 200000,
      }),
      entityId: 'ENT-13927801000149-1001',
    };

    const graph = buildPartnerNetworkGraph({
      query: '11222333000181',
      mode: 'company',
      contracts: [c1, c2],
      qsaRecords: qsaDataset.slice(0, 2),
    });

    // Different entityIds MUST NOT be merged into a false shared organ alert
    assert.equal(graph.sharedOrgans.length, 0);
  });

  it('M07: informa contagens totais e flags de truncamento visual quando excede limite do grafo', () => {
    const makeValidCnpj = (idx: number): string => {
      const base = `${String(10 + idx).padStart(2, '0')}2223330001`.split('').map(Number);
      const calcDigit = (digits: number[], weights: number[]) => {
        const rem = digits.reduce((acc, d, i) => acc + d * weights[i], 0) % 11;
        return rem < 2 ? 0 : 11 - rem;
      };
      const d1 = calcDigit(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
      const d2 = calcDigit([...base, d1], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
      return [...base, d1, d2].join('');
    };

    const manyQsa: SupplierQsaRecord[] = Array.from({ length: 16 }, (_, idx) => {
      const cnpj = makeValidCnpj(idx);
      return {
        cnpj,
        legalName: `EMPRESA REDE ${idx + 1} LTDA`,
        registrationStatus: 'ATIVA',
        openingDate: '2020-01-01',
        primaryCnaeCode: '4120400',
        primaryCnaeDescription: 'Construção',
        municipality: 'SALVADOR',
        uf: 'BA',
        shareCapital: 100000,
        shareholders: [
          {
            name: 'ROBERTO CARLOS LIMA',
            role: 'Sócio-Administrador',
            entryDate: '2020-01-01',
            maskedDocument: '***777888**',
          },
        ],
        sourceProvider: 'BrasilAPI CNPJ',
        fetchedAt: '2026-11-22T10:00:00.000Z',
      };
    });

    const graph = buildPartnerNetworkGraph({
      query: manyQsa[0].cnpj,
      mode: 'company',
      contracts: [],
      qsaRecords: manyQsa,
    });

    assert.equal(graph.summary.totalMatchingCompanies, 1);
    assert.equal(graph.summary.companyCount, 16);
    assert.equal(graph.summary.visualCompaniesTruncated, true);

    const broadGraph = buildPartnerNetworkGraph({
      query: 'EMPRESA REDE',
      mode: 'company',
      contracts: [],
      qsaRecords: manyQsa,
    });
    assert.equal(broadGraph.summary.totalMatchingCompanies, 16);
    assert.equal(broadGraph.summary.visualCompaniesTruncated, true);
  });

  it('reconstrói CNPJ Matriz a partir de raiz RFB de 8 dígitos e escala árvore recursiva de Holdings PJ + sócios + contratos externos', async () => {
    const { deriveMatrizCnpjFromRoot, resolveCorporatePartnerCnpj } = await import(
      '@nexofis/shared/lib/cnpj'
    );

    // Real-world case from screenshot: GWM HOLDING LTDA returned as 8-digit root "54926804"
    assert.equal(deriveMatrizCnpjFromRoot('54926804'), '54926804000145');
    assert.equal(
      resolveCorporatePartnerCnpj({ maskedDocument: '54926804' }),
      '54926804000145'
    );
    // Must NEVER mistake a masked CPF for a corporate partner
    assert.equal(resolveCorporatePartnerCnpj({ maskedDocument: '***097255**' }), null);
    assert.equal(
      resolveCorporatePartnerCnpj({ maskedDocument: '54926804', partnerType: 'PF' }),
      null
    );

    const corporateQsa: SupplierQsaRecord[] = [
      {
        cnpj: '10562589000175',
        legalName: 'WM APOIO A GESTAO DE SAUDE LTDA',
        registrationStatus: 'ATIVA',
        openingDate: '2008-12-10',
        primaryCnaeCode: '8211300',
        primaryCnaeDescription: 'Serviços combinados de escritório',
        municipality: 'VITORIA DA CONQUISTA',
        uf: 'BA',
        shareCapital: 500000,
        shareholders: [
          {
            name: 'GWM HOLDING LTDA',
            role: 'Sócio',
            entryDate: '2024-06-01',
            maskedDocument: '54926804', // 8-digit CNPJ Básico (RFB/BrasilAPI)
            partnerType: 'PJ',
          },
          {
            name: 'MARIANA AMARAL ALMEIDA',
            role: 'Sócio-Administrador',
            entryDate: '2018-01-01',
            maskedDocument: '***097255**',
            partnerType: 'PF',
          },
        ],
        sourceProvider: 'BrasilAPI CNPJ',
        fetchedAt: '2026-11-22T10:00:00.000Z',
      },
      {
        cnpj: '54926804000145',
        legalName: 'GWM HOLDING LTDA',
        registrationStatus: 'ATIVA',
        openingDate: '2024-04-29',
        primaryCnaeCode: '6462000',
        primaryCnaeDescription: 'Holdings de instituições não-financeiras',
        municipality: 'VITORIA DA CONQUISTA',
        uf: 'BA',
        shareCapital: 100000,
        shareholders: [
          {
            name: 'HOLDING TOP PARTICIPACOES S/A',
            role: 'Sócio PJ',
            entryDate: '2024-05-01',
            maskedDocument: '11222333000181',
            partnerType: 'PJ',
          },
          {
            name: 'WASHINGTON WILLIAN COSTA FERREIRA',
            role: 'Sócio-Administrador',
            entryDate: '2024-04-29',
            maskedDocument: '***996795**',
            partnerType: 'PF',
          },
        ],
        sourceProvider: 'BrasilAPI CNPJ',
        fetchedAt: '2026-11-22T10:00:00.000Z',
      },
      {
        cnpj: '11222333000181',
        legalName: 'HOLDING TOP PARTICIPACOES S/A',
        registrationStatus: 'ATIVA',
        openingDate: '2020-01-01',
        primaryCnaeCode: '6462000',
        primaryCnaeDescription: 'Holdings',
        municipality: 'SALVADOR',
        uf: 'BA',
        shareCapital: 2000000,
        shareholders: [
          {
            name: 'MARIA CONTROLADORA',
            role: 'Diretor',
            entryDate: '2020-01-01',
            maskedDocument: '***555666**',
            partnerType: 'PF',
          },
        ],
        sourceProvider: 'BrasilAPI CNPJ',
        fetchedAt: '2026-11-22T10:00:00.000Z',
      },
      {
        // Sister company also owned by GWM HOLDING LTDA with external contracts
        cnpj: '22333444000181',
        legalName: 'CLINICA COLIGADA GWM LTDA',
        registrationStatus: 'ATIVA',
        openingDate: '2021-03-01',
        primaryCnaeCode: '8630503',
        primaryCnaeDescription: 'Atividade médica ambulatorial',
        municipality: 'ILHEUS',
        uf: 'BA',
        shareCapital: 300000,
        shareholders: [
          {
            name: 'GWM HOLDING LTDA',
            role: 'Sócio',
            entryDate: '2024-07-01',
            maskedDocument: '54926804',
            partnerType: 'PJ',
          },
        ],
        sourceProvider: 'BrasilAPI CNPJ',
        fetchedAt: '2026-11-22T10:00:00.000Z',
      },
    ];

    const corporateContracts: ContractRecord[] = [
      makeContract({
        id: 'C-WM-1',
        contractNumber: '010/2025',
        cnpj: '10562589000175',
        companyName: 'WM APOIO A GESTAO DE SAUDE LTDA',
        entityName: 'Prefeitura de Barra do Choça',
        municipalityName: 'Barra do Choça',
        municipalityIbge: '2902906',
        value: 500000,
      }),
      makeContract({
        id: 'C-HOLDING-1',
        contractNumber: '020/2025',
        cnpj: '54926804000145',
        companyName: 'GWM HOLDING LTDA',
        entityName: 'Secretaria Estadual de Saúde',
        municipalityName: 'Salvador',
        municipalityIbge: '2927408',
        value: 300000,
      }),
      makeContract({
        id: 'C-SISTER-1',
        contractNumber: '030/2025',
        cnpj: '22333444000181',
        companyName: 'CLINICA COLIGADA GWM LTDA',
        entityName: 'Prefeitura de Ilhéus',
        municipalityName: 'Ilhéus',
        municipalityIbge: '2913606',
        value: 450000,
      }),
    ];

    const graph = buildPartnerNetworkGraph({
      query: '10562589000175',
      mode: 'company',
      contracts: corporateContracts,
      qsaRecords: corporateQsa,
    });

    // Must discover all 4 companies: seed (WM), Holding L1 (GWM), Holding L2 (TOP), and Sister (CLINICA COLIGADA)
    assert.equal(graph.summary.companyCount, 4);
    assert.equal(graph.summary.corporateShareholderCount, 2);
    assert.equal(graph.summary.maxOwnershipDepth, 2);
    // Must discover all 3 PF partners across the whole holding hierarchy (Mariana, Washington, Maria Controladora)
    assert.equal(graph.summary.partnerCount, 3);
    // Must aggregate contracts from seed + holding + sister company
    assert.equal(graph.summary.contractCount, 3);
    assert.equal(graph.summary.totalContractValue, 1250000);

    // GWM HOLDING must NOT appear as a leaf PF partner; it must be a first-class company node with depth 1
    assert.equal(
      graph.partners.some((p) => p.normalizedName.includes('GWM HOLDING')),
      false
    );
    const gwm = graph.companies.find((c) => c.cnpj === '54926804000145');
    assert.ok(gwm);
    assert.equal(gwm.isCorporateShareholder, true);
    assert.equal(gwm.ownershipDepth, 1);
    assert.equal(gwm.corporateShareholderOf.length, 2);
    assert.equal(gwm.corporateShareholders.length, 1);

    const topHolding = graph.companies.find((c) => c.cnpj === '11222333000181');
    assert.ok(topHolding);
    assert.equal(topHolding.ownershipDepth, 2);

    // SOCIO_PJ_DE edges must connect Top -> GWM, GWM -> WM, and GWM -> Sister
    const pjEdges = graph.edges.filter((e) => e.relation === 'SOCIO_PJ_DE');
    assert.equal(pjEdges.length, 3);

    // Dynamic layout columns must place Holdings (Nível 2) -> Holdings (Nível 1) -> Empresas -> Contratos -> Órgãos
    const holdingCols = graph.layout.columns.filter((c) => c.kind === 'corporate_layer');
    assert.equal(holdingCols.length, 2);
    assert.ok(holdingCols[0].x < holdingCols[1].x);
  });

  it('protege contra ciclo societário circular entre PJs (Empresa A sócia de B e B sócia de A) sem loop infinito', () => {
    const cyclicQsa: SupplierQsaRecord[] = [
      {
        cnpj: '11222333000181',
        legalName: 'CICLO A LTDA',
        registrationStatus: 'ATIVA',
        openingDate: '2020-01-01',
        primaryCnaeCode: '6462000',
        primaryCnaeDescription: 'Holdings',
        municipality: 'SALVADOR',
        uf: 'BA',
        shareCapital: 100000,
        shareholders: [
          {
            name: 'CICLO B LTDA',
            role: 'Sócio PJ',
            entryDate: '2020-01-01',
            maskedDocument: '22333444000181',
            partnerType: 'PJ',
          },
        ],
        sourceProvider: 'BrasilAPI CNPJ',
        fetchedAt: '2026-11-22T10:00:00.000Z',
      },
      {
        cnpj: '22333444000181',
        legalName: 'CICLO B LTDA',
        registrationStatus: 'ATIVA',
        openingDate: '2020-01-01',
        primaryCnaeCode: '6462000',
        primaryCnaeDescription: 'Holdings',
        municipality: 'SALVADOR',
        uf: 'BA',
        shareCapital: 100000,
        shareholders: [
          {
            name: 'CICLO A LTDA',
            role: 'Sócio PJ',
            entryDate: '2020-01-01',
            maskedDocument: '11222333000181',
            partnerType: 'PJ',
          },
        ],
        sourceProvider: 'BrasilAPI CNPJ',
        fetchedAt: '2026-11-22T10:00:00.000Z',
      },
    ];

    const graph = buildPartnerNetworkGraph({
      query: '11222333000181',
      mode: 'company',
      contracts: [],
      qsaRecords: cyclicQsa,
    });

    assert.equal(graph.summary.companyCount, 2);
    assert.ok(graph.summary.maxOwnershipDepth <= 6);
    assert.equal(graph.edges.filter((e) => e.relation === 'SOCIO_PJ_DE').length, 2);
  });
});
