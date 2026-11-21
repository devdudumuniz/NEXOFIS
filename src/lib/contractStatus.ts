import type { ContractRecord } from '../types/audit';

export type ContractLifecycleFilter = '' | 'em_andamento' | 'concluido' | 'suspenso';
export type ContractLifecycleBucket = 'em_andamento' | 'concluido' | 'suspenso';

export const CONTRACT_LIFECYCLE_LABELS: Record<ContractLifecycleBucket, string> = {
  em_andamento: 'Em Andamento',
  concluido: 'Concluído',
  suspenso: 'Suspenso',
};

export const CONTRACT_LIFECYCLE_OPTIONS: Array<{
  value: ContractLifecycleFilter;
  label: string;
}> = [
  { value: '', label: 'Todos os status' },
  { value: 'em_andamento', label: 'Em Andamento' },
  { value: 'concluido', label: 'Concluído' },
  { value: 'suspenso', label: 'Suspenso' },
];

export function normalizeLifecycleFilterParam(raw?: string | null): ContractLifecycleFilter {
  const clean = (raw ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (clean === 'em_andamento' || clean === 'vigente' || clean === 'em_execucao' || clean === 'ativo') {
    return 'em_andamento';
  }
  if (clean === 'concluido' || clean === 'encerrado' || clean === 'finalizado') {
    return 'concluido';
  }
  if (clean === 'suspenso' || clean === 'paralisado' || clean === 'rescindido' || clean === 'cancelado') {
    return 'suspenso';
  }
  return '';
}

/**
 * Resolves a contract's current lifecycle bucket (Em Andamento, Concluído, Suspenso)
 * deterministically from its reported status and endDate relative to a reference ISO date.
 */
export function resolveContractLifecycleStatus(
  contract: Pick<ContractRecord, 'status' | 'endDate'>,
  referenceDateIso: string = new Date().toISOString().slice(0, 10)
): ContractLifecycleBucket {
  const normalizedStatus = (contract.status ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  if (
    normalizedStatus.includes('suspens') ||
    normalizedStatus.includes('paralis') ||
    normalizedStatus.includes('rescind') ||
    normalizedStatus.includes('anulad') ||
    normalizedStatus.includes('cancel')
  ) {
    return 'suspenso';
  }

  if (
    normalizedStatus.includes('encerrad') ||
    normalizedStatus.includes('concluid') ||
    normalizedStatus.includes('finaliz')
  ) {
    return 'concluido';
  }

  const endIso = (contract.endDate ?? '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(endIso) && /^\d{4}-\d{2}-\d{2}$/.test(referenceDateIso)) {
    if (endIso < referenceDateIso) {
      return 'concluido';
    }
  }

  return 'em_andamento';
}

export function matchesContractLifecycleFilter(
  contract: Pick<ContractRecord, 'status' | 'endDate'>,
  filter: ContractLifecycleFilter,
  referenceDateIso?: string
): boolean {
  if (!filter) return true;
  return resolveContractLifecycleStatus(contract, referenceDateIso) === filter;
}
