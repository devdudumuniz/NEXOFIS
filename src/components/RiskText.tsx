import type { RiskSeverity } from '../types/audit';

export function getRiskToneClass(score: number): string {
  if (score >= 70) return 'text-red-700';
  if (score >= 45) return 'text-amber-700';
  if (score >= 20) return 'text-blue-700';
  return 'text-emerald-700';
}

export function getRiskLabel(score: number): string {
  if (score >= 70) return 'Crítico';
  if (score >= 45) return 'Alto';
  if (score >= 20) return 'Moderado';
  return 'Regular';
}

export function getSeverityToneClass(severity: RiskSeverity): string {
  switch (severity) {
    case 'CRÍTICA':
      return 'text-red-700 font-semibold';
    case 'ALTA':
      return 'text-amber-700 font-semibold';
    case 'MÉDIA':
      return 'text-blue-700 font-medium';
    case 'BAIXA':
      return 'text-slate-600 font-medium';
  }
}

export function RiskScoreInline({ score }: { score: number }) {
  return (
    <span className={`font-mono tabular-nums font-semibold ${getRiskToneClass(score)}`}>
      {score}/100{' '}
      <span className="font-sans text-xs font-medium opacity-85">· {getRiskLabel(score)}</span>
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
