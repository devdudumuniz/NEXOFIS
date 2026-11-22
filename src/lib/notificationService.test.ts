import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXTURE_HIGH_RISK,
  FIXTURE_COMPLIANT,
  TEST_FIXTURE_CONTRACTS,
} from './__fixtures__/testContracts';
import { evaluateContractRisk } from './riskEngine';
import {
  extractHighRiskContracts,
  NotificationService,
  type NotificationItem,
} from './notificationService';
import type { EvaluatedContract } from '../types/audit';

function evaluateFixtures(): EvaluatedContract[] {
  return TEST_FIXTURE_CONTRACTS.map((c) => ({
    ...c,
    assessment: evaluateContractRisk(c),
  }));
}

test('extractHighRiskContracts selects >= 70 scores and never includes INSUFFICIENT coverage', () => {
  const high: EvaluatedContract = {
    ...FIXTURE_HIGH_RISK,
    assessment: evaluateContractRisk(FIXTURE_HIGH_RISK),
  };
  const low: EvaluatedContract = {
    ...FIXTURE_COMPLIANT,
    assessment: evaluateContractRisk(FIXTURE_COMPLIANT),
  };
  const insufficientHighScore: EvaluatedContract = {
    ...high,
    id: 'ctr-insufficient',
    assessment: {
      ...high.assessment,
      score: 95,
      coverageStatus: 'INSUFFICIENT',
    },
  };

  const detected = extractHighRiskContracts([low, insufficientHighScore, high], 70);
  assert.equal(detected.length, 1);
  assert.equal(detected[0].id, high.id);
});

test('NotificationService notifies subscribers, deduplicates by dedupeKey, caps stack, and dismisses cleanly', () => {
  const svc = new NotificationService({ dedupeWindowMs: 30_000, maxItems: 3 });
  const snapshots: NotificationItem[][] = [];
  const unsubscribe = svc.subscribe((items) => snapshots.push(items));

  const first = svc.notify({
    severity: 'warning',
    title: 'Alerta 1',
    message: 'Mensagem 1',
    dedupeKey: 'dup-1',
    durationMs: 0,
  });
  assert.ok(first);

  const duplicate = svc.notify({
    severity: 'warning',
    title: 'Alerta 1 repetido',
    message: 'Deve ser ignorado',
    dedupeKey: 'dup-1',
    durationMs: 0,
  });
  assert.equal(duplicate, null);
  assert.equal(svc.getAll().length, 1);

  svc.notify({ severity: 'info', title: 'Alerta 2', message: 'M2', durationMs: 0 });
  svc.notify({ severity: 'success', title: 'Alerta 3', message: 'M3', durationMs: 0 });
  svc.notify({ severity: 'critical', title: 'Alerta 4', message: 'M4', durationMs: 0 });

  // Max stack size 3 keeps newest 3 items
  const current = svc.getAll();
  assert.equal(current.length, 3);
  assert.equal(current[0].title, 'Alerta 4');

  svc.dismiss(current[0].id);
  assert.equal(svc.getAll().length, 2);

  svc.clear();
  assert.equal(svc.getAll().length, 0);
  assert.ok(snapshots.length >= 5);

  unsubscribe();
});

test('notifyHighRiskBatch emits critical toast for single high-risk contract and wires onOpenContract action', () => {
  const svc = new NotificationService({ dedupeWindowMs: 30_000 });
  const high: EvaluatedContract = {
    ...FIXTURE_HIGH_RISK,
    assessment: evaluateContractRisk(FIXTURE_HIGH_RISK),
  };
  const low: EvaluatedContract = {
    ...FIXTURE_COMPLIANT,
    assessment: evaluateContractRisk(FIXTURE_COMPLIANT),
  };

  let openedContractId: string | null = null;
  const result = svc.notifyHighRiskBatch([low, high], {
    sourceLabel: 'Análise em Lote (Teste)',
    onOpenContract: (c) => {
      openedContractId = c.id;
    },
  });

  assert.equal(result.detectedCount, 1);
  assert.ok(result.notification);
  assert.equal(result.notification.severity, 'critical');
  assert.match(result.notification.title, /Alto Risco Detectado/);
  assert.equal(result.notification.action?.label, 'Abrir Dossiê');

  result.notification.action?.onClick();
  assert.equal(openedContractId, high.id);
  svc.clear();
});

test('notifyHighRiskBatch summarizes multiple high-risk contracts in a batch and stays silent when none qualify', () => {
  const svc = new NotificationService({ dedupeWindowMs: 30_000 });
  const low: EvaluatedContract = {
    ...FIXTURE_COMPLIANT,
    assessment: evaluateContractRisk(FIXTURE_COMPLIANT),
  };

  const quiet = svc.notifyHighRiskBatch([low], { sourceLabel: 'Lote Limpo' });
  assert.equal(quiet.detectedCount, 0);
  assert.equal(quiet.notification, null);
  assert.equal(svc.getAll().length, 0);

  const fixtures = evaluateFixtures();
  const extraHigh: EvaluatedContract = {
    ...fixtures[0],
    id: 'ctr-second-high',
    contractNumber: '999/2026',
    assessment: {
      ...fixtures[0].assessment,
      score: 98,
      coverageStatus: 'ADEQUATE',
    },
  };

  let openedTopId: string | null = null;
  const multi = svc.notifyHighRiskBatch([...fixtures, extraHigh], {
    sourceLabel: 'Lote Municipal',
    onOpenContract: (c) => {
      openedTopId = c.id;
    },
  });

  assert.ok(multi.detectedCount >= 2);
  assert.ok(multi.notification);
  assert.match(multi.notification.title, /Contratos de Alto Risco Detectados/);
  assert.equal(multi.notification.action?.label, 'Abrir Maior Risco');
  multi.notification.action?.onClick();
  assert.equal(openedTopId, 'ctr-second-high');
  svc.clear();
});
