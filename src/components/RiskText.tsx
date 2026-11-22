import type { RiskSeverity } from '../types/audit';

export type CoverageStatus = 'ADEQUATE' | 'PARTIAL' | 'INSUFFICIENT';

export function getRiskToneClass(score: number, coverageStatus?: CoverageStatus): string {
  if (coverageStatus === 'INSUFFICIENT') {
    return 'text-slate-600 dark:text-slate-300';
  }
  if (score >= 70) return 'text-red-700 dark:text-red-400';
  if (score >= 45) return 'text-amber-700 dark:text-amber-400';
  if (score >= 20) return 'text-[#0B2540] dark:text-sky-300';
  return 'text-emerald-700 dark:text-emerald-400';
}

export function getRiskLabel(score: number, coverageStatus?: CoverageStatus): string {
  if (coverageStatus === 'INSUFFICIENT') return 'Não verificável';
  if (score >= 70) return 'Crítico';
  if (score >= 45) return 'Alto';
  if (score >= 20) return 'Moderado';
  if (coverageStatus === 'PARTIAL') return 'Parcial (sem indícios)';
  return 'Preliminar regular';
}

export function getSeverityToneClass(severity: RiskSeverity): string {
  switch (severity) {
    case 'CRÍTICA':
      return 'text-red-700 dark:text-red-400 font-semibold';
    case 'ALTA':
      return 'text-amber-700 dark:text-amber-400 font-semibold';
    case 'MÉDIA':
      return 'text-[#0B2540] dark:text-sky-300 font-medium';
    case 'BAIXA':
      return 'text-slate-600 dark:text-slate-400 font-medium';
  }
}

export function RiskScoreInline({
  score,
  coverageStatus,
}: {
  score: number;
  coverageStatus?: CoverageStatus;
}) {
  if (coverageStatus === 'INSUFFICIENT') {
    return (
      <span className="font-mono tabular-nums font-semibold text-slate-600 dark:text-slate-300">
        —{' '}
        <span className="font-sans text-xs font-medium opacity-90">· Cobertura insuficiente</span>
      </span>
    );
  }

  return (
    <span className={`font-mono tabular-nums font-semibold ${getRiskToneClass(score, coverageStatus)}`}>
      {score}/100{' '}
      <span className="font-sans text-xs font-medium opacity-85">
        · {getRiskLabel(score, coverageStatus)}
      </span>
    </span>
  );
}

export function SeverityText({ severity }: { severity: RiskSeverity }) {
  return (
    <span className={`font-mono text-xs tracking-tight uppercase ${getSeverityToneClass(severity)}`}>
      {severity}
    </span>
  );
}
