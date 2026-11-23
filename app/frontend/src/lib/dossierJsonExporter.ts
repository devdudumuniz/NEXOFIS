import type {
  ContractRecord,
  EvaluatedContract,
  FindingReviewRecord,
  RiskAssessment,
  SavedDossierSnapshot,
} from '@nexofis/shared/types/audit';
import { sha256HexSync } from '@nexofis/shared/lib/hash';
import { mapContractToOCDS } from '@nexofis/shared/lib/ocdsMapper';

export interface NexofisDossierExportOptions {
  analystNote?: string;
  reviews?: FindingReviewRecord[];
  archivedSnapshot?: SavedDossierSnapshot | null;
  exportedAt?: string;
}

export interface NexofisDossierArchivePayload {
  archiveMetadata: {
    contractId: string;
    contractNumber: string;
    pncpControlNumber?: string;
    municipalityIbge: string;
    municipalityName: string;
    uf: string;
    analystNote: string;
    archivedSnapshotId?: string;
    archivedSnapshotSavedAt?: string;
    archivedSnapshotDigest?: string;
    originalRiskScore: number;
    effectiveRiskScore: number;
    dismissedFindingCount: number;
    indicatorCount: number;
    evidenceCount: number;
    documentCount: number;
    sourceRecordCount: number;
  };
  contract: ContractRecord;
  forensicAssessment: RiskAssessment;
  auditorReviews: FindingReviewRecord[];
  ocdsRelease: ReturnType<typeof mapContractToOCDS>;
}

export interface NexofisDossierExportPackage {
  schema: 'nexofis.audit-dossier.v1';
  exportedAt: string;
  softwareLicense: 'AGPL-3.0-only';
  publicDataNotice: string;
  integrity: {
    algorithm: 'SHA-256';
    canonicalization: 'stable-json-v1';
    contentSha256: string;
  };
  payload: NexofisDossierArchivePayload;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function computeDismissedFindingIds(reviews: FindingReviewRecord[]): Set<string> {
  const dismissed = new Set<string>();
  for (const rev of reviews) {
    if (rev.action === 'dismiss') {
      dismissed.add(rev.findingId);
    } else if (rev.action === 'restore') {
      dismissed.delete(rev.findingId);
    }
  }
  return dismissed;
}

/**
 * Builds a complete, self-contained JSON audit dossier package for external archiving,
 * including all contract data, forensic indicators, raw evidences, extracted documents,
 * source records, append-only auditor reviews, OCDS 1.1 release, and a verifiable SHA-256 digest.
 */
export function buildStructuredDossierJson(
  evaluated: EvaluatedContract,
  options: NexofisDossierExportOptions = {}
): NexofisDossierExportPackage {
  const { assessment, reviews: contractReviews, ...baseContract } = evaluated;
  const auditorReviews = options.reviews ?? contractReviews ?? [];
  const analystNote = (options.analystNote ?? options.archivedSnapshot?.analystNote ?? '').trim();
  const exportedAt = options.exportedAt ?? new Date().toISOString();

  const dismissedIds = computeDismissedFindingIds(auditorReviews);
  const dismissedFindingCount = dismissedIds.size;
  const effectiveRiskScore =
    dismissedFindingCount > 0
      ? Math.min(
          100,
          assessment.indicators.reduce(
            (sum, ind) => (dismissedIds.has(ind.findingId) ? sum : sum + ind.weightPoints),
            0
          )
        )
      : assessment.score;

  const payload: NexofisDossierArchivePayload = {
    archiveMetadata: {
      contractId: baseContract.id,
      contractNumber: baseContract.contractNumber,
      pncpControlNumber: baseContract.pncpControlNumber,
      municipalityIbge: baseContract.municipalityIbge,
      municipalityName: baseContract.municipalityName,
      uf: baseContract.uf,
      analystNote,
      archivedSnapshotId: options.archivedSnapshot?.id,
      archivedSnapshotSavedAt: options.archivedSnapshot?.savedAt,
      archivedSnapshotDigest: options.archivedSnapshot?.sha256Digest,
      originalRiskScore: assessment.score,
      effectiveRiskScore,
      dismissedFindingCount,
      indicatorCount: assessment.indicators.length,
      evidenceCount: assessment.evidences.length,
      documentCount: baseContract.documents.length,
      sourceRecordCount: baseContract.sourceRecords.length,
    },
    contract: baseContract,
    forensicAssessment: assessment,
    auditorReviews,
    ocdsRelease: mapContractToOCDS(evaluated),
  };

  const contentSha256 = sha256HexSync(stableStringify(payload));

  return {
    schema: 'nexofis.audit-dossier.v1',
    exportedAt,
    softwareLicense: 'AGPL-3.0-only',
    publicDataNotice:
      'Código NEXOFIS licenciado sob AGPL-3.0-only. Dados contratuais públicos oriundos de portais oficiais (PNCP, IBGE, CGU/SICONFI) e documentos auditados permanecem sujeitos à LAI (Lei nº 12.527/2011) e à LGPD (Lei nº 13.709/2018).',
    integrity: {
      algorithm: 'SHA-256',
      canonicalization: 'stable-json-v1',
      contentSha256,
    },
    payload,
  };
}

/**
 * Deterministically verifies whether an exported NEXOFIS JSON dossier package
 * matches its recorded SHA-256 integrity digest.
 */
export function verifyDossierExportIntegrity(pkg: NexofisDossierExportPackage): boolean {
  if (!pkg || pkg.schema !== 'nexofis.audit-dossier.v1' || !pkg.payload || !pkg.integrity) {
    return false;
  }
  const recomputed = sha256HexSync(stableStringify(pkg.payload));
  return recomputed === pkg.integrity.contentSha256;
}

export function buildDossierJsonFilename(
  contract: Pick<EvaluatedContract, 'municipalityIbge' | 'contractNumber' | 'id'>
): string {
  const safeIbge = (contract.municipalityIbge || 'BR').replace(/[^0-9A-Za-z_-]/g, '');
  const safeNum = (contract.contractNumber || contract.id)
    .replace(/[^0-9A-Za-z_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `dossie-nexofis-${safeIbge}-${safeNum || 'contrato'}.json`;
}
