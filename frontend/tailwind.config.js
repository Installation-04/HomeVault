// Colours come from CSS variables (see src/index.css), so one set of class names serves both
// themes: the light values are Tailwind's own palette, the dark values are defined under `.dark`.
// The variables hold "R G B" triplets so opacity modifiers such as bg-brand-600/50 keep working.
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const scale = (name, steps) => Object.fromEntries(steps.map((s) => [s, v(`${name}-${s}`)]));
const ALL = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        gray: scale('gray', ALL),
        red: scale('red', ALL),
        amber: scale('amber', ALL),
        emerald: scale('emerald', ALL),
        sky: scale('sky', ALL),
        brand: scale('brand', ALL),
        // Page cards and form fields. Not `white`: text-white on a coloured button must stay white.
        surface: v('surface'),
        // Solid button backgrounds keep their colour in both themes (white text sits on them).
        'brand-hover': '#0f766e',
        danger: '#dc2626',
        'danger-hover': '#b91c1c',
      },
    },
  },
  plugins: [],
};
