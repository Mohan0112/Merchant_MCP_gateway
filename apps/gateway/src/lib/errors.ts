import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodError } from 'zod';

/**
 * An expected failure with an HTTP status. Route code throws these; one error handler turns them
 * into RFC 9457 problem+json responses, so every API error has the same shape.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Sign in to continue.') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that.') =>
  new AppError(403, 'forbidden', message);
export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found.`);
export const conflict = (message: string) => new AppError(409, 'conflict', message);

/** Validation failure from a Zod schema, with field-level issues for the dashboard's forms. */
export function fromZodError(error: ZodError): AppError {
  return badRequest(
    'Some fields are invalid.',
    error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
  );
}

const TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  413: 'Payload too large',
  415: 'Unsupported media type',
  429: 'Too many requests',
  500: 'Internal server error',
};

/** Fastify error handler producing application/problem+json. Internals of 5xx errors never leak. */
export function problemHandler(
  error: FastifyError | AppError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const status = error instanceof AppError ? error.status : (error.statusCode ?? 500);
  const code = error instanceof AppError ? error.code : (error.code ?? 'error');
  if (status >= 500) request.log.error({ err: error }, 'request failed');
  return reply
    .code(status)
    .type('application/problem+json')
    .send({
      type: 'about:blank',
      title: TITLES[status] ?? 'Error',
      status,
      code,
      detail:
        status >= 500
          ? 'Something went wrong. Quote the request id when reporting it.'
          : error.message,
      ...(error instanceof AppError && error.details ? { errors: error.details } : {}),
      instance: request.url,
      requestId: request.id,
    });
}
