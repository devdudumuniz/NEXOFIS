import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildPartnerNetworkGraph,
  buildPartnerNetworkSuggestions,
  normalizeMaskedDocument,
  normalizePersonName,
  type SupplierQsaRecord,
} from './partnerNetworkGraph';
import { createNexofisStore } from '../server/storage';
import type { ContractRecord } from '../types/audit';

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
    assert.equal(carlos.confidence, 'name_and_masked_cpf');
    assert.equal(carlos.hasHomonymWarning, false);

    // Empresa 2 and Empresa 3 must report viaPartners containing Carlos Eduardo Mendes
    const emp2 = graph.companies.find((c) => c.cnpj === '22333444000181');
    assert.ok(emp2);
    assert.equal(emp2.isSeed, false);
    assert.ok(emp2.viaPartners.some((v) => normalizePersonName(v) === 'CARLOS EDUARDO MENDES'));

    // Shared organ alert for Prefeitura Municipal de Barra do Choça (Empresa 1 + Empresa 2)
    assert.equal(graph.sharedOrgans.length, 1);
    assert.equal(graph.sharedOrgans[0].companyCnpjs.length, 2);
    assert.equal(graph.sharedOrgans[0].totalValue, 650000);
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
    assert.equal(graph.partners[0].confidence, 'homonym_risk');
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
      assert.equal(store1.getSchemaVersion(), 4);
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
});
