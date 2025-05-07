/**
 * Fastify Error Handler
 * Centralized error handling for the application.
 * Provides standardized JSON error responses.
 */
import logger from "../utils/logger.js"; // Use a structured logger

// Map common error names/types to HTTP status codes
const ERROR_STATUS_MAP = {
  ValidationError: 400,
  BadRequestError: 400,
  AuthenticationError: 401,
  UnauthorizedError: 403,
  ForbiddenError: 403,
  NotFoundError: 404,
  ConflictError: 409,
  RateLimitError: 429, // Usually handled before this by rate limiter hook sending response
  InternalServerError: 500,
  ServiceUnavailableError: 503,
  TimeoutError: 504,
  ProviderError: 502, // Bad Gateway often suitable for upstream provider issues
  ProviderClientError: 400, // Default client error from provider
  // Add Fastify's default validation error code for mapping
  FST_ERR_VALIDATION: 400,
};

/**
 * Centralized Error Handler for Fastify.
 * Catches errors thrown in routes/hooks or passed via reply.send(error).
 * @param {Error & { statusCode?: number; validation?: any; code?: string; status?: number; details?: any }} error - The error object.
 * @param {FastifyRequest} request
 * @param {FastifyReply} reply
 */
export default function fastifyErrorHandler(error, request, reply) {
  // Determine HTTP status code
  // Prioritize Fastify validation errors, then explicit status codes, then mapped names/codes
  let statusCode = error.validation ? 400 :                  // Fastify validation error
    reply.statusCode >= 400 ? reply.statusCode : // Status code already set on reply
      error.statusCode || error.status ||           // Explicit status code on error object
                   ERROR_STATUS_MAP[error.code] ||            // Map error codes (e.g., FST_ERR_VALIDATION)
                   ERROR_STATUS_MAP[error.name] ||            // Map custom error names
                   500;                                       // Default to 500

  // Special handling for Fastify validation errors to extract details
  let validationDetails = null;
  let errorName = error.name || "Error";
  let errorCode = error.code || error.name || "InternalServerError";

  if (error.validation) {
    statusCode = 400; // Ensure 400 for validation
    errorName = "ValidationError";
    errorCode = "FST_ERR_VALIDATION"; // Use Fastify's code
    validationDetails = error.validation.map(v => ({
      field: v.instancePath.substring(1) || "request", // Clean up path, default to 'request'
      message: v.message
    }));
  } else {
    // Use mapped code if found, otherwise keep original/name
    errorCode = ERROR_STATUS_MAP[error.code] ? error.code : 
      ERROR_STATUS_MAP[error.name] ? error.name : 
        errorCode; // Fallback
  }

  // Log the error details
  const logContext = {
    error_name: errorName,
    error_message: error.message,
    error_code: errorCode,
    status_code: statusCode,
    path: request.raw.url, // Or request.url
    method: request.method,
    ip: request.ip,
    ...(validationDetails && { validation_details: validationDetails }) // Include validation details if present
  };
  if (statusCode >= 500 || process.env.NODE_ENV !== "production") {
    logContext.stack = error.stack;
  }
  logger.error("API Error Handled", logContext);

  // Check if response has already been sent using reply.sent
  if (reply.sent || (reply.raw && reply.raw.headersSent)) {
    logger.warn("Reply already sent, cannot send error response.", { path: request.raw.url });
    return; // Don't attempt to send again
  }

  // Construct standardized JSON error response
  const errorResponse = {
    error: {
      code: errorCode,
      message: error.message || "An unexpected error occurred.",
      status: statusCode,
      // Include validation details directly if present
      ...(validationDetails && { details: validationDetails }), 
      // Optionally include other details in development (but not for validation errors)
      ...(process.env.NODE_ENV === "development" && !validationDetails && error.details && { details: error.details }),
      timestamp: new Date().toISOString(),
      path: request.raw.url, // Or request.url
    }
  };

  // Send the response using reply.status().send()
  reply.status(statusCode).send(errorResponse);
} 