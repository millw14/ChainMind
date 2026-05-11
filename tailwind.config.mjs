/** @type {import('tailwindcss').Config} */
export default {
  content: ["./app/**/*.{js,jsx}", "./components/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#38bdf8",
          dim: "#0ea5e9",
        },
      },
    },
  },
  plugins: [],
};
