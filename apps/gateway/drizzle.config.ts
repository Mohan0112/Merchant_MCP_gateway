import { defineConfig } from 'drizzle-kit';

// `pnpm db:generate` turns schema changes into SQL migrations in ./drizzle (no database needed).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
