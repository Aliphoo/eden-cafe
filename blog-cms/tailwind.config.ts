import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#17211b',
        leaf: '#176b45',
        moss: '#6f8d58',
        clay: '#a15b3f',
        mist: '#f5f7f4',
        line: '#dfe7df'
      },
      boxShadow: {
        panel: '0 10px 28px rgba(24, 39, 31, 0.08)'
      }
    }
  },
  plugins: []
};

export default config;
