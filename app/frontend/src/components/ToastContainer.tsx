import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Info,
  ShieldAlert,
  X,
} from 'lucide-react';
import {
  notificationService,
  type NotificationItem,
  type NotificationSeverity,
} from '../lib/notificationService';

function getSeverityStyles(severity: NotificationSeverity): {
  border: string;
  accentBar: string;
  iconBg: string;
  iconColor: string;
  titleColor: string;
  Icon: typeof ShieldAlert;
} {
  switch (severity) {
    case 'critical':
      return {
        border: 'border-red-300 dark:border-red-800/80',
        accentBar: 'bg-red-600 dark:bg-red-500',
        iconBg: 'bg-red-50 dark:bg-red-950/60',
        iconColor: 'text-red-700 dark:text-red-400',
        titleColor: 'text-red-950 dark:text-red-200',
        Icon: ShieldAlert,
      };
    case 'warning':
      return {
        border: 'border-amber-300 dark:border-amber-800/80',
        accentBar: 'bg-amber-500',
        iconBg: 'bg-amber-50 dark:bg-amber-950/60',
        iconColor: 'text-amber-700 dark:text-amber-400',
        titleColor: 'text-amber-950 dark:text-amber-200',
        Icon: AlertTriangle,
      };
    case 'success':
      return {
        border: 'border-emerald-300 dark:border-emerald-800/80',
        accentBar: 'bg-emerald-600',
        iconBg: 'bg-emerald-50 dark:bg-emerald-950/60',
        iconColor: 'text-emerald-700 dark:text-emerald-400',
        titleColor: 'text-emerald-950 dark:text-emerald-200',
        Icon: CheckCircle2,
      };
    default:
      return {
        border: 'border-slate-300 dark:border-[#1D3A57]',
        accentBar: 'bg-[#0B2540] dark:bg-[#D95B35]',
        iconBg: 'bg-[#E8F1F6] dark:bg-[#102843]',
        iconColor: 'text-[#0B2540] dark:text-[#FAF9F5]',
        titleColor: 'text-[#0B2540] dark:text-[#FAF9F5]',
        Icon: Info,
      };
  }
}

export function ToastContainer() {
  const [items, setItems] = useState<NotificationItem[]>(() => notificationService.getAll());

  useEffect(() => {
    return notificationService.subscribe(setItems);
  }, []);

  if (items.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="toast-container"
      aria-label="Notificações de auditoria"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-3 w-[calc(100vw-2rem)] max-w-md pointer-events-none"
    >
      {items.map((item) => {
        const styles = getSeverityStyles(item.severity);
        const Icon = styles.Icon;
        const isCritical = item.severity === 'critical';

        return (
          <div
            key={item.id}
            role={isCritical ? 'alert' : 'status'}
            aria-live={isCritical ? 'assertive' : 'polite'}
            data-testid={`toast-item-${item.severity}`}
            className={`pointer-events-auto relative overflow-hidden rounded-lg border bg-white dark:bg-[#0B1D31] shadow-lg transition-all ${styles.border}`}
          >
            <div className={`absolute inset-y-0 left-0 w-1.5 ${styles.accentBar}`} aria-hidden="true" />
            <div className="pl-4 pr-3 py-3.5 flex items-start gap-3">
              <div className={`p-1.5 rounded-md shrink-0 mt-0.5 ${styles.iconBg}`}>
                <Icon className={`w-4 h-4 ${styles.iconColor}`} aria-hidden="true" />
              </div>

              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <h3 className={`text-xs font-bold leading-snug ${styles.titleColor}`}>
                    {item.title}
                  </h3>
                  <button
                    type="button"
                    onClick={() => notificationService.dismiss(item.id)}
                    aria-label={`Fechar alerta: ${item.title}`}
                    className="p-0.5 -mr-1 text-slate-400 hover:text-[#0B2540] dark:hover:text-white rounded transition-colors shrink-0"
                  >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </div>

                <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed">
                  {item.message}
                </p>

                {item.detail && (
                  <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                    {item.detail}
                  </p>
                )}

                {item.action && (
                  <div className="pt-1.5 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        item.action?.onClick();
                        notificationService.dismiss(item.id);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-[#0B2540] hover:bg-[#103256] dark:bg-[#D95B35] dark:hover:bg-[#C24C28] rounded-md transition-colors"
                    >
                      <span>{item.action.label}</span>
                      <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
