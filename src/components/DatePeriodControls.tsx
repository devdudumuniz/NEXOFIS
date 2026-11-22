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
            className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1"
          >
            Data de início
          </label>
          <div className="relative">
            <Calendar
              className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              id={`${idPrefix}-start-date`}
              type="date"
              value={startDate}
              onChange={(e) => onStartDateChange(e.target.value)}
              className={`w-full ${
                compact ? 'h-9 text-xs' : 'h-10 text-sm'
              } pl-8 pr-2.5 bg-white dark:bg-[#0B1D31] border rounded-md font-mono tabular-nums text-[#0B2540] dark:text-[#FAF9F5] focus:outline-none focus:ring-2 focus:ring-[#D95B35] ${
                !validation.valid
                  ? 'border-red-400 dark:border-red-500'
                  : 'border-slate-300 dark:border-[#1D3A57]'
              }`}
            />
          </div>
        </div>

        <div>
          <label
            htmlFor={`${idPrefix}-end-date`}
            className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1"
          >
            Data final
          </label>
          <div className="relative flex items-center gap-1.5">
            <div className="relative flex-1">
              <Calendar
                className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id={`${idPrefix}-end-date`}
                type="date"
                value={endDate}
                onChange={(e) => onEndDateChange(e.target.value)}
                className={`w-full ${
                  compact ? 'h-9 text-xs' : 'h-10 text-sm'
                } pl-8 pr-2.5 bg-white dark:bg-[#0B1D31] border rounded-md font-mono tabular-nums text-[#0B2540] dark:text-[#FAF9F5] focus:outline-none focus:ring-2 focus:ring-[#D95B35] ${
                  !validation.valid
                    ? 'border-red-400 dark:border-red-500'
                    : 'border-slate-300 dark:border-[#1D3A57]'
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
                } shrink-0 inline-flex items-center justify-center border border-slate-300 dark:border-[#1D3A57] rounded-md text-slate-500 dark:text-slate-300 hover:text-[#0B2540] dark:hover:text-[#FAF9F5] hover:bg-slate-50 dark:hover:bg-[#102843] transition-colors`}
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>

      {!validation.valid && validation.error && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400 font-medium">
          {validation.error}
        </p>
      )}

      {showPresets && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400 pt-0.5">
          <span>Períodos:</span>
          <button
            type="button"
            onClick={() => {
              onStartDateChange('2026-01-01');
              onEndDateChange('2026-12-31');
            }}
            className="text-[#0B2540] dark:text-slate-200 hover:text-[#D95B35] dark:hover:text-[#D95B35] underline underline-offset-4 whitespace-nowrap"
          >
            Exercício 2026
          </button>
          <button
            type="button"
            onClick={() => {
              onStartDateChange('2026-01-01');
              onEndDateChange('2026-06-30');
            }}
            className="text-[#0B2540] dark:text-slate-200 hover:text-[#D95B35] dark:hover:text-[#D95B35] underline underline-offset-4 whitespace-nowrap"
          >
            1º Semestre 2026
          </button>
          <button
            type="button"
            onClick={() => {
              onStartDateChange('2025-01-01');
              onEndDateChange('2025-12-31');
            }}
            className="text-[#0B2540] dark:text-slate-200 hover:text-[#D95B35] dark:hover:text-[#D95B35] underline underline-offset-4 whitespace-nowrap"
          >
            Exercício 2025
          </button>
          {hasPeriod && (
            <button
              type="button"
              onClick={handleClear}
              className="text-[#D95B35] font-medium underline underline-offset-4 whitespace-nowrap"
            >
              Todo o período
            </button>
          )}
        </div>
      )}
    </div>
  );
}
