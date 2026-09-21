import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Cấu hình ESLint (flat config — bắt buộc từ ESLint 9) cho frontend.
 *
 * Trước đây repo có script `lint` gọi eslint nhưng KHÔNG có file config nào, nên chạy là lỗi
 * ngay. File `.oxlintrc.json` còn sót lại là rác từ template Vite (oxlint chưa từng được cài),
 * đã xoá — dự án đi theo ESLint vì cả frontend lẫn backend đều khai báo sẵn eslint +
 * @typescript-eslint trong devDependencies.
 *
 * Mức độ rule cố ý ĐỂ THẤP (warn) ở những chỗ code hiện tại đang vi phạm nhiều: mục tiêu trước
 * mắt là có lint chạy được và bắt được lỗi thật (rules-of-hooks), không phải bắt cả team đi sửa
 * hàng trăm cảnh báo trong code đang chạy tốt. Siết dần về 'error' sau.
 */
export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'eslint.config.js'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,

      // Lỗi THẬT, phải chặn: gọi hook trong điều kiện/vòng lặp sẽ gây bug state khó lần ra.
      'react-hooks/rules-of-hooks': 'error',
      // Chỉ cảnh báo: repo đang có 2 chỗ cố ý bỏ qua (TiptapEditor, WikiPage) kèm giải thích rõ.
      'react-hooks/exhaustive-deps': 'warn',

      // Code hiện dùng `any` ở các handler bắt lỗi axios — cảnh báo để dọn dần, không chặn build.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];
