import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Database test files share one PostgreSQL; run files one at a time so they don't interfere.
    fileParallelism: false,
  },
});
