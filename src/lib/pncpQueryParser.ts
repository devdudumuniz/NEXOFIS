export interface ParsedContractCode {
  raw: string;
  prefix?: string;
  modalityHint?:
    | 'Inexigibilidade'
    | 'Dispensa de Licitação'
    | 'Pregão Eletrônico'
    | 'Concorrência'
    | 'Credenciamento';
  modalityCode?: number;
  numberCore: string;
  numberNumeric: string;
  year?: string;
  unitSuffix?: string;
  unitHint?: string;
  normalizedNumber: string;
}

export interface ParsedPncpUrl {
  orgaoCnpj?: string;
  year?: string;
  sequential?: string;
  sourceHost?: string;
}

const PREFIX_MAP: Record<
  string,
  {
    modalityHint: NonNullable<ParsedContractCode['modalityHint']>;
    modalityCode: number;
  }
> = {
  IN: { modalityHint: 'Inexigibilidade', modalityCode: 9 },
  INEX: { modalityHint: 'Inexigibilidade', modalityCode: 9 },
  INEXIG: { modalityHint: 'Inexigibilidade', modalityCode: 9 },
  DL: { modalityHint: 'Dispensa de Licitação', modalityCode: 8 },
  DISP: { modalityHint: 'Dispensa de Licitação', modalityCode: 8 },
  DISPENSA: { modalityHint: 'Dispensa de Licitação', modalityCode: 8 },
  PE: { modalityHint: 'Pregão Eletrônico', modalityCode: 6 },
  PP: { modalityHint: 'Pregão Eletrônico', modalityCode: 7 },
  PREGAO: { modalityHint: 'Pregão Eletrônico', modalityCode: 6 },
  CC: { modalityHint: 'Concorrência', modalityCode: 4 },
  CP: { modalityHint: 'Concorrência', modalityCode: 4 },
  CONC: { modalityHint: 'Concorrência', modalityCode: 4 },
  CR: { modalityHint: 'Credenciamento', modalityCode: 12 },
  CRED: { modalityHint: 'Credenciamento', modalityCode: 12 },
};

const UNIT_SUFFIX_MAP: Record<string, string> = {
  FMS: 'Fundo Municipal de Saúde',
  SMS: 'Secretaria Municipal de Saúde',
  FMAS: 'Fundo Municipal de Assistência Social',
  FME: 'Fundo Municipal de Educação',
  SME: 'Secretaria Municipal de Educação',
  SEDUC: 'Secretaria Municipal de Educação',
  PM: 'Prefeitura Municipal',
  PMBC: 'Prefeitura Municipal',
  CM: 'Câmara Municipal',
  SAAE: 'Serviço Autônomo de Água e Esgoto',
};

/**
 * Safely extracts PNCP identifiers from an official .gov.br URL without
 * performing any outbound network fetch (prevents SSRF).
 */
export function parsePncpUrlFromQuery(raw: string): ParsedPncpUrl | null {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    const allowedHost =
      parsed.hostname === 'pncp.gov.br' ||
      parsed.hostname.endsWith('.pncp.gov.br') ||
      parsed.hostname.endsWith('.gov.br');
    if (!allowedHost) return null;

    const pathMatch = parsed.pathname.match(
      /(\d{14})(?:\/(?:compras|contratos|editais))?\/(\d{4})\/(\d{1,6})/i
    );
    if (pathMatch) {
      return {
        orgaoCnpj: pathMatch[1],
        year: pathMatch[2],
        sequential: String(Number(pathMatch[3])),
        sourceHost: parsed.hostname,
      };
    }

    const cnpjMatch = trimmed.match(/(\d{14})/);
    const yearMatch = trimmed.match(/\b(202[0-9])\b/);
    if (cnpjMatch) {
      return {
        orgaoCnpj: cnpjMatch[1],
        year: yearMatch?.[1],
        sourceHost: parsed.hostname,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parses municipal Brazilian contract/process identifiers such as:
 * - "IN012/2026FMS"
 * - "IN 012/2026-FMS"
 * - "DL-035/2026"
 * - "PE 012/2026"
 * - "123/2026"
 */
export function parseBrazilianContractCode(raw: string): ParsedContractCode | null {
  const trimmed = raw.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed)) return null;

  // Match optional modality prefix, number, /year (or -year), and optional organ/fund suffix
  const match = trimmed.match(
    /\b([A-Za-z]{2,8})?[\s\-._]*(\d{1,6})\s*[\/\-]\s*(20\d{2})(?:[\s\-._]*([A-Za-z]{2,10}))?\b/
  );
  if (!match) return null;

  const rawPrefix = match[1]?.toUpperCase();
  const numberCore = match[2];
  const numberNumeric = String(Number(numberCore));
  const year = match[3];
  const rawSuffix = match[4]?.toUpperCase();

  const prefixMeta = rawPrefix ? PREFIX_MAP[rawPrefix] : undefined;
  const unitHint = rawSuffix ? UNIT_SUFFIX_MAP[rawSuffix] : undefined;

  return {
    raw: trimmed,
    prefix: rawPrefix,
    modalityHint: prefixMeta?.modalityHint,
    modalityCode: prefixMeta?.modalityCode,
    numberCore,
    numberNumeric,
    year,
    unitSuffix: rawSuffix,
    unitHint,
    normalizedNumber: `${numberCore.padStart(3, '0')}/${year}`,
  };
}

/**
 * Extracts normalized numeric/year comparison to detect related contracts in the same
 * municipality when an exact municipal code (e.g. IN012/2026FMS) is not indexed verbatim.
 */
export function isRelatedContractNumber(
  contractNumber: string,
  parsed: ParsedContractCode,
  contractYear?: number
): boolean {
  if (parsed.year && contractYear && String(contractYear) !== parsed.year) {
    return false;
  }

  const normalized = contractNumber.trim().toUpperCase();
  const numMatch = normalized.match(/(\d{1,6})(?:\s*[\/\-]\s*(20\d{2}))?/);
  if (!numMatch) return false;

  const candidateNum = String(Number(numMatch[1]));
  const candidateYear = numMatch[2];
  if (candidateYear && parsed.year && candidateYear !== parsed.year) {
    return false;
  }

  return candidateNum === parsed.numberNumeric;
}
