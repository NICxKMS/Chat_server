import os from "os";
import config from "../config/config.js";
import * as cache from "../utils/cache.js";
import { getCircuitBreakerStates } from "../utils/circuitBreaker.js";

/**
 * Info Routes Plugin
 * Provides health, status, version, and readiness endpoints
 */
export default async function infoRoutes(fastify) {
  // Consolidated health and status handler with extended info
  const healthHandler = (request, reply) => {
    // System metrics
    const system = {
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage(),
      loadAverage: os.loadavg(),
      platform: os.platform(),
      hostname: os.hostname()
    };

    // Cache stats
    let cacheStats = { enabled: false };
    try {
      if (typeof cache.getStats === "function") {
        cacheStats = { ...cache.getStats(), enabled: true };
      }
    } catch (err) {
      cacheStats = { enabled: false, error: err.message };
    }

    // Circuit breaker states
    const circuitBreakers = getCircuitBreakerStates();

    reply.send({
      status: "ok",
      uptime: process.uptime(),
      version: config.version,
      environment: config.environment,
      system,
      cacheStats,
      circuitBreakers,
      timestamp: new Date().toISOString()
    });
  };

  // Liveness and health checks
  fastify.get("/health", healthHandler);
  fastify.get("/status", healthHandler);

  // Readiness check: fail if any circuit is open
  fastify.get("/ready", (request, reply) => {
    const states = getCircuitBreakerStates();
    const openCircuits = Object.values(states).filter(s => s.state === "open");
    if (openCircuits.length > 0) {
      return reply.status(503).send({
        ready: false,
        openCircuits,
        timestamp: new Date().toISOString()
      });
    }
    reply.send({ ready: true, timestamp: new Date().toISOString() });
  });

  // Version information
  fastify.get("/version", (request, reply) => {
    reply.send({
      version: config.version,
      apiVersion: "v1",
      environment: config.environment,
      timestamp: new Date().toISOString()
    });
  });
} 