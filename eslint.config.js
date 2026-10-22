import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: { allowDefaultProject: ['eslint.config.js'] }, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
      'no-console': 'error',
    },
  },
  { files: ['eslint.config.js'], ...tseslint.configs.disableTypeChecked },
  { files: ['tests/**/*.ts'], rules: { '@typescript-eslint/no-non-null-assertion': 'off', '@typescript-eslint/require-await': 'off' } },
);
