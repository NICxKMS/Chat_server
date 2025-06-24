/**
 * Main API Routes Plugin
 * Combines all API routes and registers them under a common prefix.
 */
// import express from "express"; // Removed
import modelRoutesPlugin from "./modelRoutes.js";
import chatRoutesPlugin from "./chatRoutes.js";
import infoRoutesPlugin from "./infoRoutes.js"; // Consolidated health/status/version
// Import config or package.json directly if needed for version
// import config from "../config/config.js"; 
// import pkg from "../../package.json"; // Example for package.json

// Fastify Plugin function
async function mainApiRoutes (fastify) {

  // Consolidated health, status, and version endpoints under /api
  await fastify.register(infoRoutesPlugin);

  // Register nested route plugins
  await fastify.register(modelRoutesPlugin, { prefix: "/models" });
  await fastify.register(chatRoutesPlugin, { prefix: "/chat" });

}

export default mainApiRoutes; // Export the plugin function