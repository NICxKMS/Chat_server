/**
 * Chat Controller
 * Handles all chat-related API endpoints with optimized performance
 */
import providerFactory from "../providers/ProviderFactory.js";
import * as cache from "../utils/cache.js";
import * as metrics from "../utils/metrics.js";
import { getCircuitBreakerStates } from "../utils/circuitBreaker.js";
import logger from "../utils/logger.js";
import { PassThrough } from "stream";

// Helper function to roughly validate base64 (more robust checks might be needed)

// Increased payload size limit for image data
export const bodyLimit = 10 * 1024 * 1024; // 10MB

// Heartbeat and inactivity timeout settings
const HEARTBEAT_INTERVAL_MS = 15000; // Send a heartbeat every 15 seconds
const TIMEOUT_DURATION_MS = 120000; // Timeout stream after 2 minutes of inactivity

// Map to store active generations (requestId -> AbortController)
const activeGenerations = new Map();

class ChatController {
  constructor() {
    // Bind methods (consider if still necessary with Fastify style)
    this.chatCompletion = this.chatCompletion.bind(this);
    this.chatCompletionStream = this.chatCompletionStream.bind(this);
    this.getChatCapabilities = this.getChatCapabilities.bind(this);
    this.stopGeneration = this.stopGeneration.bind(this);
  }

  /**
   * Handles standard (non-streaming) chat completion requests.
   * Performs validation, caching, provider selection, and calls the provider's `chatCompletion` method.
   * @param {FastifyRequest} request - Fastify request object.
   * @param {FastifyReply} reply - Fastify reply object.
   */
  async chatCompletion(request, reply) {
    let providerName, modelName; // Declare here for potential use in error logging
    // Create an AbortController and derive requestId (client-supplied wins)
    let abortController = new AbortController();
    const clientRequestId = request.body?.requestId;
    const requestId = clientRequestId || request.id || `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    try {
      // Extract all validated/coerced body properties (validation done by Fastify schema)
      const { model, messages, temperature, max_tokens, top_p, frequency_penalty, presence_penalty, nocache } = request.body;
      
      // Extract provider name and model name
      const separatorIndex = model.indexOf("/");
      if (separatorIndex !== -1) { // Check if "/" exists
        providerName = model.substring(0, separatorIndex); // Part before the first "/"
        modelName = model.substring(separatorIndex + 1); // Part after the first "/"
      } else {
        // Fallback logic (unchanged)
        const defaultProvider = providerFactory.getProvider();
        providerName = defaultProvider.name;
        modelName = model;
      }
      
      const provider = providerFactory.getProvider(providerName);
      
      if (!provider) {
        const err = new Error(`Provider '${providerName}' not found or not configured.`);
        err.name = "NotFoundError";
        throw err;
      }
      
      // logger.info(`Processing chat request for ${providerName}/${modelName} (requestId: ${requestId})`);
      
      // Store the abort controller keyed by our requestId
      activeGenerations.set(requestId, abortController);
      
      // Echo the requestId back for consistency
      reply.header("X-Request-ID", requestId);
      // Disable Nagle for low-latency small responses
      if (reply.raw.socket && typeof reply.raw.socket.setNoDelay === "function") {
        reply.raw.socket.setNoDelay(true);
      }
      
      // Cache check logic 
      try {
        if (typeof cache.isEnabled === "function" && cache.isEnabled() && !nocache) {
          try {
            const cacheKeyData = { provider: providerName, model: modelName, messages, temperature, max_tokens };
            const cacheKey = cache.generateKey(cacheKeyData);
            const cachedResponse = await cache.get(cacheKey);
            if (cachedResponse) {
              logger.info(`Cache hit for ${providerName}/${modelName}`);
              cachedResponse.cached = true;
              
              // Remove from active generations since we're using cached response
              activeGenerations.delete(requestId);
              
              return reply.send(cachedResponse); // Use reply.send
            }
          } catch (cacheError) {
            logger.warn(`Cache error: ${cacheError.message}. Continuing without cache.`);
          }
        }
      } catch (cacheCheckError) {
        logger.warn(`Failed to check cache status: ${cacheCheckError.message}. Continuing without cache.`);
      }
      
      // Prepare options with validated/coerced values
      const options = {
        model: modelName,
        messages,
        temperature,
        max_tokens,
        abortSignal: abortController.signal
      };
      // Add optional parameters
      if (top_p !== undefined) { options.top_p = top_p; }
      if (frequency_penalty !== undefined) { options.frequency_penalty = frequency_penalty; }
      if (presence_penalty !== undefined) { options.presence_penalty = presence_penalty; }
      
      try {
        // Send request to provider (unchanged)
        const response = await provider.chatCompletion(options);
        
        // Remove from active generations after completion
        activeGenerations.delete(requestId);
        
        // Cache set logic 
        try {
          if (typeof cache.isEnabled === "function" && cache.isEnabled() && !nocache) {
            try {
              const cacheKeyData = { provider: providerName, model: modelName, messages, temperature, max_tokens };
              const cacheKey = cache.generateKey(cacheKeyData);
              await cache.set(cacheKey, response);
            } catch (cacheError) {
              logger.warn(`Failed to cache response: ${cacheError.message}`);
            }
          }
        } catch (cacheCheckError) {
          logger.warn(`Failed to check cache status: ${cacheCheckError.message}`);
        }
        
        // Return the response using reply.send
        return reply.send(response); // Explicit return

      } catch (providerError) {
        // Remove from active generations on error
        activeGenerations.delete(requestId);
        
        // Check if this was an abort error
        if (
          providerError.name === "AbortError" ||
          (providerError.message && /aborted|canceled/i.test(providerError.message))
        ) {
          logger.info(`Request ${requestId} was aborted`);
          return reply.status(499).send({
            error: "Request aborted",
            message: "The generation was stopped by the client"
          });
        }
        
        logger.error(`Provider error in chatCompletion: ${providerError.message}`, { provider: providerName, model: modelName, stack: providerError.stack });

        // TODO: Review error handling strategy.
        // Consider throwing specific custom error types from providers/services
        // and centralizing status code mapping and response formatting solely
        // within the fastifyErrorHandler.
        let mappedError = providerError; 
        if (providerError.message) { 
          if (/authentication|api key|invalid_request_error.*api_key/i.test(providerError.message)) {
            mappedError = new Error(`Authentication failed with provider ${providerName}. Check your API key.`);
            mappedError.status = 401;
            mappedError.name = "AuthenticationError";
          } else if (/rate limit|quota exceeded/i.test(providerError.message)) {
            mappedError = new Error(`Rate limit exceeded for provider ${providerName}.`);
            mappedError.status = 429;
            mappedError.name = "RateLimitError";
          } else if (/model not found|deployment does not exist/i.test(providerError.message)) {
            mappedError = new Error(`Model '${modelName}' not found or unavailable for provider ${providerName}.`);
            mappedError.status = 404;
            mappedError.name = "NotFoundError";
          } else if (providerError.response?.status && providerError.response.status >= 400 && providerError.response.status < 500) {
            mappedError = new Error(`Provider ${providerName} returned client error ${providerError.response.status}: ${providerError.message}`);
            mappedError.status = providerError.response.status;
            mappedError.name = "ProviderClientError";
          } else {
            mappedError = new Error(`Provider ${providerName} encountered an error: ${providerError.message}`);
            mappedError.status = 502;
            mappedError.name = "ProviderError";
          }
        }
        
        // Throw error instead of calling next()
        throw mappedError; 

      }
    } catch (error) {
      // Remove from active generations on error
      activeGenerations.delete(requestId);
      
      // Catch errors from validation, provider setup, caching, or thrown provider errors
      logger.error(`Server error in chatCompletion handler: ${error.message}`, { provider: providerName, model: modelName, stack: error.stack });
      
      // Send error response as HTTP 200 with an `error` field to avoid fetch network error
      if (!reply.sent) {
        const errorPayload = {
          id: requestId,
          model: modelName,
          provider: providerName,
          error: {
            message: error.message || "An unexpected error occurred.",
            code: error.status || error.statusCode || 500,
            type: error.code || error.name || "ServerError"
          },
          finishReason: "error",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latency: null
        };
        return reply.status(200).send(errorPayload);
      }

      // Throw error to be handled by Fastify's central error handler if already sent
      throw error; 
    }
    
    // Clean up in case of unexpected exit
    finally {
      // Remove from active generations on finally (safety measure)
      if (requestId) {
        activeGenerations.delete(requestId);
      }
    }
  }

  /**
   * Handles streaming chat completion requests using Server-Sent Events (SSE).
   * Sets up SSE headers, calls the provider's `chatCompletionStream` async generator,
   * pipes the resulting chunks to the client, and handles timeouts/disconnects.
   * Uses reply.raw for direct stream manipulation.
   * @param {FastifyRequest} request - Fastify request object.
   * @param {FastifyReply} reply - Fastify reply object.
   */
  async chatCompletionStream(request, reply) {
    let providerName, modelName;
    let streamClosed = false; 
    let lastActivityTime = Date.now();
    let heartbeatInterval = null;
    let timeoutCheckInterval = null;
    let abortController = new AbortController();
    const clientRequestId = request.body?.requestId;
    const requestId = clientRequestId || request.id || `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    let streamStartTime = null;
    let ttfbRecorded = false;
    let lastProviderChunk = null;

    activeGenerations.set(requestId, abortController);
    await new Promise(resolve => setImmediate(resolve));
    const stream = new PassThrough({
      highWaterMark: 1,  // Use smallest highWaterMark to ensure immediate chunk delivery
      autoDestroy: true  // Automatically destroy when finished
    });

    const safelyEndStream = (message, errorType = null) => {
      if (!streamClosed) {

        streamClosed = true;
        
        if (heartbeatInterval) { clearInterval(heartbeatInterval); }
        if (timeoutCheckInterval) { clearInterval(timeoutCheckInterval); }
        
        if (streamStartTime && providerName && modelName) {
          const durationSeconds = (Date.now() - streamStartTime) / 1000;
          metrics.recordStreamDuration(providerName, modelName, durationSeconds);
        }
        
        if (errorType && providerName && modelName) {
          metrics.incrementStreamErrorCount(providerName, modelName, errorType);
        }

        // Remove from active generations
        activeGenerations.delete(requestId);

        // Conditionally write and flush final marker, then close or destroy
        if (!stream.writableEnded && stream.writable) {
          stream.write("data: [DONE]\n\n");
          stream.uncork && stream.uncork();
          stream.end();
        } else if (!stream.destroyed) {
          stream.destroy();
        }
      }
    };

    try {
      // Extract all validated/coerced body properties (validation done by Fastify schema)
      const { model, messages, temperature, max_tokens, top_p, frequency_penalty, presence_penalty } = request.body;
      const separatorIndex = model.indexOf("/");
      if (separatorIndex !== -1) {
        providerName = model.substring(0, separatorIndex);
        modelName = model.substring(separatorIndex + 1);
      } else {
        const defaultProvider = providerFactory.getProvider();
        providerName = defaultProvider.name;
        modelName = model;
      }

      const provider = providerFactory.getProvider(providerName);
      if (!provider) {
        const err = new Error(`Provider '${providerName}' not found or not configured.`);
        err.name = "NotFoundError";
        throw err;
      }

      streamStartTime = Date.now();
      
      reply.header("Content-Type", "text/event-stream");
      reply.header("Cache-Control", "no-cache, no-transform");
      reply.header("X-Accel-Buffering", "no"); // Prevent nginx buffering
      reply.header("X-Request-ID", requestId); // Echo the client requestId for stop calls

      if (request.raw.httpVersion && request.raw.httpVersion.startsWith("1.")) {
        reply.header("Connection", "keep-alive");
        reply.header("Transfer-Encoding", "chunked");
        logger.debug("HTTP/1.1 detected, setting Connection and Transfer-Encoding headers for stream.");
      } else {
        logger.debug(`HTTP/2 or newer detected (${request.raw.httpVersion}), skipping HTTP/1.1 specific stream headers.`);
      }
      
      reply.send(stream);
      if (typeof reply.raw.flushHeaders === "function") {
        reply.raw.flushHeaders();
      }
      if (reply.raw.socket && typeof reply.raw.socket.setNoDelay === "function") {
        reply.raw.socket.setNoDelay(true);
      }
      lastActivityTime = Date.now();

      heartbeatInterval = setInterval(() => {
        if (!streamClosed && !stream.writableEnded) { 
          try {
            stream.write(":heartbeat\n\n");
          } catch (err) {
            safelyEndStream(`Error sending heartbeat: ${err.message}`);
          }
        }
      }, HEARTBEAT_INTERVAL_MS);

      timeoutCheckInterval = setInterval(() => {
        if (Date.now() - lastActivityTime > TIMEOUT_DURATION_MS) {
          safelyEndStream(`Stream timed out due to inactivity for ${providerName}/${modelName}`, "timeout");
          abortController.abort();
        }
      }, TIMEOUT_DURATION_MS / 2);

      request.raw.on("close", () => {
        safelyEndStream(`Client disconnected stream for ${providerName}/${modelName}`, "client_disconnect");
        abortController.abort();
      });

      const options = {
        model: modelName,
        messages,
        temperature,
        max_tokens,
        abortSignal: abortController.signal
      };
      if (top_p !== undefined) { options.top_p = top_p; }
      if (frequency_penalty !== undefined) { options.frequency_penalty = frequency_penalty; }
      if (presence_penalty !== undefined) { options.presence_penalty = presence_penalty; }

      const providerStream = provider.chatCompletionStream(options);
      for await (const chunk of providerStream) {
        lastProviderChunk = chunk;
        if (streamClosed) { break; }
        lastActivityTime = Date.now();
        if (!ttfbRecorded && streamStartTime) {
          const ttfbSeconds = (Date.now() - streamStartTime) / 1000;
          metrics.recordStreamTtfb(providerName, modelName, ttfbSeconds);
          ttfbRecorded = true;
        }
        const sseFormattedChunk = `data: ${JSON.stringify(chunk)}\n\n`;
        if (!streamClosed && !stream.writableEnded) {
          try {
            stream.write(sseFormattedChunk);
            stream.uncork && stream.uncork();
          } catch (writeError) {
            logger.error(`Error writing chunk to stream: ${writeError.message}`);
            safelyEndStream(`Error writing chunk to stream: ${writeError.message}`, "write_error");
            break;
          }
        }
      }
      
      safelyEndStream(`Stream finished normally for ${providerName}/${modelName}`, null, lastProviderChunk);
      
    } catch (error) {
      logger.error(`[ChatController.chatCompletionStream] Error: ${error.message}`, {
        provider: error.providerName || providerName, // Use error.providerName if available
        model: modelName, // modelName might not be set if error was very early
        requestId: requestId,
        errorName: error.name, // e.g., ProviderRateLimitError, StreamReadError
        errorCode: error.code, // e.g., PROVIDER_RATE_LIMIT, STREAM_READ_ERROR
        statusCode: error.statusCode, // e.g., 429, 500
        details: error.details, // Raw error details from provider or system
        stack: error.stack
      });

      if (error.name === "AbortError" || (error.message && /aborted|canceled/i.test(error.message))) {
        if (!streamClosed && !stream.writableEnded) {
          try {
            const abortEventData = { type: "abort", message: "Generation was stopped by the client" };
            stream.write(`event: abort\ndata: ${JSON.stringify(abortEventData)}\n\n`);
          } catch (e) { logger.warn(`Error sending abort event: ${e.message}`); }
        }
        safelyEndStream(`Stream aborted for ${providerName || "unknown"}/${modelName || "unknown"}`, "client_abort");
        return;
      }

      const metricsErrorType = error.code || error.name || "UNKNOWN_STREAM_ERROR";

      if (!reply.raw.headersSent && !streamClosed) {
        streamClosed = true;
        if (heartbeatInterval) { clearInterval(heartbeatInterval); }
        if (timeoutCheckInterval) { clearInterval(timeoutCheckInterval); }
        
        const responseStatusCode = error.statusCode || 500;
        reply.status(responseStatusCode).type("application/json").send({
          error: {
            message: error.message || "Stream setup error before headers sent.",
            code: error.code || error.name || "STREAM_SETUP_ERROR", 
            type: error.name || "StreamSetupError",
            details: error.details,
            ...(error.providerName && { provider: error.providerName })
          }
        });
        return;
      }

      if (!streamClosed && !stream.writableEnded && reply.raw.headersSent) {
        const effectiveProviderName = error.providerName || providerName || "unknown_provider";
        const effectiveModelName = modelName || "unknown_model"; // modelName from controller scope

        const errorPayloadForStream = {
          id: `${effectiveProviderName}-stream-error-${Date.now()}`,
          model: effectiveModelName,
          provider: effectiveProviderName,
          error: {
            message: error.message || "An error occurred during streaming.",
            code: error.code || "UNKNOWN_ERROR", // Our app-specific string code
            type: error.name || "StreamError", // The actual class name of the error
            ...(error.statusCode && { httpStatusCode: error.statusCode }),
            details: error.details,
          },
          finishReason: "error",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latency: streamStartTime ? Date.now() - streamStartTime : 0
        };
        try {
          stream.write(`data: ${JSON.stringify(errorPayloadForStream)}\n\n`);
          stream.uncork && stream.uncork();
        } catch (e) {
          logger.warn(`Error writing error data to stream: ${e.message}`);
        }
        safelyEndStream(
          `Stream error for ${effectiveProviderName}/${effectiveModelName}`,
          metricsErrorType,
          lastProviderChunk 
        );
      }
    } finally {
      activeGenerations.delete(requestId);
    }
  }

  /**
   * Handles requests to stop an ongoing generation.
   * Supports stopping both streaming and non-streaming requests.
   * @param {FastifyRequest} request - Fastify request object
   * @param {FastifyReply} reply - Fastify reply object
   */
  async stopGeneration(request, reply) {
    try {
      const { requestId } = request.body;
      
      // Look up the abort controller (idempotent stop)
      const abortController = activeGenerations.get(requestId);
      if (abortController) {
        logger.info(`Stopping generation for requestId: ${requestId}`);
        abortController.abort();
        activeGenerations.delete(requestId);
      } else {
        logger.info(`No active generation for requestId: ${requestId}, ignoring stop call`);
      }
      
      return reply.send({
        success: true,
        message: `Generation stop processed for requestId: ${requestId}`
      });
    } catch (error) {
      logger.error(`Error stopping generation: ${error.message}`, { stack: error.stack });
      return reply.status(500).send({
        error: "Failed to stop generation",
        message: error.message
      });
    }
  }

  /**
   * Gets combined capabilities information from providers, cache, and system.
   * @param {FastifyRequest} request - Fastify request object.
   * @param {FastifyReply} reply - Fastify reply object.
   */
  async getChatCapabilities(request, reply) {
    try {
      const circuitBreakerStates = getCircuitBreakerStates();
      
      let cacheStats = { enabled: false };
      try {
        if (typeof cache.getStats === "function") {
          const stats = cache.getStats();
          cacheStats = { ...stats, enabled: true };
        }
      } catch (cacheError) {
        logger.warn(`Failed to get cache stats: ${cacheError.message}`);
        cacheStats = { enabled: false, error: cacheError.message };
      }
      
      const capabilities = await providerFactory.getAllProviderCapabilities();
      
      // Add return here
      return reply.send({
        capabilities: capabilities,
        defaultProvider: providerFactory.getProvider().name,
        circuitBreakers: circuitBreakerStates,
        cacheStats: cacheStats,
        systemStatus: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          timestamp: new Date().toISOString()
        }
      }); // Explicit return
    } catch (error) {
      logger.error(`Error getting chat capabilities: ${error.message}`, { stack: error.stack });
      // Throw error for Fastify's handler
      throw error; 
    }
  }
}

// Create singleton instance
const controller = new ChatController();

// Export instance
export default controller;