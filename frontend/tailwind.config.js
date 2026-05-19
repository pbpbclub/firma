/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0f4ff",
          100: "#dde6ff",
          500: "#4f6ef7",
          600: "#3b5bf0",
          700: "#2d4de0",
          900: "#1a2f8a",
        },
      },
    },
  },
  plugins: [],
};

