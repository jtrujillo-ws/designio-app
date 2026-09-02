import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';

// Orden de plugins (importa): tsconfig-paths → tailwind → tanstackStart → react.
export default defineConfig({
  plugins: [tsconfigPaths(), tailwindcss(), tanstackStart(), react()],
  resolve: {
    // Una sola copia de React y del Router entre SSR y cliente (evita mismatches de hidratación).
    dedupe: ['react', 'react-dom', '@tanstack/react-router'],
  },
});
