import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.{js,mjs}'],
    // Each suite binds its own ephemeral ports and (for Postgres suites) shares
    // one database; running files sequentially keeps them from racing.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
