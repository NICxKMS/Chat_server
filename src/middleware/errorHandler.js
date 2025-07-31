/**
 * @file Fastify Error Handler
 * @description Centralized, high-performance error handling for the application.
 * @version 2.0.0
 */

import logger from "../utils/logger.js";

const ERROR_STATUS_MAP = {
  ValidationError: 400,
  BadRequestError: 400,
  AuthenticationError: 401,
  UnauthorizedError: 403,
  ForbiddenError: 403,
  NotFoundError: 404,
  ConflictError: 409,
  RateLimitError: 429,
  InternalServerError: 500,
  ServiceUnavailableError: 503,
  TimeoutError: 504,
  ProviderError: 502,
  ProviderClientError: 400,
  FST_ERR_VALIDATION: 400,
};

/**
 * Maps an error to a standardized response payload.
 * @param {Error} error - The error object.
 * @param {import('fastify').FastifyRequest} request - The Fastify request object.
 * @returns {{statusCode: number, payload: object}}
 */
function mapErrorToResponse(error, request) {
  const statusCode =
    (error.validation && 400) ||
    error.statusCode ||
    error.status ||
    ERROR_STATUS_MAP[error.name] ||
    ERROR_STATUS_MAP[error.code] ||
    500;

  let details = error.validation
    ? error.validation.map((v) => ({
      field: v.instancePath.substring(1) || "request",
      message: v.message,
    }))
    : undefined;

  const payload = {
    error: {
      code: error.code || error.name || "InternalServerError",
      message: error.message || "An unexpected error occurred.",
      status: statusCode,
      details,
      timestamp: new Date().toISOString(),
      path: request.raw.url,
    },
  };

  return { statusCode, payload };
}

/**
 * Centralized Error Handler for Fastify.
 * @param {Error} error - The error object.
 * @param {import('fastify').FastifyRequest} request - The Fastify request object.
 * @param {import('fastify').FastifyReply} reply - The Fastify reply object.
 */
export default function fastifyErrorHandler(error, request, reply) {
  const { statusCode, payload } = mapErrorToResponse(error, request);

  // Avoid logging validation errors as full errors unless in development.
  if (statusCode === 400 && error.validation) {
    logger.info("Validation Error", {
      error: payload.error,
      ip: request.ip,
    });
  } else {
    logger.error("API Error Handled", {
      error: payload.error,
      stack: statusCode >= 500 ? error.stack : undefined,
    });
  }

  if (reply.sent) {
    logger.warn("Reply already sent, cannot send error response.", {
      path: request.raw.url,
    });
    return;
  }

  reply.status(statusCode).send(payload);
}
