/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        sr: {
          primary: 'var(--bg-primary)',
          secondary: 'var(--bg-secondary)',
          tertiary: 'var(--bg-tertiary)',
          card: 'var(--bg-card)',
          accent: 'var(--accent)',
          'accent-hover': 'var(--accent-hover)',
          success: 'var(--success)',
          danger: 'var(--danger)',
          warning: 'var(--warning)',
          border: 'var(--border)',
          'border-light': 'var(--border-light)',
        },
      },
      boxShadow: {
        soft: "0 10px 30px rgba(0,0,0,0.12)",
        glow: "0 5px 20px var(--accent-glow)",
      },
    },
  },
  plugins: [],
};
