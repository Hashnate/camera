import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
      },
      colors: {
        background: '#f8fafc',
        foreground: '#0f172a',
        sidebar: {
          bg: '#0f172a',
          text: '#94a3b8',
          hover: '#1e293b',
          active: '#3b82f6',
        },
      },
    },
  },
  plugins: [],
};
export default config;

