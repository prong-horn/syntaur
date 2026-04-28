import type { Config } from 'tailwindcss';
import typography from '@tailwindcss/typography';

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Space Grotesk"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        border: 'oklch(var(--border) / <alpha-value>)',
        input: 'oklch(var(--input) / <alpha-value>)',
        ring: 'oklch(var(--ring) / <alpha-value>)',
        background: 'oklch(var(--background) / <alpha-value>)',
        foreground: 'oklch(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'oklch(var(--primary) / <alpha-value>)',
          dim: 'oklch(var(--primary-dim) / <alpha-value>)',
          foreground: 'oklch(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'oklch(var(--secondary) / <alpha-value>)',
          foreground: 'oklch(var(--secondary-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'oklch(var(--destructive) / <alpha-value>)',
          foreground: 'oklch(var(--destructive-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'oklch(var(--muted) / <alpha-value>)',
          foreground: 'oklch(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'oklch(var(--accent) / <alpha-value>)',
          foreground: 'oklch(var(--accent-foreground) / <alpha-value>)',
          coral: 'oklch(var(--accent-coral) / <alpha-value>)',
          'coral-dim': 'oklch(var(--accent-coral-dim) / <alpha-value>)',
          teal: 'oklch(var(--accent-teal) / <alpha-value>)',
          'teal-dim': 'oklch(var(--accent-teal-dim) / <alpha-value>)',
          amber: 'oklch(var(--accent-amber) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'oklch(var(--popover) / <alpha-value>)',
          foreground: 'oklch(var(--popover-foreground) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'oklch(var(--card) / <alpha-value>)',
          foreground: 'oklch(var(--card-foreground) / <alpha-value>)',
        },
        sidebar: 'oklch(var(--sidebar) / <alpha-value>)',
        overlay: 'oklch(var(--overlay) / <alpha-value>)',
        code: {
          DEFAULT: 'oklch(var(--code) / <alpha-value>)',
          foreground: 'oklch(var(--code-foreground) / <alpha-value>)',
        },
        status: {
          pending: {
            DEFAULT: 'oklch(var(--status-pending) / <alpha-value>)',
            foreground: 'oklch(var(--status-pending-foreground) / <alpha-value>)',
          },
          'in-progress': {
            DEFAULT: 'oklch(var(--status-in-progress) / <alpha-value>)',
            foreground: 'oklch(var(--status-in-progress-foreground) / <alpha-value>)',
          },
          blocked: {
            DEFAULT: 'oklch(var(--status-blocked) / <alpha-value>)',
            foreground: 'oklch(var(--status-blocked-foreground) / <alpha-value>)',
          },
          review: {
            DEFAULT: 'oklch(var(--status-review) / <alpha-value>)',
            foreground: 'oklch(var(--status-review-foreground) / <alpha-value>)',
          },
          completed: {
            DEFAULT: 'oklch(var(--status-completed) / <alpha-value>)',
            foreground: 'oklch(var(--status-completed-foreground) / <alpha-value>)',
          },
          failed: {
            DEFAULT: 'oklch(var(--status-failed) / <alpha-value>)',
            foreground: 'oklch(var(--status-failed-foreground) / <alpha-value>)',
          },
          archived: {
            DEFAULT: 'oklch(var(--status-archived) / <alpha-value>)',
            foreground: 'oklch(var(--status-archived-foreground) / <alpha-value>)',
          },
        },
        success: {
          DEFAULT: 'oklch(var(--success) / <alpha-value>)',
          foreground: 'oklch(var(--success-foreground) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'oklch(var(--warning) / <alpha-value>)',
          foreground: 'oklch(var(--warning-foreground) / <alpha-value>)',
        },
        error: {
          DEFAULT: 'oklch(var(--error) / <alpha-value>)',
          foreground: 'oklch(var(--error-foreground) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'oklch(var(--info) / <alpha-value>)',
          foreground: 'oklch(var(--info-foreground) / <alpha-value>)',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [typography],
} satisfies Config;
