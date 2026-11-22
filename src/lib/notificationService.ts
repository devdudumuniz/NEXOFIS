import type { EvaluatedContract } from '../types/audit';

export type NotificationSeverity = 'critical' | 'warning' | 'info' | 'success';

export interface NotificationAction {
  label: string;
  onClick: () => void;
}

export interface NotificationItem {
  id: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  detail?: string;
  createdAt: string;
  durationMs: number;
  dedupeKey?: string;
  action?: NotificationAction;
  metadata?: {
    batchSource?: string;
    highRiskCount?: number;
    topContractId?: string;
    topScore?: number;
  };
}

export interface NotifyInput {
  severity: NotificationSeverity;
  title: string;
  message: string;
  detail?: string;
  durationMs?: number;
  dedupeKey?: string;
  action?: NotificationAction;
  metadata?: NotificationItem['metadata'];
}

export interface HighRiskBatchOptions {
  sourceLabel: string;
  /** Score threshold for High Risk classification (default: 70, matching NEXOFIS tier) */
  threshold?: number;
  /** Optional explicit batch signature used to prevent duplicate toasts for the same batch */
  batchKey?: string;
  onOpenContract?: (contract: EvaluatedContract) => void;
}

export interface HighRiskBatchResult {
  detectedCount: number;
  highRiskContracts: EvaluatedContract[];
  notification: NotificationItem | null;
}

type NotificationListener = (items: NotificationItem[]) => void;

const DEFAULT_DURATION_MS: Record<NotificationSeverity, number> = {
  critical: 12000,
  warning: 8500,
  info: 6000,
  success: 5500,
};

const MAX_VISIBLE_NOTIFICATIONS = 5;

/**
 * Pure helper identifying contracts that qualify as verified High Risk.
 * Explicitly excludes contracts with `INSUFFICIENT` coverage to uphold NEXOFIS
 * methodological integrity (insufficient documentation is never treated as High Risk).
 */
export function extractHighRiskContracts(
  contracts: ReadonlyArray<EvaluatedContract>,
  threshold = 70
): EvaluatedContract[] {
  return contracts
    .filter(
      (contract) =>
        contract.assessment.coverageStatus !== 'INSUFFICIENT' &&
        contract.assessment.score >= threshold
    )
    .sort((a, b) => b.assessment.score - a.assessment.score);
}

/**
 * Decoupled pub-sub NotificationService managing toast lifecycle, deduplication,
 * auto-dismiss timers, and batch high-risk contract detection alerts.
 */
export class NotificationService {
  private items: NotificationItem[] = [];
  private listeners = new Set<NotificationListener>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private recentDedupeTimestamps = new Map<string, number>();
  private sequence = 0;
  private readonly dedupeWindowMs: number;
  private readonly maxItems: number;

  constructor(options?: { dedupeWindowMs?: number; maxItems?: number }) {
    this.dedupeWindowMs = options?.dedupeWindowMs ?? 15000;
    this.maxItems = options?.maxItems ?? MAX_VISIBLE_NOTIFICATIONS;
  }

  getAll(): NotificationItem[] {
    return [...this.items];
  }

  subscribe(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    listener(this.getAll());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot = this.getAll();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private scheduleAutoDismiss(item: NotificationItem): void {
    if (item.durationMs <= 0) return;
    const timer = setTimeout(() => {
      this.dismiss(item.id);
    }, item.durationMs);
    // Avoid blocking Node process exit in tests
    if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    this.timers.set(item.id, timer);
  }

  notify(input: NotifyInput): NotificationItem | null {
    const now = Date.now();
    if (input.dedupeKey) {
      const lastSeen = this.recentDedupeTimestamps.get(input.dedupeKey);
      const alreadyActive = this.items.some((item) => item.dedupeKey === input.dedupeKey);
      if (alreadyActive || (lastSeen !== undefined && now - lastSeen < this.dedupeWindowMs)) {
        return null;
      }
      this.recentDedupeTimestamps.set(input.dedupeKey, now);
    }

    this.sequence += 1;
    const item: NotificationItem = {
      id: `nf-toast-${now}-${this.sequence}`,
      severity: input.severity,
      title: input.title,
      message: input.message,
      detail: input.detail,
      createdAt: new Date(now).toISOString(),
      durationMs: input.durationMs ?? DEFAULT_DURATION_MS[input.severity],
      dedupeKey: input.dedupeKey,
      action: input.action,
      metadata: input.metadata,
    };

    // Keep newest alerts at the top; evict oldest when exceeding stack limit
    this.items = [item, ...this.items];
    while (this.items.length > this.maxItems) {
      const removed = this.items.pop();
      if (removed) {
        const timer = this.timers.get(removed.id);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(removed.id);
        }
      }
    }

    this.scheduleAutoDismiss(item);
    this.emit();
    return item;
  }

  dismiss(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    const next = this.items.filter((item) => item.id !== id);
    if (next.length !== this.items.length) {
      this.items = next;
      this.emit();
    }
  }

  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.recentDedupeTimestamps.clear();
    if (this.items.length > 0) {
      this.items = [];
      this.emit();
    }
  }

  /**
   * Evaluates a batch of contracts returned by municipal investigation, global search,
   * risk dashboard, or multi-document ingestion and dispatches an immediate toast alert
   * when one or more high-risk contracts are detected.
   */
  notifyHighRiskBatch(
    contracts: ReadonlyArray<EvaluatedContract>,
    options: HighRiskBatchOptions
  ): HighRiskBatchResult {
    const threshold = options.threshold ?? 70;
    const highRiskContracts = extractHighRiskContracts(contracts, threshold);

    if (highRiskContracts.length === 0) {
      return {
        detectedCount: 0,
        highRiskContracts: [],
        notification: null,
      };
    }

    const top = highRiskContracts[0];
    const topIndicator = top.assessment.indicators[0];
    const idsSignature = highRiskContracts
      .slice(0, 5)
      .map((c) => `${c.id}:${c.assessment.score}`)
      .join('|');
    const dedupeKey =
      options.batchKey ?? `high-risk-batch:${options.sourceLabel}:${idsSignature}`;

    const isSingle = highRiskContracts.length === 1;
    const locationLabel = top.uf
      ? `${top.municipalityName}/${top.uf}`
      : top.municipalityName || top.entityName;

    const title = isSingle
      ? `Alto Risco Detectado · Contrato ${top.contractNumber}`
      : `${highRiskContracts.length} Contratos de Alto Risco Detectados`;

    const message = isSingle
      ? `Pontuação ${top.assessment.score}/100 em ${locationLabel} (${top.entityName}).${
          topIndicator ? ` Principal achado: ${topIndicator.title}.` : ''
        }`
      : `Maior risco no lote: Contrato ${top.contractNumber} (${top.assessment.score}/100) em ${locationLabel}.`;

    const detail = `${options.sourceLabel} · ${highRiskContracts.length} de ${contracts.length} contrato(s) com risco >= ${threshold}/100`;

    const notification = this.notify({
      severity: 'critical',
      title,
      message,
      detail,
      dedupeKey,
      durationMs: 14000,
      action: options.onOpenContract
        ? {
            label: isSingle ? 'Abrir Dossiê' : 'Abrir Maior Risco',
            onClick: () => options.onOpenContract?.(top),
          }
        : undefined,
      metadata: {
        batchSource: options.sourceLabel,
        highRiskCount: highRiskContracts.length,
        topContractId: top.id,
        topScore: top.assessment.score,
      },
    });

    return {
      detectedCount: highRiskContracts.length,
      highRiskContracts,
      notification,
    };
  }
}

export const notificationService = new NotificationService();
