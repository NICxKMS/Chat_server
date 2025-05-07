/**
 * Chat Routes Plugin
 * Routes for the chat API endpoints
 */
import chatController from "../controllers/ChatController.js";
import { chatPayloadSchema, stopSchema } from "../schemas/chatSchemas.js";

// Fastify Plugin function
async function chatRoutes (fastify) {

  /**
   * POST /completions (within plugin prefix)
   * Endpoint for standard (non-streaming) chat completion requests.
   */
  fastify.post(
    "/completions",
    { schema: chatPayloadSchema },
    chatController.chatCompletion
  );

  /**
   * POST /stream (within plugin prefix)
   * Endpoint for streaming chat completion requests.
   */
  fastify.post(
    "/stream",
    { schema: chatPayloadSchema },
    chatController.chatCompletionStream
  );

  /**
   * POST /stop (within plugin prefix)
   * Endpoint for stopping an ongoing generation (streaming or non-streaming)
   */
  fastify.post(
    "/stop",
    { schema: stopSchema },
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