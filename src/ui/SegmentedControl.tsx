import { cn } from '../lib/utils';
import type { ThemeConfig } from '../lib/theme';

type ThemeMode = 'light' | 'dark';

interface SegmentedControlProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  colors: ThemeConfig[ThemeMode];
  className?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  colors,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div className={cn('flex gap-1.5 flex-wrap', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors border',
            colors.panelBorder,
            value !== option.value && cn(colors.panelBg, colors.textMain),
          )}
          style={
            value === option.value
              ? {
                  background: colors.accent,
                  color: 'var(--gl-on-accent)',
                  borderColor: colors.accent,
                }
              : undefined
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
