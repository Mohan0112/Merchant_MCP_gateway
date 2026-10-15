import type { ZodType } from 'zod';
import { fromZodError } from './errors';

/** Validates a request body or params with a shared contract schema; 400 with field errors on failure. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data ?? {});
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}

/** Timestamps cross the API as ISO strings. */
export const iso = (date: Date | null | undefined): string | null =>
  date ? date.toISOString() : null;
