import { Calendar, X } from 'lucide-react';
import { validateDatePeriod } from '../lib/datePeriod';

interface DatePeriodControlsProps {
  idPrefix: string;
  startDate: string;
  endDate: string;
  onStartDateChange: (value: string) => void;
  onEndDateChange: (value: string) => void;
  onClear?: () => void;
  compact?: boolean;
  showPresets?: boolean;
}

export function DatePeriodControls({
  idPrefix,
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  onClear,
  compact = false,
  showPresets = false,
}: DatePeriodControlsProps) {
  const validation = validateDatePeriod(startDate, endDate);
  const hasPeriod = Boolean(startDate || endDate);

  const handleClear = () => {
    onStartDateChange('');
    onEndDateChange('');
    onClear?.();
  };

  return (
    <div className="space-y-1.5">
      <div className={`grid grid-cols-1 sm:grid-cols-2 ${compact ? 'gap-2' : 'gap-3'}`}>
        <div>
          <label
            htmlFor={`${idPrefix}-start-date`}
            className="block text-xs font-medium text-slate-600 mb-1"
          >
            Data de início
          </label>
          <div className="relative">
            <Calendar
              className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              id={`${idPrefix}-start-date`}
              type="date"
              value={startDate}
              onChange={(e) => onStartDateChange(e.target.value)}
              className={`w-full ${
                compact ? 'h-9 text-xs' : 'h-10 text-sm'
              } pl-8 pr-2.5 bg-white border rounded-md font-mono tabular-nums text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600 ${
                !validation.valid ? 'border-red-400' : 'border-slate-300'
              }`}
            />
          </div>
        </div>

        <div>
          <label
            htmlFor={`${idPrefix}-end-date`}
            className="block text-xs font-medium text-slate-600 mb-1"
          >
            Data final
          </label>
          <div className="relative flex items-center gap-1.5">
            <div className="relative flex-1">
              <Calendar
                className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id={`${idPrefix}-end-date`}
                type="date"
                value={endDate}
                onChange={(e) => onEndDateChange(e.target.value)}
                className={`w-full ${
                  compact ? 'h-9 text-xs' : 'h-10 text-sm'
                } pl-8 pr-2.5 bg-white border rounded-md font-mono tabular-nums text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600 ${
                  !validation.valid ? 'border-red-400' : 'border-slate-300'
                }`}
              />
            </div>
            {hasPeriod && (
              <button
                type="button"
                onClick={handleClear}
                aria-label="Limpar período de datas"
                title="Limpar período"
                className={`${
                  compact ? 'h-9 w-9' : 'h-10 w-10'
                } shrink-0 inline-flex items-center justify-center border border-slate-300 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-50 transition-colors`}
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>

      {!validation.valid && validation.error && (
        <p role="alert" className="text-xs text-red-700 font-medium">
          {validation.error}
        </p>
      )}

      {showPresets && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 pt-0.5">
          <span>Períodos rápidos:</span>
          <button
            type="button"
            onClick={() => {
              onStartDateChange('2026-01-01');
              onEndDateChange('2026-12-31');
            }}
            className="text-slate-700 hover:text-blue-700 underline underline-offset-4 whitespace-nowrap"
          >
            Exercício 2026
          </button>
          <button
            type="button"
            onClick={() => {
              onStartDateChange('2026-01-01');
              onEndDateChange('2026-06-30');
            }}
            className="text-slate-700 hover:text-blue-700 underline underline-offset-4 whitespace-nowrap"
          >
            1º Semestre 2026
          </button>
          <button
            type="button"
            onClick={() => {
              onStartDateChange('2025-01-01');
              onEndDateChange('2025-12-31');
            }}
            className="text-slate-700 hover:text-blue-700 underline underline-offset-4 whitespace-nowrap"
          >
            Exercício 2025
          </button>
          {hasPeriod && (
            <button
              type="button"
              onClick={handleClear}
              className="text-blue-700 hover:text-blue-800 font-medium underline underline-offset-4 whitespace-nowrap"
            >
              Todo o período
            </button>
          )}
        </div>
      )}
    </div>
  );
}
