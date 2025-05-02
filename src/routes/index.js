/**
 * Main API Routes Plugin
 * Combines all API routes and registers them under a common prefix.
 */
// import express from "express"; // Removed
import modelRoutesPlugin from "./modelRoutes.js";
import chatRoutesPlugin from "./chatRoutes.js";
// Import config or package.json directly if needed for version
// import config from "../config/config.js"; 
// import pkg from '../../package.json' assert { type: 'json' }; // Example for package.json
import logger from "../utils/logger.js";

// Fastify Plugin function
async function mainApiRoutes (fastify) {

  // Status endpoint for API health check
  fastify.get("/status", (request, reply) => {
    reply.send({
      status: "ok",
      timestamp: new Date().toISOString()
    });
  });

  // Version info route
  fastify.get("/version", (request, reply) => {
    // Reading package.json version might require different import methods depending on Node version/setup
    // Using process.env is often simpler if available
    reply.send({
      version: process.env.npm_package_version || "1.7.0", 
      apiVersion: "v1",
      timestamp: new Date().toISOString()
    });
  });

  // Add test auth endpoint
  fastify.get("/test-auth", (request, reply) => {
    logger.debug("TEST AUTH ENDPOINT CALLED");
    logger.debug(`User authenticated: ${!!request.user}`);
    if (request.user) {
      logger.debug(`User ID: ${request.user.uid}`);
      return reply.send({
        authenticated: true,
        user: request.user
      });
    } else {
      return reply.send({
        authenticated: false,
        message: "No user found in request object. Authentication hook may not be running."
      });
    }
  });

  // Register nested route plugins
  await fastify.register(modelRoutesPlugin, { prefix: "/models" });
  await fastify.register(chatRoutesPlugin, { prefix: "/chat" });

}

// export default router; // Removed
export default mainApiRoutes; // Export the plugin function