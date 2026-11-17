import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Webview tests opt into a DOM with a `// @vitest-environment happy-dom` comment.
    include: ['test/unit/**/*.test.ts', 'test/webview/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
