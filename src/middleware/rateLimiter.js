/**
 * Rate Limiter Hook for Fastify
 * Implements rate limiting based on request IP or user ID using rate-limiter-flexible.
 */
import { RateLimiterMemory } from "rate-limiter-flexible";
import logger from "../utils/logger.js";
import config from "../config/config.js";

// Default rate limit options (adjust defaults as needed)
const defaultLimiterOptions = {
  points: config.rateLimiting?.options?.points || 100, // Default: 100 points
  duration: config.rateLimiting?.options?.duration || 60, // Default: per 60 seconds
  blockDuration: config.rateLimiting?.options?.blockDuration || 60 * 15 // Default: Block for 15 minutes
};

// Create a rate limiter instance
const rateLimiter = new RateLimiterMemory(defaultLimiterOptions);

/**
 * Fastify onRequest Hook for Rate Limiting.
 * @param {FastifyRequest} request
 * @param {FastifyReply} reply
 */
export default async function rateLimiterHook(request, reply) {
  // Skip rate limiting if disabled in config
  if (config.rateLimiting?.enabled === false) {
    return; // Continue request lifecycle
  }

  // Determine client identifier (prefer user ID if available from auth, fallback to IP)
  // Assumes authentication middleware might decorate 'request.user'
  const userId = request.user?.id || "";
  const clientIp = request.ip || ""; // Fastify provides request.ip
  const key = userId || clientIp;

  if (!key) {
    // Log a warning if no identifier could be found
    logger.warn("Rate limiter hook: No client identifier found (IP or User), skipping check for request path:", request.raw.url);
    return; // Continue request lifecycle
  }

  try {
    // Consume points asynchronously
    const rateLimiterRes = await rateLimiter.consume(key);

    // Set rate limit headers on successful consumption using reply.header
    reply.header("X-RateLimit-Limit", defaultLimiterOptions.points);
    reply.header("X-RateLimit-Remaining", rateLimiterRes.remainingPoints);
    reply.header("X-RateLimit-Reset", new Date(Date.now() + rateLimiterRes.msBeforeNext).toISOString());

    // Allow request to continue by returning void/undefined implicitly
    return;

  } catch (rateLimiterRes) {
    // Catch the error thrown by rate-limiter-flexible when limit is exceeded
    if (rateLimiterRes instanceof Error) {
        // Handle unexpected errors during rate limiting itself
        logger.error("Unexpected error in rate limiter consumption:", rateLimiterRes);
        // Decide if you want to let the request proceed or send a generic error
        // For safety, maybe block the request
        return reply.status(500).send({ error: "Internal Server Error", message: "Error during rate limit check." });
    }

    // If it's not an Error, it's the rejection object from rate-limiter-flexible
    logger.warn(`Rate limit exceeded for key: ${key} on path: ${request.raw.url}`);

    // Set headers for rate limit exceeded response using reply.header
    reply.header("X-RateLimit-Limit", defaultLimiterOptions.points);
    reply.header("X-RateLimit-Remaining", 0); // Remaining points are 0 when blocked
    reply.header("X-RateLimit-Reset", new Date(Date.now() + rateLimiterRes.msBeforeNext).toISOString());
    reply.header("Retry-After", Math.ceil(rateLimiterRes.msBeforeNext / 1000)); // Set Retry-After header

    // Send 429 response using reply.status().send() and stop request lifecycle
    // Note: We 'return' the reply object to halt further processing in Fastify hooks
    return reply.status(429).send({
      error: "Too Many Requests",
      message: "Rate limit exceeded, please try again later.",
      retryAfterSeconds: Math.ceil(rateLimiterRes.msBeforeNext / 1000)
    });
  }
}