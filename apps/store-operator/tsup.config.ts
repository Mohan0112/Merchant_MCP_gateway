import { defineConfig } from 'tsup';

// One self-contained file (dependencies included) so the runtime image needs no node_modules.
export default defineConfig({
  entry: { server: 'src/main.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  noExternal: [/.*/],
  splitting: false,
  sourcemap: true,
  clean: true,
  outExtension: () => ({ js: '.mjs' }),
  // Bundled CommonJS dependencies still call require(); give the ESM bundle a real one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
