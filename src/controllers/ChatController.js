/**
 * Chat Controller
 * Handles all chat-related API endpoints with optimized performance
 */
import providerFactory from "../providers/ProviderFactory.js";
import * as metrics from "../utils/metrics.js";
import { getCircuitBreakerStates } from "../utils/circuitBreaker.js";
import logger from "../utils/logger.js";
import { mapProviderError } from "../utils/errorMapper.js";

// Helper function to roughly validate base64 (more robust checks might be needed)
const isPotentialBase64 = (str) => typeof str === "string" && /^[A-Za-z0-9+/=]+$/.test(str) && str.length % 4 === 0;

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
    logger.info("ChatController initialized");
  }

  /**
   * Handles standard (non-streaming) chat completion requests.
   * Performs validation, caching, provider selection, and calls the provider's `chatCompletion` method.
   * @param {FastifyRequest} request - Fastify request object.
   * @param {FastifyReply} reply - Fastify reply object.
   */
  async chatCompletion(request, reply) {
    const startTime = Date.now();
    let providerName, modelName; // Declare here for potential use in error logging
    // Create an AbortController and derive requestId (client-supplied wins)
    let abortController = new AbortController();
    const clientRequestId = request.body?.requestId;
    const requestId = clientRequestId || request.id || `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    try {
      metrics.incrementRequestCount();
      
      // Use request.body - add extraction of top_p, frequency_penalty, and presence_penalty
      const { model, messages, temperature = 0.7, max_tokens = 1000, top_p, frequency_penalty, presence_penalty } = request.body;
      
      if (!model) {
        return reply.status(400).send({ error: "Missing required parameter: model" });
      }
      
      if (!Array.isArray(messages) || messages.length === 0) {
        return reply.status(400).send({ error: "Missing or invalid messages array" });
      }
      
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
        return reply.status(404).send({ 
          error: `Provider '${providerName}' not found or not configured`
        });
      }
      
      logger.info(`Processing chat request for ${providerName}/${modelName} (requestId: ${requestId})`);
      
      // Store the abort controller keyed by our requestId
      activeGenerations.set(requestId, abortController);
      
      // Echo the requestId back for consistency
      reply.header("X-Request-ID", requestId);
      
      // Prepare options - include optional parameters only if they exist
      const options = {
        model: modelName,
        messages,
        temperature: parseFloat(temperature?.toString() || "0.7"),
        max_tokens: parseInt(max_tokens?.toString() || "1000", 10),
        abortSignal: abortController.signal
      };
      
      // Add optional parameters only if they exist in the request
      if (top_p !== undefined) {options.top_p = parseFloat(top_p);}
      if (frequency_penalty !== undefined) {options.frequency_penalty = parseFloat(frequency_penalty);}
      if (presence_penalty !== undefined) {options.presence_penalty = parseFloat(presence_penalty);}
      
      try {
        // Send request to provider
        const response = await provider.chatCompletion(options);
        
        // Remove from active generations after completion
        activeGenerations.delete(requestId);
        
        // Log and return response
        logger.debug("Provider response for chatCompletion", { response });
        return reply.send(response);

      } catch (providerError) {
        // Remove from active generations on error
        activeGenerations.delete(requestId);
        
        // Check if this was an abort error
        if (providerError.name === "AbortError" || providerError.message?.includes("aborted")) {
          logger.info(`Request ${requestId} was aborted`);
          return reply.status(499).send({
            error: "Request aborted",
            message: "The generation was stopped by the client"
          });
        }
        
        logger.error("Provider error in chatCompletion", { provider: providerName, model: modelName, error: providerError });

        // Map provider error to standardized HTTP error and rethrow
        const mappedError = mapProviderError(providerError, providerName, modelName);
        throw mappedError;

      }
    } catch (error) {
      // Remove from active generations on error
      activeGenerations.delete(requestId);
      
      // Catch errors from validation, provider setup, caching, or thrown provider errors
      logger.error(`Server error in chatCompletion handler: ${error.message}`, { provider: providerName, model: modelName, stack: error.stack });
      // Throw error to be handled by Fastify's central error handler
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
    // Create the abort controller and derive requestId (client-supplied wins)
    let abortController = new AbortController();
    const clientRequestId = request.body?.requestId;
    const requestId = clientRequestId || request.id || `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    let streamStartTime = null;
    let ttfbRecorded = false;
    let chunkCounter = 0;
    let lastProviderChunk = null; // Variable to store the last chunk

    // Store the abort controller for potential stopping
    activeGenerations.set(requestId, abortController);

    // Create a PassThrough stream with a low highWaterMark for immediate flushing
    const { PassThrough } = await import("node:stream");
    const stream = new PassThrough({ 
      highWaterMark: 1,  // Use smallest highWaterMark to ensure immediate chunk delivery
      autoDestroy: true  // Automatically destroy when finished
    });

    // Set up stream ending utility function
    const safelyEndStream = (message, errorType = null, finalChunk = null) => {
      if (!streamClosed) {
        logger.info(`${message} (sent ${chunkCounter} chunks)`);
        if (finalChunk && errorType === null) { // Log only on normal completion
          // logger.debug('[SERVER LAST RAW CHUNK]'); // REMOVING THIS
        }

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

        // Send final [DONE] event to explicitly signal completion to clients
        try {
          stream.write("data: [DONE]\n\n");
          // Explicitly flush any remaining buffered data
          stream.uncork();
        } catch (e) {
          logger.warn(`Error sending final [DONE] event: ${e.message}`);
        }

        // End the stream properly
        if (!stream.writableEnded) {
          stream.end();
        }
      }
    };

    try {
      metrics.incrementRequestCount();
      
      // Use request.body - add extraction of top_p, frequency_penalty, and presence_penalty
      const { model, messages, temperature = 0.7, max_tokens = 1000, top_p, frequency_penalty, presence_penalty } = request.body;
      
      if (!model) {
        return reply.status(400).send({ error: "Missing required parameter: model" });
      }
      
      if (!Array.isArray(messages) || messages.length === 0) {
        return reply.status(400).send({ error: "Missing or invalid messages array" });
      }

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
        return reply.status(404).send({ error: `Provider '${providerName}' not found or not configured` });
      }

      logger.info(`Processing STREAMING chat request for ${providerName}/${modelName} (requestId: ${requestId})`);
      streamStartTime = Date.now();
      
      // Set headers optimized for streaming
      reply.header("Content-Type", "text/event-stream");
      reply.header("Cache-Control", "no-cache, no-transform");
      reply.header("Connection", "keep-alive");
      reply.header("X-Accel-Buffering", "no"); // Prevent nginx buffering
      reply.header("Transfer-Encoding", "chunked"); // Enable chunked encoding
      // Echo the client requestId for stop calls
      reply.header("X-Request-ID", requestId);
      
      // Send the stream to the client
      reply.send(stream);
      lastActivityTime = Date.now();

      // Set up heartbeat interval
      heartbeatInterval = setInterval(() => {
        if (!streamClosed && !stream.writableEnded) { 
          try {
            stream.write(":heartbeat\n\n");
          } catch (err) {
            safelyEndStream(`Error sending heartbeat: ${err.message}`);
          }
        }
      }, HEARTBEAT_INTERVAL_MS);

      // Setup inactivity timeout check
      timeoutCheckInterval = setInterval(() => {
        if (Date.now() - lastActivityTime > TIMEOUT_DURATION_MS) {
          safelyEndStream(`Stream timed out due to inactivity for ${providerName}/${modelName}`, "timeout");
          abortController.abort();
        }
      }, TIMEOUT_DURATION_MS / 2);

      // Handle client disconnect
      request.raw.on("close", () => {
        safelyEndStream(`Client disconnected stream for ${providerName}/${modelName}`, "client_disconnect");
        abortController.abort();
      });

      // Prepare options - include additional parameters
      const options = {
        model: modelName,
        messages,
        temperature: parseFloat(temperature?.toString() || "0.7"),
        max_tokens: parseInt(max_tokens?.toString() || "1000", 10),
        abortSignal: abortController.signal,
      };
      
      // Add optional parameters only if they exist in the request
      if (top_p !== undefined) {options.top_p = parseFloat(top_p);}
      if (frequency_penalty !== undefined) {options.frequency_penalty = parseFloat(frequency_penalty);}
      if (presence_penalty !== undefined) {options.presence_penalty = parseFloat(presence_penalty);}

      // Get provider stream
      const providerStream = provider.chatCompletionStream(options);
      // Optimized stream processing with immediate chunk writing
      for await (const chunk of providerStream) {
        lastProviderChunk = chunk;
        logger.debug("Streaming chunk", { chunk });
        if (streamClosed) { break; }
        lastActivityTime = Date.now(); 
        chunkCounter++;
        
        if (!ttfbRecorded) {
          const ttfbSeconds = (Date.now() - streamStartTime) / 1000;
          metrics.recordStreamTtfb(providerName, modelName, ttfbSeconds);
          ttfbRecorded = true;
        }
        metrics.incrementStreamChunkCount(providerName, modelName);

        const sseFormattedChunk = `data: ${JSON.stringify(chunk)}\n\n`;
        // logger.debug(`[SSE SENT] Chunk ${chunkCounter} for ${providerName}/${modelName}`, { sseChunk: sseFormattedChunk }); // REMOVING THIS

        if (!streamClosed && !stream.writableEnded) {
          try {
            // Write each chunk immediately without buffering
            stream.write(sseFormattedChunk);
            
            // Force immediate flush after each chunk for optimal responsiveness
            if (typeof stream.uncork === "function") {
              stream.uncork();
            }
          } catch (writeError) {
            logger.error(`Error writing chunk to stream: ${writeError.message}`);
            safelyEndStream(`Error writing chunk to stream: ${writeError.message}`, "write_error");
            break;
          }
        }
      }
      
      // If loop completes normally, end the stream and pass the last chunk
      safelyEndStream(`Stream finished normally for ${providerName}/${modelName}`, null, lastProviderChunk);
      
    } catch (error) {
      // Handle errors
      logger.error(`Stream error: ${error.message}`, { provider: providerName, model: modelName, stack: error.stack });
      
      // Check if this was an abort error
      if (error.name === "AbortError" || error.message?.includes("aborted")) {
        // Send a special message for aborted requests
        if (!streamClosed && !stream.writableEnded) {
          try {
            const abortEventData = {
              type: "abort",
              message: "Generation was stopped by the client"
            };
            stream.write(`event: abort\ndata: ${JSON.stringify(abortEventData)}\n\n`);
          } catch (e) {
            logger.warn(`Error sending abort event: ${e.message}`);
          }
        }
        
        safelyEndStream(`Stream aborted for ${providerName}/${modelName}`, "client_abort");
        return; // Exit early
      }
      
      const errorType = "provider_error";
      
      // Check if headers have been sent
      if (!reply.sent && !streamClosed) {
        // Headers not sent, we can use reply to send a JSON error
        streamClosed = true; 
        if (heartbeatInterval) { clearInterval(heartbeatInterval); }
        if (timeoutCheckInterval) { clearInterval(timeoutCheckInterval); }
        
        // Determine appropriate status code from error if possible
        const statusCode = error.status || 500;
        reply.status(statusCode)
          .type("application/json") // Explicitly set content type
          .send(JSON.stringify({  // Explicitly stringify
            error: "Stream processing error", 
            message: error.message 
          }));
        
        // Record error metric
        if (providerName && modelName) {
          metrics.incrementStreamErrorCount(providerName, modelName, errorType);
        }
        
        // Remove from active generations
        activeGenerations.delete(requestId);
      } else if (!streamClosed && !stream.writableEnded) {
        // Headers ARE sent, try to send a structured error event over the stream
        const errorPayload = {
          code: error.code || error.name || "ProviderStreamError",
          message: error.message || "An error occurred during streaming.",
          status: error.status || 500,
          provider: providerName,
          model: modelName
        };
        
        try {
          const sseErrorEvent = `event: error\ndata: ${JSON.stringify(errorPayload)}\n\n`;
          stream.write(sseErrorEvent);
          safelyEndStream(`Error sent to client for ${providerName}/${modelName}`, errorType);
        } catch (e) {
          logger.warn(`Error sending error event: ${e.message}`);
          safelyEndStream(`Failed to send error to client for ${providerName}/${modelName}`, errorType);
        }
      }
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
      
      if (!requestId) {
        return reply.status(400).send({ 
          error: "Missing required parameter: requestId" 
        });
      }
      
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
      metrics.incrementRequestCount();
      
      const providersInfo = await providerFactory.getProvidersInfo();
      const circuitBreakerStates = getCircuitBreakerStates();
      
      const capabilities = await providerFactory.getAllProviderCapabilities();
      
      return reply.send({
        capabilities: capabilities,
        defaultProvider: providerFactory.getProvider().name,
        circuitBreakers: circuitBreakerStates,
        systemStatus: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      logger.error(`Error getting chat capabilities: ${error.message}`, { stack: error.stack });
      throw error;
    }
  }
}

// Create singleton instance
const controller = new ChatController();

// Export instance
export default controller;