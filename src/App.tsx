// The whole shell. The original wraps these two in a phone app; here they get a
// tab bar and nothing else, because there is nothing else.

import { useEffect, useState } from 'react';
import { GifApp } from './components/GifApp';
import { CutoutApp } from './components/CutoutApp';
import { THEME, ACCENT, type ThemeMode } from './lib/theme';
import { cn } from './lib/utils';

type Tab = 'gif' | 'cutout';

export function App() {
  const [tab, setTab] = useState<Tab>('gif');

  // Follow the machine rather than offering a switch nobody asked for.
  const [mode, setMode] = useState<ThemeMode>(() =>
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setMode(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const colors = THEME[mode];

  // BOTH stay mounted. They hold real work — frames on the server, a session in
  // localStorage, strokes that have not been applied — and unmounting the one
  // you are not looking at would quietly throw that away. `active` is exactly
  // the prop they already have for this: keep the state, pause the timers.
  return (
    <div className={cn('min-h-dvh', colors.pageBg, colors.textMain)}>
      <div className="mx-auto flex max-w-2xl gap-2 p-3">
        {(['gif', 'cutout'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'flex-1 rounded-xl border px-4 py-2 text-sm font-semibold transition',
              colors.panelBorder,
              tab === t ? 'border-transparent text-white' : cn(colors.panelBg, colors.textMuted),
            )}
            // accent is a colour, not a class — see lib/theme.ts
            style={tab === t ? { backgroundColor: ACCENT } : undefined}
          >
            {t === 'gif' ? 'GIF Lab' : 'Cutout'}
          </button>
        ))}
      </div>

      <div hidden={tab !== 'gif'}>
        <GifApp embedded active={tab === 'gif'} onClose={() => {}} themeConfig={THEME} themeMode={mode} />
      </div>
      <div hidden={tab !== 'cutout'}>
        <CutoutApp active={tab === 'cutout'} themeConfig={THEME} themeMode={mode} />
      </div>
    </div>
  );
}
