/**
 * Chat Routes Plugin
 * Routes for the chat API endpoints
 */
// import express from "express"; // Removed
import chatController from "../controllers/ChatController.js";
// import cors from "cors"; // Removed - Handled globally by @fastify/cors

// Fastify Plugin function
async function chatRoutes (fastify) {

  // The explicit OPTIONS handler is removed as @fastify/cors handles preflight requests.

  /**
   * POST /completions (within plugin prefix)
   * Endpoint for standard (non-streaming) chat completion requests.
   */
  fastify.post("/completions", chatController.chatCompletion);

  /**
   * POST /stream (within plugin prefix)
   * Endpoint for streaming chat completion requests.
   */
  fastify.post("/stream", chatController.chatCompletionStream);

  /**
   * POST /stop (within plugin prefix)
   * Endpoint for stopping an ongoing generation (streaming or non-streaming)
   */
  fastify.post("/stop", chatController.stopGeneration);

  /**
   * GET /capabilities (within plugin prefix)
   * Get chat capabilities and system status
   */
  fastify.get("/capabilities", chatController.getChatCapabilities);

}

// Export plugin function
export default chatRoutes;