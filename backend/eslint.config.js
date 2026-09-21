const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

/**
 * Cấu hình ESLint (flat config — bắt buộc từ ESLint 9) cho backend.
 *
 * Viết theo CommonJS vì backend KHÔNG khai báo "type": "module" trong package.json (khác
 * frontend). Đổi sang cú pháp import sẽ lỗi khi ESLint nạp file này.
 *
 * Không bật rule cần type-checking (project service) để lint chạy nhanh và không phụ thuộc
 * tsconfig — việc kiểm kiểu đã có `npm run typecheck` lo.
 */
module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**', 'drizzle/**', 'eslint.config.js'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,

      // `declare global { namespace Express { interface Request { user?: AuthUser } } }` trong
      // middleware/auth.ts là cách CHÍNH THỐNG để mở rộng kiểu của Express — không có cú pháp
      // ES module nào thay thế được. allowDeclarations cho phép đúng trường hợp này, vẫn chặn
      // namespace thường.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],

      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];
