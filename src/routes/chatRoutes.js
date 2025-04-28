/**
 * Chat Routes Plugin
 * Routes for the chat API endpoints
 */
// import express from "express"; // Removed
import chatController from "../controllers/ChatController.js";
// import cors from "cors"; // Removed - Handled globally by @fastify/cors

// JSON schema for chat requests
const chatRequestSchema = {
  type: "object",
  required: ["model", "messages"],
  properties: {
    model: { type: "string" },
    messages: {
      type: "array",
      items: {
        type: "object",
        required: ["role", "content"],
        properties: {
          role: { type: "string" },
          content: { type: ["string", "object", "array", "number", "boolean"] }
        }
      }
    },
    temperature: { type: "number", default: 0.7 },
    max_tokens: { type: "integer", default: 1000 },
    top_p: { type: "number" },
    frequency_penalty: { type: "number" },
    presence_penalty: { type: "number" }
  }
};
// Schema for stopGeneration
const stopRequestSchema = {
  type: "object",
  required: ["requestId"],
  properties: { requestId: { type: "string" } }
};

// Fastify Plugin function
async function chatRoutes (fastify, options) {

  // The explicit OPTIONS handler is removed as @fastify/cors handles preflight requests.

  /**
   * POST /completions (within plugin prefix)
   * Endpoint for standard (non-streaming) chat completion requests.
   */
  fastify.post(
    "/completions",
    { schema: { body: chatRequestSchema } },
    chatController.chatCompletion
  );

  /**
   * POST /stream (within plugin prefix)
   * Endpoint for streaming chat completion requests.
   */
  fastify.post(
    "/stream",
    { schema: { body: chatRequestSchema } },
    chatController.chatCompletionStream
  );

  /**
   * POST /stop (within plugin prefix)
   * Endpoint for stopping an ongoing generation (streaming or non-streaming)
   */
  fastify.post(
    "/stop",
    { schema: { body: stopRequestSchema } },
    chatController.stopGeneration
  );

  /**
   * GET /capabilities (within plugin prefix)
   * Get chat capabilities and system status
   */
  fastify.get("/capabilities", chatController.getChatCapabilities);

}

// Export plugin function
export default chatRoutes;