/**
 * NEXOFIS — Secondary Supplier Legal Name Resolver
 *
 * When a PNCP publication omits `nomeRazaoSocialFornecedor` or uses a placeholder
 * like "Fornecedor não divulgado na publicação (PNCP)", this module resolves the
 * real company legal name (`razao_social`) through a deterministic multi-tier lookup:
 *   1. Local company QSA database (`supplier_qsa_cache` in SQLite)
 *   2. Local contracts index (other stored contracts sharing the same valid supplier CNPJ)
 *   3. Secondary external CNPJ lookup (BrasilAPI / Receita Federal) with bounded concurrency
 *
 * Never invents names and never attributes the contracting organ's own CNPJ as the supplier.
 */

import {
  formatCnpjValue,
  isCnpjFormat,
  isValidCnpj,
  normalizeCnpj,
} from '@nexofis/shared/lib/cnpj';
import type { SupplierQsaRecord } from '@nexofis/shared/lib/partnerNetworkGraph';
import type { ContractRecord } from '@nexofis/shared/types/audit';

const MISSING_SUPPLIER_PATTERNS: RegExp[] = [
  /^fornecedor\s+n[aã]o\s+divulgad/i,
  /^fornecedor\s+n[aã]o\s+informad/i,
  /^fornecedor\s+cnpj\b/i,
  /^edital\s+publicado\b/i,
  /^n[aã]o\s+informad/i,
  /^n[aã]o\s+divulgad/i,
  /^desconhecid/i,
  /^sem\s+fornecedor/i,
];

export function isMissingSupplierName(raw: string | null | undefined): boolean {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed || trimmed.length < 2) return true;
  return MISSING_SUPPLIER_PATTERNS.some((rx) => rx.test(trimmed));
}

export function extractOrganCnpjFromEntityId(entityId: string | null | undefined): string {
  const match = /^ENT-([0-9A-Z]{14})-/i.exec(String(entityId ?? '').trim());
  return match ? normalizeCnpj(match[1]) : '';
}

function isValidDistinctSupplierCnpj(raw: string | null | undefined, organCnpj: string): string {
  const clean = normalizeCnpj(raw);
  if (!clean || /^0+$/.test(clean)) return '';
  if (!isCnpjFormat(clean) || !isValidCnpj(clean)) return '';
  if (organCnpj && clean === organCnpj) return '';
  return clean;
}

/**
 * Recovers a valid supplier CNPJ from the contract's supplier record, sourceRecords,
 * or explicit CONTRATADA/FORNECEDOR excerpts in attached documents — strictly excluding
 * the contracting organ's own CNPJ.
 */
export function extractCandidateSupplierCnpj(contract: ContractRecord): string {
  const organCnpj = extractOrganCnpjFromEntityId(contract.entityId);

  const direct = isValidDistinctSupplierCnpj(contract.supplier?.cnpj, organCnpj);
  if (direct) return direct;

  for (const src of contract.sourceRecords ?? []) {
    const fromSource = isValidDistinctSupplierCnpj(src.reportedSupplierCnpj, organCnpj);
    if (fromSource) return fromSource;
  }

  for (const doc of contract.documents ?? []) {
    for (const page of doc.pages ?? []) {
      const text = page.text ?? '';
      const labeledMatch =
        /(?:CONTRATADA|FORNECEDOR|EMPRESA\s+VENCEDORA|FAVORECIDO)[^0-9]{0,80}(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})/i.exec(
          text
        );
      if (labeledMatch) {
        const fromDoc = isValidDistinctSupplierCnpj(labeledMatch[1], organCnpj);
        if (fromDoc) return fromDoc;
      }
    }
  }

  return '';
}

export interface SupplierResolverDeps {
  getLocalCompanyByCnpj: (cnpj: string) => SupplierQsaRecord | null;
  getKnownContracts: () => ContractRecord[];
  fetchCompanyByCnpj?: (cnpj: string) => Promise<{
    record: SupplierQsaRecord | null;
    fromCache: boolean;
    error?: string;
  }>;
  onContractEnriched?: (contract: ContractRecord) => void;
  maxExternalLookups?: number;
}

export interface SupplierResolutionResult {
  contracts: ContractRecord[];
  resolvedCount: number;
  resolvedFromLocalDb: number;
  resolvedFromExternalCnpj: number;
}

function applyCompanyRecordToContract(
  contract: ContractRecord,
  cnpj: string,
  company: SupplierQsaRecord,
  provenanceLabel: string
): ContractRecord {
  const existing = contract.supplier;
  const enrichedLegalName = company.legalName.trim();
  const hasRealName = !isMissingSupplierName(enrichedLegalName);

  return {
    ...contract,
    supplier: {
      ...existing,
      cnpj,
      legalName: hasRealName ? enrichedLegalName : existing.legalName,
      openingDate: existing.openingDate || company.openingDate || '',
      registrationStatus:
        existing.registrationStatus && existing.registrationStatus !== 'DESCONHECIDA'
          ? existing.registrationStatus
          : ((company.registrationStatus as ContractRecord['supplier']['registrationStatus']) ||
            'DESCONHECIDA'),
      primaryCnaeCode: existing.primaryCnaeCode || company.primaryCnaeCode || '',
      primaryCnaeDescription:
        existing.primaryCnaeDescription &&
        existing.primaryCnaeDescription !== 'Não consultado na RFB'
          ? existing.primaryCnaeDescription
          : company.primaryCnaeDescription || existing.primaryCnaeDescription,
      shareCapital: existing.shareCapital > 0 ? existing.shareCapital : company.shareCapital || 0,
      municipality: existing.municipality || company.municipality || '',
      uf: existing.uf || company.uf || '',
      shareholders:
        existing.shareholders && existing.shareholders.length > 0
          ? existing.shareholders
          : (company.shareholders ?? []).map((sh) => ({
              name: sh.name,
              role: sh.role,
              entryDate: sh.entryDate,
              maskedCpfCnpj: sh.maskedDocument ?? '',
            })),
      dataProvenance: provenanceLabel,
    },
  };
}

export async function resolveContractsSupplierNames(
  contracts: ContractRecord[],
  deps: SupplierResolverDeps
): Promise<SupplierResolutionResult> {
  if (contracts.length === 0) {
    return {
      contracts: [],
      resolvedCount: 0,
      resolvedFromLocalDb: 0,
      resolvedFromExternalCnpj: 0,
    };
  }

  // Build fast local CNPJ -> legalName index from all known contracts
  const localContractNameByCnpj = new Map<string, string>();
  for (const c of [...deps.getKnownContracts(), ...contracts]) {
    const organCnpj = extractOrganCnpjFromEntityId(c.entityId);
    const cleanCnpj = isValidDistinctSupplierCnpj(c.supplier?.cnpj, organCnpj);
    if (!cleanCnpj) continue;
    const name = String(c.supplier?.legalName ?? '').trim();
    if (!isMissingSupplierName(name) && !localContractNameByCnpj.has(cleanCnpj)) {
      localContractNameByCnpj.set(cleanCnpj, name);
    }
  }

  // First pass: resolve from local company QSA DB and local contracts index; collect remaining valid CNPJs
  const maxExternal = Math.max(0, deps.maxExternalLookups ?? 8);
  const cnpjsNeedingExternal = new Set<string>();
  const localResolvedCache = new Map<
    string,
    { company?: SupplierQsaRecord; fallbackName?: string; provenance: string }
  >();

  const candidateCnpjByIndex = new Map<number, string>();

  for (let i = 0; i < contracts.length; i += 1) {
    const c = contracts[i];
    if (!isMissingSupplierName(c.supplier?.legalName)) continue;

    const cnpj = extractCandidateSupplierCnpj(c);
    if (!cnpj) continue;
    candidateCnpjByIndex.set(i, cnpj);

    if (localResolvedCache.has(cnpj)) continue;

    // Tier 1: Local company QSA database
    const qsa = deps.getLocalCompanyByCnpj(cnpj);
    if (qsa && !isMissingSupplierName(qsa.legalName)) {
      localResolvedCache.set(cnpj, {
        company: qsa,
        provenance: 'Base Cadastral Local (QSA / Receita Federal)',
      });
      continue;
    }

    // Tier 2: Local contracts index
    const knownName = localContractNameByCnpj.get(cnpj);
    if (knownName) {
      localResolvedCache.set(cnpj, {
        fallbackName: knownName,
        provenance: 'Base Local de Contratos (CNPJ vinculado)',
      });
      continue;
    }

    // Tier 3: Queue for bounded external CNPJ lookup (BrasilAPI / RFB)
    if (deps.fetchCompanyByCnpj && /^\d{14}$/.test(cnpj) && cnpjsNeedingExternal.size < maxExternal) {
      cnpjsNeedingExternal.add(cnpj);
    }
  }

  // Execute external CNPJ lookups concurrently (bounded by maxExternal)
  const externalResolvedByCnpj = new Map<string, SupplierQsaRecord>();
  if (deps.fetchCompanyByCnpj && cnpjsNeedingExternal.size > 0) {
    const fetcher = deps.fetchCompanyByCnpj;
    const lookups = await Promise.all(
      Array.from(cnpjsNeedingExternal).map(async (cnpj) => {
        try {
          const res = await fetcher(cnpj);
          if (res.record && !isMissingSupplierName(res.record.legalName)) {
            return { cnpj, record: res.record };
          }
          return null;
        } catch {
          return null;
        }
      })
    );
    for (const item of lookups) {
      if (item) {
        externalResolvedByCnpj.set(item.cnpj, item.record);
      }
    }
  }

  let resolvedCount = 0;
  let resolvedFromLocalDb = 0;
  let resolvedFromExternalCnpj = 0;

  const updatedContracts = contracts.map((c, idx) => {
    if (!isMissingSupplierName(c.supplier?.legalName)) return c;

    const cnpj = candidateCnpjByIndex.get(idx) ?? '';

    if (cnpj) {
      const localMatch = localResolvedCache.get(cnpj);
      if (localMatch?.company) {
        const enriched = applyCompanyRecordToContract(c, cnpj, localMatch.company, localMatch.provenance);
        resolvedCount += 1;
        resolvedFromLocalDb += 1;
        deps.onContractEnriched?.(enriched);
        return enriched;
      }
      if (localMatch?.fallbackName) {
        const enriched: ContractRecord = {
          ...c,
          supplier: {
            ...c.supplier,
            cnpj,
            legalName: localMatch.fallbackName,
            dataProvenance: localMatch.provenance,
          },
        };
        resolvedCount += 1;
        resolvedFromLocalDb += 1;
        deps.onContractEnriched?.(enriched);
        return enriched;
      }

      const externalCompany = externalResolvedByCnpj.get(cnpj);
      if (externalCompany) {
        const enriched = applyCompanyRecordToContract(
          c,
          cnpj,
          externalCompany,
          'Receita Federal via BrasilAPI (Consulta Secundária por CNPJ)'
        );
        resolvedCount += 1;
        resolvedFromExternalCnpj += 1;
        deps.onContractEnriched?.(enriched);
        return enriched;
      }

      // Valid CNPJ exists, but external lookup was temporarily unavailable
      const fallbackLabel = `Empresa CNPJ ${formatCnpjValue(cnpj)}`;
      if (c.supplier.legalName !== fallbackLabel || c.supplier.cnpj !== cnpj) {
        const enriched: ContractRecord = {
          ...c,
          supplier: {
            ...c.supplier,
            cnpj,
            legalName: fallbackLabel,
          },
        };
        deps.onContractEnriched?.(enriched);
        return enriched;
      }
      return c;
    }

    // No supplier CNPJ exists at all: upgrade legacy "Fornecedor não divulgado..." label on editais
    // to an honest procedural status instead of a generic "não divulgado" placeholder
    if (/^fornecedor\s+n[aã]o\s+divulgad/i.test(String(c.supplier?.legalName ?? '').trim())) {
      const honestLabel = 'Edital publicado — fornecedor ainda não homologado no PNCP';
      const upgraded: ContractRecord = {
        ...c,
        supplier: {
          ...c.supplier,
          legalName: honestLabel,
        },
      };
      deps.onContractEnriched?.(upgraded);
      return upgraded;
    }

    return c;
  });

  return {
    contracts: updatedContracts,
    resolvedCount,
    resolvedFromLocalDb,
    resolvedFromExternalCnpj,
  };
}
