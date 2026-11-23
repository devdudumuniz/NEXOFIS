import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractCandidateSupplierCnpj,
  isMissingSupplierName,
  resolveContractsSupplierNames,
} from '../supplierResolver';
import type { SupplierQsaRecord } from '@nexofis/shared/lib/partnerNetworkGraph';
import type { ContractRecord } from '@nexofis/shared/types/audit';

function makeBaseContract(overrides: Partial<ContractRecord> & { id: string }): ContractRecord {
  return {
    id: overrides.id,
    pncpControlNumber: overrides.pncpControlNumber ?? `13906789000196-2-000001/2025`,
    contractNumber: overrides.contractNumber ?? '001/2025',
    year: 2025,
    municipalityIbge: '2902906',
    municipalityName: 'Barra do Choça',
    uf: 'BA',
    entityId: overrides.entityId ?? 'ENT-13906789000196-1544',
    entityName: overrides.entityName ?? 'Prefeitura Municipal de Barra do Choça',
    modality: 'Pregão Eletrônico',
    biddersCount: null,
    objectCategory: 'Serviços',
    object: 'Contratação de empresa especializada',
    signatureDate: '2025-02-21',
    startDate: '2025-02-21',
    endDate: '2026-02-21',
    originalValue: 150000,
    updatedValue: 150000,
    status: 'Vigente',
    dataSourceOrigin: 'PNCP API Oficial',
    supplier: overrides.supplier ?? {
      cnpj: '',
      legalName: 'Fornecedor não divulgado na publicação (PNCP)',
      openingDate: '',
      registrationStatus: 'DESCONHECIDA',
      primaryCnaeCode: '',
      primaryCnaeDescription: 'Não consultado na RFB',
      secondaryCnaes: [],
      shareCapital: 0,
      municipality: 'Barra do Choça',
      uf: 'BA',
      shareholders: [],
      sanctions: [],
      priorMunicipalContracts: 0,
      simultaneousActiveContracts: 1,
      dataProvenance: 'PNCP',
    },
    items: [],
    amendments: [],
    payments: [],
    sourceRecords: overrides.sourceRecords ?? [],
    documents: overrides.documents ?? [],
    expectedCnaePrefixes: [],
  };
}

describe('Secondary Supplier Legal Name Resolver (supplierResolver)', () => {
  it('detecta rótulos ausentes/placeholder e nunca confunde CNPJ do órgão contratante como fornecedor', () => {
    assert.equal(isMissingSupplierName('Fornecedor não divulgado na publicação (PNCP)'), true);
    assert.equal(isMissingSupplierName('Fornecedor CNPJ 10276902000109'), true);
    assert.equal(isMissingSupplierName(''), true);
    assert.equal(isMissingSupplierName('CONSTRUMENDES SERVICOS E EMPREENDIMENTOS EIRELI'), false);

    // Contract whose sourceRecord only carries the contracting organ's own CNPJ (13906789000196)
    const organOnly = makeBaseContract({
      id: 'C-ORG-ONLY',
      entityId: 'ENT-13906789000196-1544',
      sourceRecords: [
        {
          id: 'SRC-1',
          sourceSystem: 'PNCP',
          externalId: '13906789000196-1-000010/2026',
          retrievedAt: '2026-03-01T00:00:00Z',
          rawPayloadHash: 'abc',
          parserVersion: 'v3',
          reportedOriginalValue: 50000,
          reportedUpdatedValue: 50000,
          reportedSupplierCnpj: '13906789000196',
          reportedStatus: 'Divulgada no PNCP',
          reportedEndDate: '',
          sourceUrl: 'https://pncp.gov.br',
        },
      ],
    });
    assert.equal(extractCandidateSupplierCnpj(organOnly), '');
  });

  it('resolve razão social via base local de empresas (QSA), base local de contratos e consulta secundária por CNPJ', async () => {
    const qsaCompany: SupplierQsaRecord = {
      cnpj: '10276902000109',
      legalName: 'CONSTRUMENDES SERVICOS E EMPREENDIMENTOS EIRELI',
      registrationStatus: 'ATIVA',
      openingDate: '2008-08-18',
      primaryCnaeCode: '4120400',
      primaryCnaeDescription: 'Construção de edifícios',
      municipality: 'BARRA DO CHOCA',
      uf: 'BA',
      shareCapital: 500000,
      shareholders: [
        {
          name: 'SOCIO TESTE',
          role: 'Administrador',
          entryDate: '2008-08-18',
          maskedDocument: '***111222**',
        },
      ],
      sourceProvider: 'BrasilAPI CNPJ',
      fetchedAt: '2026-11-22T10:00:00Z',
    };

    const knownContract = makeBaseContract({
      id: 'C-KNOWN',
      supplier: {
        ...makeBaseContract({ id: 'tmp' }).supplier,
        cnpj: '08784723000130',
        legalName: 'KM CONTABILIDADE PUBLICA LTDA - EPP',
      },
    });

    const cFromQsa = makeBaseContract({
      id: 'C-QSA',
      supplier: {
        ...makeBaseContract({ id: 'tmp' }).supplier,
        cnpj: '10276902000109',
        legalName: 'Fornecedor não divulgado na publicação (PNCP)',
      },
    });

    const cFromLocalContract = makeBaseContract({
      id: 'C-LOCAL-CTR',
      supplier: {
        ...makeBaseContract({ id: 'tmp' }).supplier,
        cnpj: '08784723000130',
        legalName: 'Fornecedor CNPJ 08784723000130',
      },
    });

    const cFromExternal = makeBaseContract({
      id: 'C-EXTERNAL',
      supplier: {
        ...makeBaseContract({ id: 'tmp' }).supplier,
        cnpj: '11222333000181',
        legalName: 'Fornecedor não divulgado na publicação (PNCP)',
      },
    });

    const cUnhomologated = makeBaseContract({
      id: 'C-EDITAL-NO-CNPJ',
      supplier: {
        ...makeBaseContract({ id: 'tmp' }).supplier,
        cnpj: '',
        legalName: 'Fornecedor não divulgado na publicação (PNCP)',
      },
    });

    const externalCalled: string[] = [];
    const enrichedPersisted: string[] = [];

    const result = await resolveContractsSupplierNames(
      [cFromQsa, cFromLocalContract, cFromExternal, cUnhomologated],
      {
        getLocalCompanyByCnpj: (cnpj) => (cnpj === '10276902000109' ? qsaCompany : null),
        getKnownContracts: () => [knownContract],
        fetchCompanyByCnpj: async (cnpj) => {
          externalCalled.push(cnpj);
          return {
            fromCache: false,
            record: {
              cnpj,
              legalName: 'ALFA SOLUCOES MEDICAS LTDA',
              registrationStatus: 'ATIVA',
              openingDate: '2020-01-10',
              primaryCnaeCode: '4645101',
              primaryCnaeDescription: 'Comércio atacadista',
              municipality: 'SALVADOR',
              uf: 'BA',
              shareCapital: 100000,
              shareholders: [],
              sourceProvider: 'BrasilAPI CNPJ',
              fetchedAt: '2026-11-23T00:00:00Z',
            },
          };
        },
        onContractEnriched: (c) => enrichedPersisted.push(c.id),
      }
    );

    assert.equal(result.resolvedCount, 3);
    assert.equal(result.resolvedFromLocalDb, 2);
    assert.equal(result.resolvedFromExternalCnpj, 1);
    assert.deepEqual(externalCalled, ['11222333000181']);

    assert.equal(
      result.contracts[0].supplier.legalName,
      'CONSTRUMENDES SERVICOS E EMPREENDIMENTOS EIRELI'
    );
    assert.equal(result.contracts[0].supplier.openingDate, '2008-08-18');
    assert.equal(result.contracts[1].supplier.legalName, 'KM CONTABILIDADE PUBLICA LTDA - EPP');
    assert.equal(result.contracts[2].supplier.legalName, 'ALFA SOLUCOES MEDICAS LTDA');
    assert.equal(
      result.contracts[3].supplier.legalName,
      'Edital publicado — fornecedor ainda não homologado no PNCP'
    );
    assert.equal(enrichedPersisted.length, 4);
  });
});
