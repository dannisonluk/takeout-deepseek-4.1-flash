import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    /**
     * The default `forks` pool has the worker write fetched modules into
     * `os.tmpdir()`. On locked-down Windows hosts (and inside the WorkBuddy CLI
     * fs shim) that write is denied and the run fails with a confusing
     * `EPERM ... \Temp\<rand>\ssr\<hash>` even though every assertion passed.
     * `threads` keeps module resolution in-process and needs no temp files.
     */
    pool: 'threads',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
    },
  },
});
