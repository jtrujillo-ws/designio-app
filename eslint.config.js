import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// Lint gating = solo correctness; el formato vive en Prettier (local, fuera del gate).
export default tseslint.config(
  { ignores: ['dist/', '.output/', 'node_modules/', 'src/routeTree.gen.ts', '.claude/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // `any` prohibido en código nuevo (contrato operativo del stack interno).
      '@typescript-eslint/no-explicit-any': 'error',
      // Se veta el paquete `server-only` de Next.js (el tripwire propio es src/lib/server-only.ts).
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'server-only',
              message: 'Usa el tripwire propio: src/lib/server-only.ts',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.functions.ts'],
    rules: {
      // Convención dura: un *.functions.ts exporta solo server functions (sin re-exports).
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportAllDeclaration',
          message: 'Prohibido re-exportar desde módulos *.functions.ts (incidente split server/client).',
        },
      ],
    },
  },
);
