export type AccessFailureCategory =
  | 'ok'
  | 'collector_error'
  | 'timeout'
  | 'automated_block'
  | 'origin_error';

export type ParticipationChannelStatus =
  | 'CANAL_VALIDO_ELETRONICO'
  | 'CANAL_VALIDO_SEM_EMAIL'
  | 'OCR_INSUFICIENTE'
  | 'INDISPONIBILIDADE_POS_PRAZO'
  | 'FALHA_TECNICA_COLETA'
  | 'SINAL_TRANSPARENCIA_REQUER_REVISAO_JURIDICA';

export interface BiddingDocumentRecord {
  documentType: 'aviso' | 'edital' | 'termo_referencia' | 'anexo' | 'retificacao';
  title: string;
  url: string | null;
  externalId: string | null;
  publishedAt: string | null;
  amendmentDates: string[];
  capturedAt: string;
  accessResult: AccessFailureCategory;
  httpStatus?: number | null;
  /** 0.0 to 1.0 extraction/OCR confidence score */
  ocrQualityScore: number | null;
  sha256?: string | null;
}

export interface ParticipationChannelInput {
  procurementId: string;
  applicableLegalRule: string;
  jurisdiction: string;
  /** Official proposal submission channel (separate from contact/clarifications/ombudsman) */
  proposalSubmissionChannel: {
    hasValidElectronicPortal: boolean;
    portalName: string | null;
    portalUrl: string | null;
    portalAccessDuringWindow: AccessFailureCategory | 'not_observed_during_window';
    portalAccessCapturedAt: string | null;
    emailSpecifiedForProposals: string | null;
    physicalDeliveryAllowed: boolean | null;
  };
  /** Institutional channels analyzed separately */
  institutionalChannels: {
    contactEmail: string | null;
    clarificationChannel: string | null;
    ombudsmanChannel: string | null;
  };
  schedule: {
    submissionDeadlineIso: string | null;
    openingDateTimeIso: string | null;
    timezone: string;
    calendarNotes?: string;
  };
  documents: BiddingDocumentRecord[];
  /** Explicit safeguard: NEXOFIS NEVER sends test emails or test proposals */
  activeProbingPerformed?: false;
}

export interface ParticipationChannelEvaluation {
  procurementId: string;
  status: ParticipationChannelStatus;
  applicableLegalRule: string;
  jurisdiction: string;
  /** Transparency assessment strictly separated from legal non-compliance conclusion */
  transparencyAssessment: {
    level: 'ADEQUADA' | 'PARCIAL' | 'NAO_VERIFICAVEL';
    summary: string;
    missingElements: string[];
  };
  legalNonComplianceConclusion: {
    automaticIrregularityDeclared: false;
    requiresHumanLegalReview: boolean;
    reason: string;
  };
  channelBreakdown: {
    proposalSubmission: string;
    institutionalContact: string;
    clarifications: string;
    ombudsman: string;
  };
  accessDiagnostics: Array<{
    target: string;
    category: AccessFailureCategory;
    capturedAt: string;
    provesHistoricalUnavailability: boolean;
    note: string;
  }>;
  ocrDiagnostics: {
    minOcrQualityScore: number | null;
    isInsufficientOcr: boolean;
    note: string;
  };
  activeProbingProhibited: true;
  limitations: string[];
  diligences: string[];
}

const MIN_ACCEPTABLE_OCR_SCORE = 0.65;

/**
 * Evaluates official procurement documents and effective participation channels.
 * Enforces strict investigative safeguards:
 *  - Proposal channel is separated from institutional contact, clarifications, and ombudsman.
 *  - Missing email is NOT an irregularity when a valid electronic bidding portal exists.
 *  - Current/post-deadline access failure NEVER proves historical unavailability during submission window.
 *  - Low OCR quality produces OCR_INSUFICIENTE without presuming missing clauses or email.
 *  - Distinguishes collector_error, timeout, automated_block, and origin_error.
 *  - Never sends test emails or test proposals.
 *  - Separates transparency assessment from legal non-compliance conclusion.
 */
export function evaluateParticipationChannels(
  input: ParticipationChannelInput
): ParticipationChannelEvaluation {
  const limitations: string[] = [
    'O NEXOFIS jamais envia e-mails de teste ou propostas fictícias para validar canais de participação.',
    'Avaliação de transparência documental é separada de conclusão jurídica sobre irregularidade ou restrição de competitividade.',
  ];
  const diligences: string[] = [];
  const missingElements: string[] = [];
  const accessDiagnostics: ParticipationChannelEvaluation['accessDiagnostics'] = [];

  // Inspect OCR/extraction quality across attached documents
  const ocrScores = input.documents
    .map((d) => d.ocrQualityScore)
    .filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
  const minOcrQualityScore = ocrScores.length > 0 ? Math.min(...ocrScores) : null;
  const isInsufficientOcr =
    minOcrQualityScore !== null && minOcrQualityScore < MIN_ACCEPTABLE_OCR_SCORE;

  const deadlineMs = input.schedule.submissionDeadlineIso
    ? Date.parse(input.schedule.submissionDeadlineIso)
    : Number.NaN;

  let postDeadlineUnavailabilityDetected = false;
  let technicalCollectorFailureDetected = false;

  // Check portal capture timing vs deadline
  const portalAccess = input.proposalSubmissionChannel.portalAccessDuringWindow;
  if (portalAccess !== 'ok' && portalAccess !== 'not_observed_during_window') {
    const captureMs = input.proposalSubmissionChannel.portalAccessCapturedAt
      ? Date.parse(input.proposalSubmissionChannel.portalAccessCapturedAt)
      : Number.NaN;
    const isAfterDeadline =
      Number.isFinite(deadlineMs) && Number.isFinite(captureMs) && captureMs > deadlineMs;
    if (isAfterDeadline) {
      postDeadlineUnavailabilityDetected = true;
    }
    if (
      portalAccess === 'collector_error' ||
      portalAccess === 'timeout' ||
      portalAccess === 'automated_block'
    ) {
      technicalCollectorFailureDetected = true;
    }
    accessDiagnostics.push({
      target: input.proposalSubmissionChannel.portalUrl || input.proposalSubmissionChannel.portalName || 'Portal eletrônico',
      category: portalAccess,
      capturedAt: input.proposalSubmissionChannel.portalAccessCapturedAt || 'N/D',
      provesHistoricalUnavailability: false,
      note: isAfterDeadline
        ? `Indisponibilidade (${portalAccess}) observada apenas APÓS o prazo de envio (${input.schedule.submissionDeadlineIso}); não comprova indisponibilidade histórica durante a janela licitatória.`
        : `Falha de acesso classificada como "${portalAccess}"; não constitui prova isolada de bloqueio histórico a licitantes.`,
    });
  }

  for (const doc of input.documents) {
    if (doc.accessResult !== 'ok') {
      const capMs = Date.parse(doc.capturedAt);
      const isAfterDeadline =
        Number.isFinite(deadlineMs) && Number.isFinite(capMs) && capMs > deadlineMs;
      if (isAfterDeadline) {
        postDeadlineUnavailabilityDetected = true;
      }
      if (
        doc.accessResult === 'collector_error' ||
        doc.accessResult === 'timeout' ||
        doc.accessResult === 'automated_block'
      ) {
        technicalCollectorFailureDetected = true;
      }
      accessDiagnostics.push({
        target: `${doc.documentType}: ${doc.title}`,
        category: doc.accessResult,
        capturedAt: doc.capturedAt,
        provesHistoricalUnavailability: false,
        note: isAfterDeadline
          ? `Erro de acesso (${doc.accessResult}) capturado após o prazo (${input.schedule.submissionDeadlineIso}) — não comprova ausência histórica do documento.`
          : `Erro de acesso ao documento classificado como "${doc.accessResult}".`,
      });
    }
  }

  if (!input.institutionalChannels.contactEmail) {
    missingElements.push('E-mail institucional de contato não identificado no extrato.');
  }
  if (!input.institutionalChannels.clarificationChannel) {
    missingElements.push('Canal de pedidos de esclarecimento/impugnação não identificado.');
  }
  if (!input.institutionalChannels.ombudsmanChannel) {
    missingElements.push('Canal de ouvidoria não identificado no extrato.');
  }

  // Determine overall status strictly respecting guardrails
  let status: ParticipationChannelStatus;
  let transparencyLevel: 'ADEQUADA' | 'PARCIAL' | 'NAO_VERIFICAVEL' = 'ADEQUADA';
  let transparencySummary: string;
  let requiresHumanLegalReview = false;
  let legalReason: string;

  if (isInsufficientOcr) {
    status = 'OCR_INSUFICIENTE';
    transparencyLevel = 'NAO_VERIFICAVEL';
    transparencySummary = `Qualidade de extração/OCR insuficiente (mínimo=${minOcrQualityScore?.toFixed(2)} < ${MIN_ACCEPTABLE_OCR_SCORE}): impossível atestar ausência de cláusula, portal ou e-mail.`;
    requiresHumanLegalReview = false;
    legalReason = 'Extração textual comprometida impede qualquer conclusão jurídica ou de transparência.';
    diligences.push('Obter PDF pesquisável original do edital/anexos ou realizar conferência visual manual.');
  } else if (postDeadlineUnavailabilityDetected) {
    status = 'INDISPONIBILIDADE_POS_PRAZO';
    transparencyLevel = 'NAO_VERIFICAVEL';
    transparencySummary =
      'Indisponibilidade observada somente após o encerramento do prazo de envio de propostas; não comprova indisponibilidade durante o período licitatório.';
    requiresHumanLegalReview = false;
    legalReason =
      'Erro de acesso posterior ao prazo não comprova restrição histórica à participação.';
    diligences.push(
      'Solicitar logs oficiais de disponibilidade do portal eletrônico e ata da sessão pública referentes ao período da licitação.'
    );
  } else if (technicalCollectorFailureDetected && !input.proposalSubmissionChannel.hasValidElectronicPortal) {
    status = 'FALHA_TECNICA_COLETA';
    transparencyLevel = 'NAO_VERIFICAVEL';
    transparencySummary =
      'Falha técnica de coleta (erro do coletor, timeout ou bloqueio automatizado) impediu a inspeção completa dos documentos/canais.';
    requiresHumanLegalReview = false;
    legalReason = 'Falha técnica de coleta não é atribuível ao órgão como irregularidade.';
    diligences.push('Repetir coleta com verificação manual no portal oficial.');
  } else if (
    input.proposalSubmissionChannel.hasValidElectronicPortal &&
    !input.proposalSubmissionChannel.emailSpecifiedForProposals
  ) {
    status = 'CANAL_VALIDO_SEM_EMAIL';
    transparencyLevel = missingElements.length > 0 ? 'PARCIAL' : 'ADEQUADA';
    transparencySummary = `Sistema eletrônico oficial de envio de propostas identificado (${input.proposalSubmissionChannel.portalName ?? 'portal eletrônico'}). Ausência de e-mail para envio de propostas NÃO caracteriza irregularidade.`;
    requiresHumanLegalReview = false;
    legalReason =
      'A existência de sistema eletrônico oficial válido para recepção de propostas afasta irregularidade por ausência de e-mail de envio.';
  } else if (input.proposalSubmissionChannel.hasValidElectronicPortal) {
    status = 'CANAL_VALIDO_ELETRONICO';
    transparencyLevel = missingElements.length > 0 ? 'PARCIAL' : 'ADEQUADA';
    transparencySummary = `Canal eletrônico oficial identificado (${input.proposalSubmissionChannel.portalName ?? 'portal eletrônico'}) com fuso ${input.schedule.timezone}.`;
    requiresHumanLegalReview = false;
    legalReason = 'Nenhum sinal de irregularidade de canal de participação no escopo verificado.';
  } else {
    status = 'SINAL_TRANSPARENCIA_REQUER_REVISAO_JURIDICA';
    transparencyLevel = 'PARCIAL';
    transparencySummary =
      'Canal oficial de envio de propostas não localizado de forma clara nos documentos extraídos.';
    requiresHumanLegalReview = true;
    legalReason = `Requer revisão jurídica sob ${input.applicableLegalRule} (${input.jurisdiction}) para distinguir falha de publicação/extração de eventual restrição à participação.`;
    diligences.push(
      'Verificar integralidade do processo administrativo, aviso no PNCP/Diário Oficial e comprovação de acesso efetivo dos licitantes.'
    );
  }

  return {
    procurementId: input.procurementId,
    status,
    applicableLegalRule: input.applicableLegalRule,
    jurisdiction: input.jurisdiction,
    transparencyAssessment: {
      level: transparencyLevel,
      summary: transparencySummary,
      missingElements,
    },
    legalNonComplianceConclusion: {
      automaticIrregularityDeclared: false,
      requiresHumanLegalReview,
      reason: legalReason,
    },
    channelBreakdown: {
      proposalSubmission: input.proposalSubmissionChannel.hasValidElectronicPortal
        ? `Portal eletrônico: ${input.proposalSubmissionChannel.portalName ?? 'informado'} (${input.proposalSubmissionChannel.portalUrl ?? 'URL não informada'})`
        : input.proposalSubmissionChannel.emailSpecifiedForProposals
          ? `E-mail declarado para propostas: ${input.proposalSubmissionChannel.emailSpecifiedForProposals}`
          : 'Não localizado nos documentos analisados',
      institutionalContact: input.institutionalChannels.contactEmail ?? 'Não localizado',
      clarifications: input.institutionalChannels.clarificationChannel ?? 'Não localizado',
      ombudsman: input.institutionalChannels.ombudsmanChannel ?? 'Não localizado',
    },
    accessDiagnostics,
    ocrDiagnostics: {
      minOcrQualityScore,
      isInsufficientOcr,
      note: isInsufficientOcr
        ? `Qualidade OCR abaixo do piso mínimo (${MIN_ACCEPTABLE_OCR_SCORE}).`
        : minOcrQualityScore !== null
          ? `Qualidade OCR mínima observada: ${minOcrQualityScore.toFixed(2)}.`
          : 'Pontuação de qualidade OCR não informada.',
    },
    activeProbingProhibited: true,
    limitations,
    diligences,
  };
}

export interface EditalChannelAuditAlert {
  code:
    | 'OMISSAO_EMAIL_INSTITUCIONAL'
    | 'AVISO_TELEFONE_AUSENTE'
    | 'SINAL_CRITICO_COMPETITIVIDADE'
    | 'OCR_INSUFICIENTE_EDITAL';
  severity: 'critico' | 'aviso';
  message: string;
  legalBasis: string[];
}

export interface EditalChannelAuditResult {
  status: 'CONFORME' | 'ATENCAO_TRANSPARENCIA' | 'SINAL_IRREGULARIDADE_REVISAO_JURIDICA' | 'OCR_INSUFICIENTE';
  isElectronicOrDispensa: boolean;
  emailsFound: string[];
  filteredOutSystemEmails: string[];
  phonesFound: string[];
  platformsFound: string[];
  alerts: EditalChannelAuditAlert[];
  legalReferences: string[];
  /** Formal structured evaluation reusing the core participation channel guardrails */
  channelEvaluation: ParticipationChannelEvaluation;
}

const IGNORED_TOOL_EMAIL_DOMAINS = [
  'adobe.com',
  'microsoft.com',
  'google.com',
  'oracle.com',
  'w3.org',
  'example.com',
  'libreoffice.org',
];

/**
 * Automated communication-channel audit over extracted PDF/edital text (RegEx + contextual rules).
 * Extracts institutional emails (excluding software vendor domains like adobe.com/microsoft.com),
 * Brazilian phone numbers, and official electronic bidding portals, while enforcing NEXOFIS
 * safeguards (OCR quality threshold, separation between valid electronic portal vs email omission,
 * zero active probing, and human legal review before declaring illegality).
 */
export function auditEditalCommunicationChannels(
  text: string,
  options?: {
    procurementId?: string;
    ocrQualityScore?: number | null;
    applicableLegalRule?: string;
    jurisdiction?: string;
  }
): EditalChannelAuditResult {
  const safeText = text ?? '';
  const lower = safeText.toLowerCase();
  const ocrScore = options?.ocrQualityScore ?? null;

  const emailRegex = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g;
  const phoneRegex = /(?<!\d)(?:\(?\d{2}\)?\s*)?(?:9\d{4}|\d{4})[-\s]\d{4}(?!\d)/g;
  const platformRegex =
    /https?:\/\/(?:www\.)?(?:gov\.br\/compras(?:net)?|comprasnet|compras\.gov|bll|bnc|portaldecompraspublicas|portaldecompras|licitanet|licitacoes-e|pncp\.gov\.br|novobbmnet|comprasbr)[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=-]*/gi;

  const rawEmails = Array.from(new Set(safeText.match(emailRegex) ?? []));
  const filteredOutSystemEmails: string[] = [];
  const emailsFound: string[] = [];

  for (const email of rawEmails) {
    const lowerEmail = email.toLowerCase().replace(/[.,;:]+$/, '');
    if (IGNORED_TOOL_EMAIL_DOMAINS.some((dom) => lowerEmail.endsWith(`@${dom}`) || lowerEmail.endsWith(`.${dom}`))) {
      filteredOutSystemEmails.push(lowerEmail);
    } else {
      emailsFound.push(lowerEmail);
    }
  }

  const phonesFound = Array.from(
    new Set((safeText.match(phoneRegex) ?? []).map((p) => p.trim()))
  ).filter((p) => p.replace(/\D/g, '').length >= 8 && p.replace(/\D/g, '').length <= 11);

  const platformsFound = Array.from(
    new Set((safeText.match(platformRegex) ?? []).map((u) => u.replace(/[.,;)]+$/, '')))
  );

  const isElectronicOrDispensa =
    /\bdispensa\b/i.test(lower) ||
    /\beletr[oô]nic[oa]\b/i.test(lower) ||
    /\bpreg[aã]o\b/i.test(lower);

  const legalReferences = [
    'Art. 5º da Lei nº 14.133/2021 (princípios da publicidade e competitividade)',
    'Lei de Acesso à Informação — LAI (Lei nº 12.527/2011, transparência ativa)',
    'Programa Nacional de Transparência Pública — PNTP (Atricon, disponibilização integral de editais)',
  ];

  const alerts: EditalChannelAuditAlert[] = [];

  const ocrInsufficient = ocrScore !== null && ocrScore < MIN_ACCEPTABLE_OCR_SCORE;
  if (ocrInsufficient) {
    alerts.push({
      code: 'OCR_INSUFICIENTE_EDITAL',
      severity: 'aviso',
      message: `Qualidade OCR (${ocrScore.toFixed(2)}) abaixo do piso mínimo (${MIN_ACCEPTABLE_OCR_SCORE}): não é possível presumir ausência de e-mail, telefone ou plataforma no edital.`,
      legalBasis: ['Salvaguarda forense NEXOFIS — insuficiência de extração textual'],
    });
  } else {
    if (emailsFound.length === 0) {
      alerts.push({
        code: 'OMISSAO_EMAIL_INSTITUCIONAL',
        severity: platformsFound.length > 0 ? 'aviso' : 'critico',
        message:
          platformsFound.length > 0
            ? 'TRANSPARÊNCIA PARCIAL: Nenhum e-mail institucional identificado no texto para pedidos de esclarecimento, embora haja plataforma eletrônica oficial indicada.'
            : 'OMISSÃO CRÍTICA: Nenhum e-mail institucional identificado para envio de propostas ou pedidos de esclarecimento.',
        legalBasis: legalReferences,
      });
    }

    if (phonesFound.length === 0) {
      alerts.push({
        code: 'AVISO_TELEFONE_AUSENTE',
        severity: 'aviso',
        message: 'AVISO: Nenhum contato telefônico institucional informado no documento.',
        legalBasis: [legalReferences[1], legalReferences[2]],
      });
    }

    if (isElectronicOrDispensa && platformsFound.length === 0 && emailsFound.length === 0) {
      alerts.push({
        code: 'SINAL_CRITICO_COMPETITIVIDADE',
        severity: 'critico',
        message:
          'SINAL CRÍTICO À AMPLA CONCORRÊNCIA: Edital eletrônico ou dispensa sem indicação de plataforma oficial de licitação ou e-mail institucional para envio/esclarecimentos. Requer revisão jurídica humana.',
        legalBasis: legalReferences,
      });
    }
  }

  const channelEvaluation = evaluateParticipationChannels({
    procurementId: options?.procurementId ?? 'DOC-EDITAL',
    applicableLegalRule: options?.applicableLegalRule ?? 'Lei nº 14.133/2021 (Art. 5º) · LAI · PNTP (Atricon)',
    jurisdiction: options?.jurisdiction ?? 'Brasil — Esfera Municipal/Estadual/Federal',
    proposalSubmissionChannel: {
      hasValidElectronicPortal: platformsFound.length > 0,
      portalName: platformsFound.length > 0 ? new URL(platformsFound[0]).hostname : null,
      portalUrl: platformsFound[0] ?? null,
      portalAccessDuringWindow: 'not_observed_during_window',
      portalAccessCapturedAt: null,
      emailSpecifiedForProposals: emailsFound[0] ?? null,
      physicalDeliveryAllowed: /\bpresencial\b/i.test(lower) ? true : null,
    },
    institutionalChannels: {
      contactEmail: emailsFound[0] ?? null,
      clarificationChannel:
        emailsFound[0] ?? (platformsFound[0] ? `Portal ${platformsFound[0]}` : null),
      ombudsmanChannel: /\bouvidoria\b/i.test(lower) ? 'Mencionada no documento' : null,
    },
    schedule: {
      submissionDeadlineIso: null,
      openingDateTimeIso: null,
      timezone: 'America/Sao_Paulo',
    },
    documents: [
      {
        documentType: 'edital',
        title: options?.procurementId ?? 'Documento analisado',
        url: platformsFound[0] ?? null,
        externalId: null,
        publishedAt: null,
        amendmentDates: [],
        capturedAt: new Date().toISOString(),
        accessResult: 'ok',
        ocrQualityScore: ocrScore,
      },
    ],
    activeProbingPerformed: false,
  });

  let status: EditalChannelAuditResult['status'];
  if (ocrInsufficient) {
    status = 'OCR_INSUFICIENTE';
  } else if (alerts.some((a) => a.severity === 'critico')) {
    status = 'SINAL_IRREGULARIDADE_REVISAO_JURIDICA';
  } else if (alerts.length > 0) {
    status = 'ATENCAO_TRANSPARENCIA';
  } else {
    status = 'CONFORME';
  }

  return {
    status,
    isElectronicOrDispensa,
    emailsFound,
    filteredOutSystemEmails,
    phonesFound,
    platformsFound,
    alerts,
    legalReferences,
    channelEvaluation,
  };
}

