/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      colors: {
        'mind-bg': '#F7F7F2',
        'mind-text': '#1F2933'
      },
      keyframes: {
        'pulse-soft': {
          '0%, 100%': {
            transform: 'scale(1)',
            boxShadow: '0 0 0 0 rgba(15,23,42,0.18)',
          },
          '50%': {
            transform: 'scale(1.04)',
            boxShadow: '0 0 0 18px rgba(15,23,42,0)',
          },
        },
      },
      animation: {
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

