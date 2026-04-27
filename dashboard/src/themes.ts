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
    label: 'Ocean',
    description: 'Cool blues with violet and aqua highlights.',
    swatches: {
      primary: 'oklch(65% 0.15 230)',
      secondary: 'oklch(75% 0.10 210)',
      coral: 'oklch(70% 0.15 350)',
      teal: 'oklch(75% 0.13 200)',
      amber: 'oklch(82% 0.14 90)',
    },
  },
  {
    slug: 'forest',
    label: 'Forest',
    description: 'Verdant greens with earthy warm accents.',
    swatches: {
      primary: 'oklch(60% 0.14 150)',
      secondary: 'oklch(78% 0.10 130)',
      coral: 'oklch(70% 0.16 20)',
      teal: 'oklch(70% 0.13 175)',
      amber: 'oklch(80% 0.14 95)',
    },
  },
  {
    slug: 'sunset',
    label: 'Sunset',
    description: 'Warm oranges, corals & golden amber.',
    swatches: {
      primary: 'oklch(68% 0.18 30)',
      secondary: 'oklch(78% 0.14 50)',
      coral: 'oklch(72% 0.18 10)',
      teal: 'oklch(70% 0.12 180)',
      amber: 'oklch(84% 0.17 65)',
    },
  },
];

export const THEME_SLUGS: ReadonlyArray<ThemeSlug> = PRESETS.map((p) => p.slug);

export const DEFAULT_THEME_SLUG: ThemeSlug = 'default';

export function isThemeSlug(value: unknown): value is ThemeSlug {
  return typeof value === 'string' && (THEME_SLUGS as readonly string[]).includes(value);
}
