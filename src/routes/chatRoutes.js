/**
 * Chat Routes Plugin
 * Routes for the chat API endpoints
 */
import chatController from "../controllers/ChatController.js";

// Fastify Plugin function
async function chatRoutes (fastify) {

  // JSON schema for chat payloads (validates and coerces types)
  const chatPayloadSchema = {
    body: {
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
              role: { type: "string", enum: ["system","user","assistant"] },
              content: { anyOf: [
                { type: "string" },
                { type: "array" },
                { type: "object" }
              ] }
            },
            additionalProperties: false
          },
          minItems: 1
        },
        temperature:       { type: "number", default: 0.7 },
        max_tokens:        { type: "integer", default: 1000 },
        top_p:             { type: "number" },
        frequency_penalty: { type: "number" },
        presence_penalty:  { type: "number" },
        requestId:         { type: "string" }
      },
      additionalProperties: false
    }
  };

  // JSON schema for stop endpoint
  const stopSchema = {
    body: {
      type: "object",
      required: ["requestId"],
      properties: {
        requestId: { type: "string" }
      },
      additionalProperties: false
    }
  };

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
    {
      schema: chatPayloadSchema
    },
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