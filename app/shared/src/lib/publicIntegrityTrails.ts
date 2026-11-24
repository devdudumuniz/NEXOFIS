import crypto from 'node:crypto';
import type { EndDateSemantics } from './temporalIdentityGraph';
import { parseCsvTable } from './csvParser';
import { validateIsoDate } from './competenciaValidator';

export type PublicIntegrityTrailStatus =
  | 'CONFIRMADO_DOCUMENTALMENTE'
  | 'SINAL_REQUER_REVISAO_HUMANA'
  | 'REVISAO_JURIDICA_NECESSARIA'
  | 'INCOMPATIBILIDADE_DOCUMENTADA'
  | 'CONFORME_NO_ESCOPO'
  | 'DESCONHECIDO_DOCUMENTO_AUSENTE'
  | 'FORA_DO_PERIODO'
  | 'SEM_PARENTESCO_COMPROVADO'
  | 'DADOS_INSUFICIENTES';

export interface ResolvedIdentityRef {
  personId: string;
  fullName: string;
  identityStatus: 'resolved_documentary' | 'unresolved_candidate';
  documentBasis?: string;
}

export interface KinshipAssertionInput {
  id: string;
  personA: ResolvedIdentityRef;
  personB: ResolvedIdentityRef;
  relationType: 'conjuge' | 'companheiro' | 'consanguinidade' | 'afinidade' | 'coincidencia_nome_endereco';
  degree: number | null;
  explicitDocumentarySource: string | null;
  evidenceRefs: string[];
  /** Shared surname or address alone must NEVER create confirmed kinship */
  basedOnlyOnNameOrAddress?: boolean;
}

export interface PublicAppointmentRecord {
  id: string;
  person: ResolvedIdentityRef;
  actReference: string;
  appointingAuthority: ResolvedIdentityRef;
  roleTitle: string;
  bondNature: 'comissionado' | 'efetivo' | 'funcao_gratificada' | 'temporario' | 'eletivo' | 'desconhecido';
  lotacao: string;
  organKey: string;
  jurisdiction: string;
  startDate: string | null;
  endDate: string | null;
  endSemantics: EndDateSemantics;
  sourceLabel: string;
  evidenceRefs: string[];
}

export interface ReciprocityHypothesisInput {
  id: string;
  appointmentA: PublicAppointmentRecord;
  appointmentB: PublicAppointmentRecord;
  contextNotes: string;
}

export interface ContractConflictInput {
  contractId: string;
  contractSignatureDate: string | null;
  contractOrganKey: string;
  contractJurisdiction: string;
  supplierCnpj: string;
  corporateLink: {
    person: ResolvedIdentityRef;
    role: string;
    startDate: string | null;
    endDate: string | null;
    endSemantics: EndDateSemantics;
    evidenceRefs: string[];
  };
  appointment: PublicAppointmentRecord;
  pertinentToContract: boolean;
}

export interface RoleLegalRequirementRule {
  lawReference: string;
  amendmentsApplied: string[];
  jurisdiction: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  roleTitle: string;
  requiresGraduation: boolean;
  expressRequirements: string[];
  interpretiveAmbiguityNote?: string | null;
}

export interface RoleQualificationEvidence {
  requirementLabel: string;
  /** 'documented_met' | 'documented_not_met' | 'missing_document' | 'interpretive_question' */
  evidenceStatus: 'documented_met' | 'documented_not_met' | 'missing_document' | 'interpretive_question';
  documentRef?: string | null;
  notes?: string;
}

export interface RoleRequirementsCheckInput {
  appointment: PublicAppointmentRecord;
  applicableLaw: RoleLegalRequirementRule | null;
  evidences: RoleQualificationEvidence[];
}

export interface IndependentIntegrityTrailResult {
  trailId:
    | 'TRILHA_PARENTESCO_DOCUMENTADO'
    | 'TRILHA_NOMEACOES_NEPOTISMO'
    | 'TRILHA_CONFLITO_CONTRATACAO'
    | 'TRILHA_REQUISITOS_LEGAIS_CARGO';
  status: PublicIntegrityTrailStatus;
  jurisdiction: string | null;
  referenceDate: string | null;
  legalBasis: string | null;
  summary: string;
  conclusiveFraudAssertion: false;
  requiresLegalReview: boolean;
  findings: Array<{
    code: string;
    status: PublicIntegrityTrailStatus;
    detail: string;
    evidenceRefs: string[];
  }>;
  limitations: string[];
  diligences: string[];
}

export interface CamaraPersonnelSnapshotRow {
  nome: string;
  cargo: string;
  lotacao: string;
  vinculo: string;
  dataColeta: string;
}

export interface CamaraDailyPersonnelSnapshot {
  sourceSystem: 'Camara dos Deputados — Arquivo Diario de Funcionarios';
  coverageScope: 'camara_federal_diario';
  hasHistoricalChanges: false;
  snapshotDate: string;
  sha256: string;
  recordCount: number;
  rows: CamaraPersonnelSnapshotRow[];
  limitations: string[];
}

function isIsoDate(d: string | null | undefined): d is string {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

/**
 * Trail 1: Documented Kinship Links.
 * Confirmed kinship requires an explicit documentary source AND resolved identities on both sides.
 * Shared surname or address NEVER creates confirmed kinship.
 */
export function evaluateDocumentedKinshipTrail(
  inputs: ReadonlyArray<KinshipAssertionInput>
): IndependentIntegrityTrailResult {
  const findings: IndependentIntegrityTrailResult['findings'] = [];
  let confirmedCount = 0;

  for (const item of inputs) {
    if (item.basedOnlyOnNameOrAddress || item.relationType === 'coincidencia_nome_endereco') {
      findings.push({
        code: 'KINSHIP_NAME_ADDRESS_REJECTED',
        status: 'SEM_PARENTESCO_COMPROVADO',
        detail: `Coincidência de sobrenome ou endereço entre "${item.personA.fullName}" e "${item.personB.fullName}" não comprova parentesco.`,
        evidenceRefs: item.evidenceRefs,
      });
      continue;
    }

    if (
      item.personA.identityStatus !== 'resolved_documentary' ||
      item.personB.identityStatus !== 'resolved_documentary'
    ) {
      findings.push({
        code: 'KINSHIP_UNRESOLVED_IDENTITY',
        status: 'DADOS_INSUFICIENTES',
        detail: `Parentesco alegado (${item.relationType}) entre "${item.personA.fullName}" e "${item.personB.fullName}" não confirmado: exige resolução documental de identidade de ambas as pessoas.`,
        evidenceRefs: item.evidenceRefs,
      });
      continue;
    }

    if (!item.explicitDocumentarySource?.trim() || item.evidenceRefs.length === 0) {
      findings.push({
        code: 'KINSHIP_MISSING_SOURCE',
        status: 'SEM_PARENTESCO_COMPROVADO',
        detail: `Ausência de fonte documental explícita que sustente o vínculo (${item.relationType}) entre "${item.personA.fullName}" e "${item.personB.fullName}".`,
        evidenceRefs: item.evidenceRefs,
      });
      continue;
    }

    confirmedCount += 1;
    findings.push({
      code: 'KINSHIP_DOCUMENTED',
      status: 'CONFIRMADO_DOCUMENTALMENTE',
      detail: `Vínculo familiar (${item.relationType}${item.degree ? `, ${item.degree}º grau` : ''}) entre "${item.personA.fullName}" e "${item.personB.fullName}" sustentado por ${item.explicitDocumentarySource}.`,
      evidenceRefs: item.evidenceRefs,
    });
  }

  return {
    trailId: 'TRILHA_PARENTESCO_DOCUMENTADO',
    status:
      confirmedCount > 0
        ? 'CONFIRMADO_DOCUMENTALMENTE'
        : findings.some((f) => f.status === 'SEM_PARENTESCO_COMPROVADO')
          ? 'SEM_PARENTESCO_COMPROVADO'
          : 'DADOS_INSUFICIENTES',
    jurisdiction: null,
    referenceDate: null,
    legalBasis: null,
    summary:
      confirmedCount > 0
        ? `${confirmedCount} vínculo(s) familiar(es) documentado(s) com identidades resolvidas. Parentesco por si só não caracteriza irregularidade automática.`
        : 'Nenhum parentesco documentalmente comprovado nas fontes fornecidas.',
    conclusiveFraudAssertion: false,
    requiresLegalReview: false,
    findings,
    limitations: [
      'Coincidências de sobrenome, endereço ou telefone nunca geram parentesco confirmado.',
      'Vínculo familiar documentado não equivale automaticamente a nepotismo ou fraude.',
    ],
    diligences: [
      'Solicitar certidões civis, declarações de parentesco ou atos oficiais para confirmar vínculos ainda não documentados.',
    ],
  };
}

/**
 * Trail 2: Appointments, Possible Nepotism & Reciprocity Context.
 * Represents reciprocity strictly as two appointments with their contexts without presuming collusion.
 * Requires jurisdiction, date, and legal basis; interpretive questions route to legal review.
 */
export function evaluateAppointmentNepotismTrail(params: {
  appointments: ReadonlyArray<PublicAppointmentRecord>;
  documentedKinships: ReadonlyArray<KinshipAssertionInput>;
  reciprocityHypotheses?: ReadonlyArray<ReciprocityHypothesisInput>;
  applicableLegalBasis?: string | null;
  jurisdiction?: string | null;
  referenceDate?: string | null;
}): IndependentIntegrityTrailResult {
  const findings: IndependentIntegrityTrailResult['findings'] = [];
  const confirmedKinshipPairs = new Set<string>();

  for (const k of params.documentedKinships) {
    if (
      !k.basedOnlyOnNameOrAddress &&
      k.relationType !== 'coincidencia_nome_endereco' &&
      k.explicitDocumentarySource?.trim() &&
      k.evidenceRefs.length > 0 &&
      k.personA.identityStatus === 'resolved_documentary' &&
      k.personB.identityStatus === 'resolved_documentary'
    ) {
      confirmedKinshipPairs.add(`${k.personA.personId}::${k.personB.personId}`);
      confirmedKinshipPairs.add(`${k.personB.personId}::${k.personA.personId}`);
    }
  }

  let requiresLegalReview = false;
  const hasLegalContext = Boolean(params.jurisdiction?.trim() && params.referenceDate?.trim() && params.applicableLegalBasis?.trim());

  for (const appt of params.appointments) {
    const pairKey = `${appt.person.personId}::${appt.appointingAuthority.personId}`;
    const hasConfirmedKinship = confirmedKinshipPairs.has(pairKey);

    if (appt.endSemantics === 'unknown_end') {
      findings.push({
        code: 'APPOINTMENT_UNKNOWN_END',
        status: 'DADOS_INSUFICIENTES',
        detail: `Nomeação "${appt.roleTitle}" (${appt.actReference}) de ${appt.person.fullName} possui data de término desconhecida; vigência atual não presumida.`,
        evidenceRefs: appt.evidenceRefs,
      });
    }

    if (hasConfirmedKinship) {
      if (!hasLegalContext) {
        requiresLegalReview = true;
        findings.push({
          code: 'NEPOTISM_MISSING_JURISDICTION_BASIS',
          status: 'REVISAO_JURIDICA_NECESSARIA',
          detail: `Nomeação "${appt.roleTitle}" (ato ${appt.actReference}, vínculo ${appt.bondNature}, lotação ${appt.lotacao}) envolve autoridade nomeante com parentesco documentado, porém sem jurisdição/data/norma aplicável especificada (vedada regra jurídica universal automática).`,
          evidenceRefs: appt.evidenceRefs,
        });
      } else if (appt.bondNature === 'efetivo' || appt.bondNature === 'eletivo') {
        requiresLegalReview = true;
        findings.push({
          code: 'NEPOTISM_CARGO_EFETIVO_OR_POLITICO_REVIEW',
          status: 'REVISAO_JURIDICA_NECESSARIA',
          detail: `Nomeação "${appt.roleTitle}" possui vínculo "${appt.bondNature}" e exige análise jurídica específica quanto ao regime aplicável (${params.applicableLegalBasis}) em ${params.jurisdiction}.`,
          evidenceRefs: appt.evidenceRefs,
        });
      } else {
        requiresLegalReview = true;
        findings.push({
          code: 'NEPOTISM_HYPOTHESIS_FOR_LEGAL_REVIEW',
          status: 'SINAL_REQUER_REVISAO_HUMANA',
          detail: `Sinal objetivo para análise jurídica de possível nepotismo: ato ${appt.actReference} (${appt.roleTitle}, ${appt.bondNature}, lotação ${appt.lotacao}) entre agentes com parentesco documentado, sob referência ${params.applicableLegalBasis} (${params.jurisdiction}, ref. ${params.referenceDate}).`,
          evidenceRefs: appt.evidenceRefs,
        });
      }
    }
  }

  for (const rec of params.reciprocityHypotheses ?? []) {
    requiresLegalReview = true;
    findings.push({
      code: 'RECIPROCITY_CONTEXT_REPRESENTED',
      status: 'REVISAO_JURIDICA_NECESSARIA',
      detail: `Hipótese de reciprocidade representada com os dois atos e contextos (${rec.appointmentA.actReference} em ${rec.appointmentA.lotacao} e ${rec.appointmentB.actReference} em ${rec.appointmentB.lotacao}). Não se presume ajuste ou conluio entre agentes; requer avaliação jurídica e probatória humana.`,
      evidenceRefs: [...rec.appointmentA.evidenceRefs, ...rec.appointmentB.evidenceRefs],
    });
  }

  const topStatus: PublicIntegrityTrailStatus = findings.some(
    (f) => f.status === 'SINAL_REQUER_REVISAO_HUMANA'
  )
    ? 'SINAL_REQUER_REVISAO_HUMANA'
    : requiresLegalReview
      ? 'REVISAO_JURIDICA_NECESSARIA'
      : findings.length > 0
        ? 'DADOS_INSUFICIENTES'
        : 'CONFORME_NO_ESCOPO';

  return {
    trailId: 'TRILHA_NOMEACOES_NEPOTISMO',
    status: topStatus,
    jurisdiction: params.jurisdiction ?? null,
    referenceDate: params.referenceDate ?? null,
    legalBasis: params.applicableLegalBasis ?? null,
    summary:
      findings.length > 0
        ? `${findings.length} registro(s) avaliado(s) na trilha de nomeações/nepotismo (sem conclusão automática de ilicitude ou ajuste).`
        : 'Nenhum sinal objetivo de nepotismo identificado nas nomeações documentadas informadas.',
    conclusiveFraudAssertion: false,
    requiresLegalReview,
    findings,
    limitations: [
      'Regras jurídicas não são aplicadas de forma universal sem jurisdição, data de referência e fundamento normativo.',
      'Hipóteses de reciprocidade registram os dois contextos de nomeação sem presumir ajuste entre agentes.',
      'Dados federais de pessoal não cobrem servidores municipais ou estaduais.',
    ],
    diligences: [
      'Conferir ato completo de nomeação/exoneração no Diário Oficial e verificar exceções normativas locais (ex.: cargo político, qualificação técnica, ausência de subordinação).',
    ],
  };
}

/**
 * Trail 3: Contract-Pertinent Conflicts.
 * Validates temporal overlap between corporate link, public appointment, and contract signature date.
 */
export function evaluateContractConflictTrail(
  inputs: ReadonlyArray<ContractConflictInput>
): IndependentIntegrityTrailResult {
  const findings: IndependentIntegrityTrailResult['findings'] = [];
  let requiresLegalReview = false;

  for (const item of inputs) {
    if (
      item.corporateLink.person.identityStatus !== 'resolved_documentary' ||
      item.appointment.person.identityStatus !== 'resolved_documentary'
    ) {
      findings.push({
        code: 'CONFLICT_UNRESOLVED_IDENTITY',
        status: 'DADOS_INSUFICIENTES',
        detail: `Confronto de conflito no contrato ${item.contractId} bloqueado: identidade pessoal não resolvida documentalmente.`,
        evidenceRefs: [...item.corporateLink.evidenceRefs, ...item.appointment.evidenceRefs],
      });
      continue;
    }

    // Defect 1.3b: Never attribute person-A's corporate link to person-B's public appointment
    const corpPersonId = item.corporateLink.person.personId.trim();
    const apptPersonId = item.appointment.person.personId.trim();
    if (!corpPersonId || !apptPersonId || corpPersonId !== apptPersonId) {
      findings.push({
        code: 'CONFLICT_DISTINCT_IDENTITIES',
        status: 'CONFORME_NO_ESCOPO',
        detail: `Sem sinal de conflito pessoal direto: vínculo societário pertence à identidade "${item.corporateLink.person.fullName}" (${corpPersonId || 'N/D'}) e nomeação pertence à identidade distinta "${item.appointment.person.fullName}" (${apptPersonId || 'N/D'}).`,
        evidenceRefs: [...item.corporateLink.evidenceRefs, ...item.appointment.evidenceRefs],
      });
      continue;
    }

    if (!isIsoDate(item.contractSignatureDate)) {
      findings.push({
        code: 'CONFLICT_MISSING_CONTRACT_DATE',
        status: 'DADOS_INSUFICIENTES',
        detail: `Data de assinatura do contrato ${item.contractId} ausente para confronto temporal.`,
        evidenceRefs: [...item.corporateLink.evidenceRefs, ...item.appointment.evidenceRefs],
      });
      continue;
    }

    const ref = item.contractSignatureDate;
    const corpBefore = isIsoDate(item.corporateLink.startDate) && ref < item.corporateLink.startDate;
    const corpAfter =
      item.corporateLink.endSemantics === 'confirmed_end' &&
      isIsoDate(item.corporateLink.endDate) &&
      ref > item.corporateLink.endDate;
    const apptBefore = isIsoDate(item.appointment.startDate) && ref < item.appointment.startDate;
    const apptAfter =
      item.appointment.endSemantics === 'confirmed_end' &&
      isIsoDate(item.appointment.endDate) &&
      ref > item.appointment.endDate;

    if (corpBefore || corpAfter || apptBefore || apptAfter) {
      findings.push({
        code: 'CONFLICT_OUTSIDE_PERIOD',
        status: 'FORA_DO_PERIODO',
        detail: `Vínculo societário ou função pública de ${item.appointment.person.fullName} não coincide com a data do contrato ${item.contractId} (${ref}).`,
        evidenceRefs: [...item.corporateLink.evidenceRefs, ...item.appointment.evidenceRefs],
      });
      continue;
    }

    if (
      item.corporateLink.endSemantics === 'unknown_end' ||
      item.appointment.endSemantics === 'unknown_end'
    ) {
      findings.push({
        code: 'CONFLICT_UNKNOWN_END_DATE',
        status: 'DADOS_INSUFICIENTES',
        detail: `Fim de vigência desconhecido no vínculo societário ou nomeação de ${item.appointment.person.fullName}; impossível confirmar sobreposição na data ${ref} sem certidão de encerramento/exoneração.`,
        evidenceRefs: [...item.corporateLink.evidenceRefs, ...item.appointment.evidenceRefs],
      });
      continue;
    }

    if (!item.pertinentToContract) {
      findings.push({
        code: 'CONFLICT_NON_PERTINENT_ORGAN',
        status: 'CONFORME_NO_ESCOPO',
        detail: `Função pública (${item.appointment.roleTitle} · ${item.appointment.lotacao}) sem pertinência documentada ao órgão/objeto do contrato ${item.contractId}.`,
        evidenceRefs: [...item.corporateLink.evidenceRefs, ...item.appointment.evidenceRefs],
      });
      continue;
    }

    requiresLegalReview = true;
    findings.push({
      code: 'CONFLICT_OVERLAP_REQUIRES_REVIEW',
      status: 'SINAL_REQUER_REVISAO_HUMANA',
      detail: `Sobreposição temporal documentada na data ${ref}: ${item.appointment.person.fullName} figura em vínculo societário (${item.corporateLink.role}) no CNPJ ${item.supplierCnpj} e em função pública pertinente (${item.appointment.roleTitle}, ${item.appointment.lotacao}). Requer revisão jurídica sob o regime de ${item.contractJurisdiction}.`,
      evidenceRefs: [...item.corporateLink.evidenceRefs, ...item.appointment.evidenceRefs],
    });
  }

  return {
    trailId: 'TRILHA_CONFLITO_CONTRATACAO',
    status: findings.some((f) => f.status === 'SINAL_REQUER_REVISAO_HUMANA')
      ? 'SINAL_REQUER_REVISAO_HUMANA'
      : findings.some((f) => f.status === 'FORA_DO_PERIODO')
        ? 'FORA_DO_PERIODO'
        : findings.length === 0
          ? 'DADOS_INSUFICIENTES'
          : findings[0].status,
    jurisdiction: inputs[0]?.contractJurisdiction ?? null,
    referenceDate: inputs[0]?.contractSignatureDate ?? null,
    legalBasis: 'Análise de conflito conforme norma aplicável à jurisdição e data da contratação',
    summary:
      findings.length > 0
        ? `${findings.length} confronto(s) temporal(is) de conflito avaliado(s).`
        : 'Nenhum confronto de conflito informado para avaliação.',
    conclusiveFraudAssertion: false,
    requiresLegalReview,
    findings,
    limitations: [
      'Vínculos fora do período ou com término desconhecido não sustentam sinal de conflito.',
    ],
    diligences: [
      'Verificar atribuições formais do cargo, participação no processo licitatório e vedações do estatuto/lei de licitações aplicável.',
    ],
  };
}

/**
 * Trail 4: Legal Requirements of the Appointed Role.
 * - Locates creating/amending law applicable at the appointment date.
 * - Treats missing educational/qualification documentation as DESCONHECIDO (NEVER incompatibility).
 * - Distinguishes documented incompatibility from lack of proof.
 * - Routes interpretive ambiguities to REVISAO_JURIDICA_NECESSARIA.
 */
export function evaluateRoleLegalRequirementsTrail(
  input: RoleRequirementsCheckInput
): IndependentIntegrityTrailResult {
  const findings: IndependentIntegrityTrailResult['findings'] = [];
  const apptDate = input.appointment.startDate;

  if (!input.applicableLaw) {
    return {
      trailId: 'TRILHA_REQUISITOS_LEGAIS_CARGO',
      status: 'DADOS_INSUFICIENTES',
      jurisdiction: input.appointment.jurisdiction,
      referenceDate: apptDate,
      legalBasis: null,
      summary: `Lei de criação e alterações do cargo "${input.appointment.roleTitle}" não localizadas para ${input.appointment.jurisdiction}. Impossível aferir requisitos legais sem base normativa.`,
      conclusiveFraudAssertion: false,
      requiresLegalReview: true,
      findings: [
        {
          code: 'ROLE_LAW_NOT_LOCATED',
          status: 'DADOS_INSUFICIENTES',
          detail: 'Ausência de lei de criação/alteração aplicável à data da nomeação.',
          evidenceRefs: input.appointment.evidenceRefs,
        },
      ],
      limitations: [
        'Não se aplicam exigências de escolaridade ou qualificação sem lei expressa aplicável à jurisdição e data.',
        'Qualificação societária de QSA jamais é convertida em escolaridade.',
      ],
      diligences: [
        `Localizar lei municipal/estadual/federal de criação do cargo "${input.appointment.roleTitle}" e alterações vigentes em ${apptDate ?? 'data da nomeação'}.`,
      ],
    };
  }

  // Verify temporal applicability of the cited law
  if (isIsoDate(apptDate)) {
    const afterStart = !isIsoDate(input.applicableLaw.effectiveFrom) || apptDate >= input.applicableLaw.effectiveFrom;
    const beforeEnd = !isIsoDate(input.applicableLaw.effectiveUntil) || apptDate <= input.applicableLaw.effectiveUntil;
    if (!afterStart || !beforeEnd) {
      return {
        trailId: 'TRILHA_REQUISITOS_LEGAIS_CARGO',
        status: 'REVISAO_JURIDICA_NECESSARIA',
        jurisdiction: input.applicableLaw.jurisdiction,
        referenceDate: apptDate,
        legalBasis: input.applicableLaw.lawReference,
        summary: `A norma informada (${input.applicableLaw.lawReference}) não possui vigência compatível com a data da nomeação (${apptDate}).`,
        conclusiveFraudAssertion: false,
        requiresLegalReview: true,
        findings: [
          {
            code: 'ROLE_LAW_OUT_OF_DATE_SCOPE',
            status: 'REVISAO_JURIDICA_NECESSARIA',
            detail: `Vigência da norma (${input.applicableLaw.effectiveFrom} a ${input.applicableLaw.effectiveUntil ?? 'vigente'}) diverge da data da nomeação (${apptDate}).`,
            evidenceRefs: input.appointment.evidenceRefs,
          },
        ],
        limitations: ['Verifique alterações legislativas vigentes na data exata da nomeação.'],
        diligences: ['Consolidar redação legal vigente na data da nomeação.'],
      };
    }
  }

  // Case: role does NOT legally require graduation and has no unmet express requirement
  if (!input.applicableLaw.requiresGraduation && input.applicableLaw.expressRequirements.length === 0) {
    return {
      trailId: 'TRILHA_REQUISITOS_LEGAIS_CARGO',
      status: 'CONFORME_NO_ESCOPO',
      jurisdiction: input.applicableLaw.jurisdiction,
      referenceDate: apptDate,
      legalBasis: input.applicableLaw.lawReference,
      summary: `A norma aplicável (${input.applicableLaw.lawReference}) não exige graduação superior nem requisitos adicionais expressos para o cargo "${input.applicableLaw.roleTitle}".`,
      conclusiveFraudAssertion: false,
      requiresLegalReview: Boolean(input.applicableLaw.interpretiveAmbiguityNote),
      findings: [
        {
          code: 'ROLE_NO_GRADUATION_REQUIRED',
          status: 'CONFORME_NO_ESCOPO',
          detail: `Cargo "${input.applicableLaw.roleTitle}" sem exigência legal expressa de graduação segundo ${input.applicableLaw.lawReference}.`,
          evidenceRefs: input.appointment.evidenceRefs,
        },
      ],
      limitations: ['Avaliação restrita aos requisitos expressos da lei consolidada informada.'],
      diligences: [],
    };
  }

  let hasDocumentedIncompatibility = false;
  let hasMissingDoc = false;
  let hasInterpretiveQuestion = Boolean(input.applicableLaw.interpretiveAmbiguityNote?.trim());

  if (input.applicableLaw.interpretiveAmbiguityNote?.trim()) {
    findings.push({
      code: 'ROLE_INTERPRETIVE_AMBIGUITY',
      status: 'REVISAO_JURIDICA_NECESSARIA',
      detail: `Questão interpretativa na norma (${input.applicableLaw.lawReference}): ${input.applicableLaw.interpretiveAmbiguityNote}`,
      evidenceRefs: input.appointment.evidenceRefs,
    });
  }

  const evidenceByReq = new Map(
    input.evidences.map((e) => [e.requirementLabel.trim().toLowerCase(), e])
  );

  // Defect Graduação: when requiresGraduation=true and expressRequirements is empty,
  // synthesize the mandatory graduation requirement so missing evidence NEVER yields CONFORME_NO_ESCOPO.
  const effectiveRequirements =
    input.applicableLaw.expressRequirements.length > 0
      ? input.applicableLaw.expressRequirements
      : input.applicableLaw.requiresGraduation
        ? ['Graduação superior exigida pela norma do cargo']
        : [];

  for (const reqLabel of effectiveRequirements) {
    const normalizedReq = reqLabel.trim().toLowerCase();
    const matched =
      evidenceByReq.get(normalizedReq) ??
      (input.applicableLaw.requiresGraduation &&
      input.applicableLaw.expressRequirements.length === 0
        ? input.evidences.find((e) =>
            /gradua|superior|diploma|bacharel|licenciatur/i.test(e.requirementLabel)
          )
        : undefined);
    if (!matched || matched.evidenceStatus === 'missing_document') {
      hasMissingDoc = true;
      findings.push({
        code: 'ROLE_REQUIREMENT_DOCUMENT_MISSING',
        status: 'DESCONHECIDO_DOCUMENTO_AUSENTE',
        detail: `Requisito expresso "${reqLabel}": documentação comprobatória ausente nos autos — classificado como DESCONHECIDO (não caracteriza incompatibilidade documentada).`,
        evidenceRefs: matched?.documentRef ? [matched.documentRef] : [],
      });
    } else if (matched.evidenceStatus === 'documented_not_met') {
      hasDocumentedIncompatibility = true;
      findings.push({
        code: 'ROLE_REQUIREMENT_DOCUMENTED_INCOMPATIBILITY',
        status: 'INCOMPATIBILIDADE_DOCUMENTADA',
        detail: `Requisito expresso "${reqLabel}": incompatibilidade documentalmente registrada (${matched.notes ?? 'conforme documento anexado'}). Requer revisão jurídica.`,
        evidenceRefs: matched.documentRef ? [matched.documentRef] : [],
      });
    } else if (matched.evidenceStatus === 'interpretive_question') {
      hasInterpretiveQuestion = true;
      findings.push({
        code: 'ROLE_REQUIREMENT_INTERPRETIVE_REVIEW',
        status: 'REVISAO_JURIDICA_NECESSARIA',
        detail: `Requisito expresso "${reqLabel}": enquadramento sujeito a interpretação jurídica (${matched.notes ?? 'equivalência ou experiência notória'}).`,
        evidenceRefs: matched.documentRef ? [matched.documentRef] : [],
      });
    } else {
      findings.push({
        code: 'ROLE_REQUIREMENT_MET',
        status: 'CONFORME_NO_ESCOPO',
        detail: `Requisito expresso "${reqLabel}": comprovado documentalmente (${matched.documentRef ?? 'documento anexado'}).`,
        evidenceRefs: matched.documentRef ? [matched.documentRef] : [],
      });
    }
  }

  const status: PublicIntegrityTrailStatus = hasDocumentedIncompatibility
    ? 'INCOMPATIBILIDADE_DOCUMENTADA'
    : hasInterpretiveQuestion
      ? 'REVISAO_JURIDICA_NECESSARIA'
      : hasMissingDoc
        ? 'DESCONHECIDO_DOCUMENTO_AUSENTE'
        : 'CONFORME_NO_ESCOPO';

  return {
    trailId: 'TRILHA_REQUISITOS_LEGAIS_CARGO',
    status,
    jurisdiction: input.applicableLaw.jurisdiction,
    referenceDate: apptDate,
    legalBasis: [
      input.applicableLaw.lawReference,
      ...input.applicableLaw.amendmentsApplied,
    ].join('; '),
    summary:
      status === 'INCOMPATIBILIDADE_DOCUMENTADA'
        ? 'Incompatibilidade documentalmente registrada frente a requisito expresso da lei do cargo (distinta de mera ausência documental; requer revisão jurídica).'
        : status === 'DESCONHECIDO_DOCUMENTO_AUSENTE'
          ? 'Documentação comprobatória de formação/requisito ausente: estado DESCONHECIDO (não presume descumprimento nem incompatibilidade).'
          : status === 'REVISAO_JURIDICA_NECESSARIA'
            ? 'Existem questões de interpretação normativa sobre os requisitos do cargo que exigem revisão jurídica.'
            : 'Requisitos expressos da norma aplicável comprovados ou não exigidos no escopo analisado.',
    conclusiveFraudAssertion: false,
    requiresLegalReview: hasDocumentedIncompatibility || hasInterpretiveQuestion,
    findings,
    limitations: [
      'Ausência de diploma ou certidão na base pública é tratada como DESCONHECIDO, nunca como irregularidade automática.',
      'Qualificação societária (QSA) nunca é convertida em grau de escolaridade.',
    ],
    diligences: hasMissingDoc
      ? ['Requisitar via LAI ou pasta funcional a documentação comprobatória dos requisitos expressos do cargo.']
      : [],
  };
}

/**
 * Parses an official Câmara dos Deputados daily personnel CSV/TSV export snapshot.
 * Explicitly records that the file is a daily point-in-time snapshot without pre-collection history
 * and does NOT represent municipal personnel coverage.
 */
export function parseCamaraDailyPersonnelSnapshot(params: {
  rawCsv: string;
  snapshotDate: string;
}): CamaraDailyPersonnelSnapshot {
  const dateCheck = validateIsoDate(params.snapshotDate);
  if (!dateCheck.valid) {
    throw new Error(dateCheck.reason ?? `Data de snapshot inválida: "${params.snapshotDate}".`);
  }
  const sha256 = crypto.createHash('sha256').update(params.rawCsv, 'utf8').digest('hex');
  const parsed = parseCsvTable(params.rawCsv);

  if (parsed.headers.length === 0 || parsed.rows.length === 0) {
    return {
      sourceSystem: 'Camara dos Deputados — Arquivo Diario de Funcionarios',
      coverageScope: 'camara_federal_diario',
      hasHistoricalChanges: false,
      snapshotDate: dateCheck.normalized!,
      sha256,
      recordCount: 0,
      rows: [],
      limitations: [
        'Arquivo diário da Câmara não contém histórico de alterações anteriores à data de coleta.',
        'Cobertura estritamente federal (Câmara dos Deputados); não cobre quadros municipais ou estaduais.',
      ],
    };
  }

  const headers = parsed.headers.map((h) => h.trim().toLowerCase());
  const findIdx = (patterns: string[]) =>
    headers.findIndex((h) => patterns.some((p) => h.includes(p)));

  const idxNome = findIdx(['nome', 'servidor', 'funcionario']);
  const idxCargo = findIdx(['cargo', 'funcao']);
  const idxLotacao = findIdx(['lotacao', 'orgao', 'gabinete', 'unidade']);
  const idxVinculo = findIdx(['vinculo', 'natureza', 'categoria', 'grupo']);

  const rows: CamaraPersonnelSnapshotRow[] = [];
  for (const cols of parsed.rows) {
    const nome = idxNome >= 0 ? cols[idxNome] ?? '' : cols[0] ?? '';
    if (!nome) continue;
    rows.push({
      nome,
      cargo: idxCargo >= 0 ? cols[idxCargo] ?? '' : cols[1] ?? '',
      lotacao: idxLotacao >= 0 ? cols[idxLotacao] ?? '' : cols[2] ?? '',
      vinculo: idxVinculo >= 0 ? cols[idxVinculo] ?? '' : cols[3] ?? 'nao_informado',
      dataColeta: dateCheck.normalized!,
    });
  }

  return {
    sourceSystem: 'Camara dos Deputados — Arquivo Diario de Funcionarios',
    coverageScope: 'camara_federal_diario',
    hasHistoricalChanges: false,
    snapshotDate: dateCheck.normalized!,
    sha256,
    recordCount: rows.length,
    rows,
    limitations: [
      `Snapshot pontual coletado em ${dateCheck.normalized}: a Câmara disponibiliza arquivo diário sem histórico de alterações; nenhum histórico anterior à coleta foi inferido.`,
      'Dados federais de pessoal da Câmara dos Deputados não representam cobertura de servidores municipais.',
    ],
  };
}
