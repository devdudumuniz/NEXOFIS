import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatFlowchartCardCopyText } from './flowchartCardCopy';
import type {
  PartnerNetworkCompanySummary,
  PartnerNetworkContractSummary,
  PartnerNetworkNode,
  PartnerNetworkPartnerSummary,
} from '@nexofis/shared/lib/partnerNetworkGraph';

describe('flowchartCardCopy — Formatação de cópia de cards do fluxograma', () => {
  it('formata card de Holding / Sócio PJ com CNPJ, participações e contratos', () => {
    const node: PartnerNetworkNode = {
      id: 'company:54926804000145',
      type: 'company',
      label: 'GWM HOLDING LTDA',
      subtitle: '54.926.804/0001-45 · Sócia PJ',
      x: 465,
      y: 230,
      isSeed: false,
      cnpj: '54926804000145',
      isCorporateShareholder: true,
      ownershipDepth: 1,
      metadata: {},
    };
    const company: PartnerNetworkCompanySummary = {
      cnpj: '54926804000145',
      formattedCnpj: '54.926.804/0001-45',
      legalName: 'GWM HOLDING LTDA',
      registrationStatus: 'ATIVA',
      openingDate: '2024-04-29',
      municipality: 'VITORIA DA CONQUISTA',
      uf: 'BA',
      primaryCnaeCode: '6462000',
      primaryCnaeDescription: 'Holdings de instituições não-financeiras',
      shareCapital: 100000,
      isSeed: false,
      isCorporateShareholder: true,
      ownershipDepth: 1,
      corporateShareholderOf: [
        {
          cnpj: '10562589000175',
          formattedCnpj: '10.562.589/0001-75',
          legalName: 'WM APOIO A GESTAO DE SAUDE E TECNOLOGIA LTDA',
          role: 'Sócio',
          entryDate: '2024-06-01',
        },
      ],
      corporateShareholders: [],
      viaPartners: ['MARIANA AMARAL ALMEIDA'],
      partnerCount: 2,
      contractCount: 0,
      totalContractValue: 0,
      maxRiskScore: null,
      distinctOrgans: [],
      qsaSource: 'qsa_cache',
    };

    const text = formatFlowchartCardCopyText({ node, company });
    assert.match(text, /Holding \/ Sócio Pessoa Jurídica \(PJ\)/);
    assert.match(text, /GWM HOLDING LTDA/);
    assert.match(text, /54\.926\.804\/0001-45/);
    assert.match(text, /Sócia PJ de: WM APOIO A GESTAO DE SAUDE E TECNOLOGIA LTDA/);
    assert.match(text, /Holdings de instituições não-financeiras/);
  });

  it('formata card de Sócio PF com documento mascarado e participações', () => {
    const node: PartnerNetworkNode = {
      id: 'partner:MARIANA',
      type: 'partner',
      label: 'MARIANA AMARAL ALMEIDA',
      subtitle: '2 empresas · Candidato (CPF masc.)',
      x: 150,
      y: 230,
      isSeed: false,
      metadata: {},
    };
    const partner: PartnerNetworkPartnerSummary = {
      id: 'partner:MARIANA',
      displayName: 'MARIANA AMARAL ALMEIDA',
      normalizedName: 'MARIANA AMARAL ALMEIDA',
      maskedDocument: '***097255**',
      confidence: 'candidate_masked_cpf_match',
      identityVerified: false,
      identityQualificationNote: 'Nota',
      isSeed: false,
      roles: [
        {
          cnpj: '54926804000145',
          companyName: 'GWM HOLDING LTDA',
          role: 'Sócio-Administrador',
          entryDate: '2024-04-29',
        },
      ],
      companyCnpjs: ['54926804000145', '10562589000175'],
      companyCount: 2,
      contractCount: 16,
      totalContractValue: 1200000,
      contractsDuringTenureCount: 16,
      contractsDuringTenureValue: 1200000,
      contractsBeforeEntryCount: 0,
      contractsUnknownPeriodCount: 0,
      hasHomonymWarning: true,
    };

    const text = formatFlowchartCardCopyText({ node, partner });
    assert.match(text, /Sócio \/ Empresário \(PF\)/);
    assert.match(text, /MARIANA AMARAL ALMEIDA/);
    assert.match(text, /\*\*\*097255\*\*/);
    assert.match(text, /GWM HOLDING LTDA — Sócio-Administrador/);
  });

  it('formata card de Contrato e Órgão com valores e risco', () => {
    const contractNode: PartnerNetworkNode = {
      id: 'contract:C1',
      type: 'contract',
      label: 'Contrato 005/2026',
      subtitle: 'MUNICIPIO DE BARRA DO CHOCA',
      x: 780,
      y: 230,
      isSeed: false,
      contractId: 'C1',
      metadata: {},
    };
    const contract: PartnerNetworkContractSummary = {
      contractId: 'C1',
      contractNumber: '005/2026',
      pncpControlNumber: 'PNCP-005',
      companyCnpj: '10562589000175',
      formattedCompanyCnpj: '10.562.589/0001-75',
      companyName: 'WM APOIO LTDA',
      entityId: 'ENT-1',
      entityName: 'MUNICIPIO DE BARRA DO CHOCA',
      municipalityName: 'Barra do Choça',
      municipalityIbge: '2902906',
      signatureDate: '2026-01-10',
      updatedValue: 450000,
      duplicateMirrorCount: 0,
      hasValueDivergence: false,
      riskScore: 42,
      riskLabel: 'MEDIO',
      coverageStatus: 'ADEQUATE',
      objectSummary: 'Apoio técnico em saúde',
    };

    const ctText = formatFlowchartCardCopyText({ node: contractNode, contract });
    assert.match(ctText, /Contrato: 005\/2026/);
    assert.match(ctText, /PNCP-005/);
    assert.match(ctText, /42\/100/);
    assert.match(ctText, /Apoio técnico em saúde/);

    const organNode: PartnerNetworkNode = {
      id: 'organ:O1',
      type: 'organ',
      label: 'Prefeitura Municipal',
      subtitle: '2 empresas da rede',
      x: 1095,
      y: 230,
      isSeed: false,
      companyCount: 2,
      contractCount: 4,
      value: 900000,
      isSharedOrgan: true,
      metadata: { organName: 'Prefeitura Municipal de Barra do Choça', municipalityName: 'Barra do Choça' },
    };
    const orgText = formatFlowchartCardCopyText({ node: organNode });
    assert.match(orgText, /Órgão: Prefeitura Municipal de Barra do Choça/);
    assert.match(orgText, /Empresas da rede contratadas: 2/);
    assert.match(orgText, /Alerta: Órgão contratou mais de uma empresa/);
  });
});
