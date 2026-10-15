import { pino, type DestinationStream, type Logger } from 'pino';

/**
 * Paths whose values must never reach a log line (NFR-SEC-04). `*.x` matches one level deep,
 * which covers request bodies and the objects we pass to log calls.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'password',
  'credential',
  'apiKey',
  'token',
  'secret',
  '*.password',
  '*.credential',
  '*.apiKey',
  '*.token',
  '*.secret',
];

export interface LoggerOptions {
  level?: string;
  /** Where log lines go. Defaults to stdout; tests pass a capture stream. */
  destination?: DestinationStream;
}

export function createLogger(service: string, options: LoggerOptions = {}): Logger {
  return pino(
    {
      level: options.level ?? process.env.LOG_LEVEL ?? 'info',
      base: { service },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    options.destination,
  );
}

export type { Logger };
