// Where the original app's theme system used to be.
//
// Its theme file is 784 lines and knows about every surface in a whole phone.
// These two components read exactly SIX fields off it — checked, not guessed.
//
// THE FIELDS ARE NOT ALL THE SAME KIND OF THING, and that is easy to get wrong.
// pageBg, panelBg, panelBorder, textMain and textMuted are TAILWIND CLASSES:
// they are only ever passed to cn(), so a class is what they must be. accent is
// a CSS COLOR: it appears twenty-eight times and every single one is an inline
// style — backgroundColor, color, accentColor. Give accent a class name and the
// browser silently drops every one of those declarations, which leaves the
// Choose an image button with dark text on a dark panel and no background at
// all. Counted rather than assumed.

export interface ThemeColors {
  /** tailwind class */ pageBg: string;
  /** tailwind class */ panelBg: string;
  /** tailwind class */ panelBorder: string;
  /** tailwind class */ textMain: string;
  /** tailwind class */ textMuted: string;
  /** CSS color, used in inline styles only */ accent: string;
}

export interface ThemeConfig {
  id: string;
  name: string;
  fontFamily: string;
  messageFontFamily: string;
  radius: string;
  light: ThemeColors;
  dark: ThemeColors;
}

/** The accent, as a colour rather than a class, for the few places that need it
 *  outside a ThemeColors lookup. */
export const ACCENT = '#f97316';

export const THEME: ThemeConfig = {
  id: 'standalone',
  name: 'GIF Lab',
  fontFamily: 'font-sans',
  messageFontFamily: 'font-sans',
  radius: 'rounded-2xl',
  light: {
    pageBg: 'bg-neutral-100',
    panelBg: 'bg-white',
    panelBorder: 'border-neutral-200',
    textMain: 'text-neutral-900',
    textMuted: 'text-neutral-500',
    accent: ACCENT,
  },
  dark: {
    pageBg: 'bg-neutral-950',
    panelBg: 'bg-neutral-900',
    panelBorder: 'border-neutral-800',
    textMain: 'text-neutral-100',
    textMuted: 'text-neutral-400',
    accent: ACCENT,
  },
};

export type ThemeMode = 'light' | 'dark';
