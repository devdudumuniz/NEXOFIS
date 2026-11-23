import React from 'react';
import type { ThemeMode } from '../lib/theme';

interface NexofisBrandLogoProps {
  theme: ThemeMode;
  variant?: 'horizontal' | 'symbol' | 'signature';
  className?: string;
}

export const NexofisBrandLogo: React.FC<NexofisBrandLogoProps> = ({
  theme,
  variant = 'horizontal',
  className = '',
}) => {
  if (variant === 'symbol') {
    const src =
      theme === 'dark'
        ? '/brand/nexofis-symbol-reverse.svg'
        : '/brand/nexofis-symbol.svg';
    return (
      <img
        src={src}
        alt="NEXOFIS"
        className={`h-8 w-auto select-none object-contain ${className}`}
      />
    );
  }

  if (variant === 'signature') {
    return (
      <img
        src="/brand/nexofis-logo-signature.svg"
        alt="NEXOFIS — Inteligência sobre o gasto público"
        className={`h-10 w-auto select-none object-contain ${className}`}
      />
    );
  }

  const src =
    theme === 'dark'
      ? '/brand/nexofis-logo-horizontal-reverse.svg'
      : '/brand/nexofis-logo-horizontal.svg';

  return (
    <img
      src={src}
      alt="NEXOFIS — Inteligência sobre o gasto público"
      className={`h-7 w-auto select-none object-contain ${className}`}
    />
  );
};
