import * as path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // 拡張ホストの `vscode` モジュールはテスト環境に存在しないため、モックへ差し替える。
      vscode: path.resolve(import.meta.dirname, 'tests/mocks/vscode.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      // Bun ランタイムでは v8 provider が壊れるため istanbul を使う（plan.md 0.5-5）。
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
