/**
 * Main API Routes Plugin
 * Combines all API routes and registers them under a common prefix.
 */
// import express from "express"; // Removed
import modelRoutesPlugin from "./modelRoutes.js";
import chatRoutesPlugin from "./chatRoutes.js";
// Import config or package.json directly if needed for version
// import config from "../config/config.js"; 
// import pkg from "../../package.json"; // Example for package.json

// Fastify Plugin function
async function mainApiRoutes (fastify) {

  // Status endpoint for API health check
  fastify.get("/status", (request, reply) => {
    // Return the send promise
    return reply.send({
      status: "ok",
      timestamp: new Date().toISOString()
    });
  });

  // Version info route
  fastify.get("/version", (request, reply) => {
    // Return the send promise
    return reply.send({
      version: process.env.npm_package_version || "1.8.5", 
      apiVersion: "v1",
      timestamp: new Date().toISOString()
    });
  });



  // Register nested route plugins
  await fastify.register(modelRoutesPlugin, { prefix: "/models" });
  await fastify.register(chatRoutesPlugin, { prefix: "/chat" });

}

export default mainApiRoutes; // Export the plugin function