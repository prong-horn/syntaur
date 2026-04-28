export type ThemeSlug = 'default' | 'ocean' | 'forest' | 'sunset';

export interface ThemePreset {
  slug: ThemeSlug;
  label: string;
  description: string;
  swatches: {
    primary: string;
    secondary: string;
    coral: string;
    teal: string;
    amber: string;
  };
}

export const PRESETS: ReadonlyArray<ThemePreset> = [
  {
    slug: 'default',
    label: 'Syntaur',
    description: 'Brand purple, warm yellow, coral & teal accents.',
    swatches: {
      primary: 'oklch(70% 0.18 290)',
      secondary: 'oklch(80% 0.14 75)',
      coral: 'oklch(72% 0.17 15)',
      teal: 'oklch(72% 0.14 185)',
      amber: 'oklch(82% 0.16 75)',
    },
  },
  {
    slug: 'ocean',
    label: 'Midnight',
    description: 'Deep indigo-blue with cyan accents. Inspired by One Dark Pro.',
    swatches: {
      primary: 'oklch(70% 0.16 240)',
      secondary: 'oklch(78% 0.13 200)',
      coral: 'oklch(72% 0.18 350)',
      teal: 'oklch(78% 0.14 195)',
      amber: 'oklch(84% 0.15 90)',
    },
  },
  {
    slug: 'forest',
    label: 'Verdant',
    description: 'Saturated emerald and pine on a dark olive base.',
    swatches: {
      primary: 'oklch(72% 0.17 145)',
      secondary: 'oklch(80% 0.13 110)',
      coral: 'oklch(72% 0.17 25)',
      teal: 'oklch(75% 0.13 175)',
      amber: 'oklch(82% 0.16 95)',
    },
  },
  {
    slug: 'sunset',
    label: 'Ember',
    description: 'Warm sepia surfaces with copper and amber accents.',
    swatches: {
      primary: 'oklch(72% 0.18 35)',
      secondary: 'oklch(80% 0.16 60)',
      coral: 'oklch(72% 0.19 15)',
      teal: 'oklch(72% 0.12 180)',
      amber: 'oklch(86% 0.17 70)',
    },
  },
];

export const THEME_SLUGS: ReadonlyArray<ThemeSlug> = PRESETS.map((p) => p.slug);

export const DEFAULT_THEME_SLUG: ThemeSlug = 'default';

export function isThemeSlug(value: unknown): value is ThemeSlug {
  return typeof value === 'string' && (THEME_SLUGS as readonly string[]).includes(value);
}
