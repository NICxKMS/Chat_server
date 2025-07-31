/**
 * @file Chat Controller
 * @description Handles all chat-related API endpoints with optimized performance.
 * @version 2.0.0
 */

import providerFactory from "../providers/ProviderFactory.js";
import * as cache from "../utils/cache.js";
import * as metrics from "../utils/metrics.js";
import { getCircuitBreakerStates } from "../utils/circuitBreaker.js";
import logger from "../utils/logger.js";
import { PassThrough } from "stream";

export const bodyLimit = 10 * 1024 * 1024; // 10MB payload size limit for image data

// Constants for stream management
const HEARTBEAT_INTERVAL_MS = 15000; // Send a heartbeat every 15 seconds
const TIMEOUT_DURATION_MS = 120000; // Timeout stream after 2 minutes of inactivity

/**
 * Manages active generation requests to allow for cancellation.
 * @type {Map<string, AbortController>}
 */
const activeGenerations = new Map();

class ChatController {
  /**
   * Extracts provider and model names from a single model string.
   * @param {string} model - The model string, e.g., "openai/gpt-4".
   * @returns {[string, string]} - A tuple of [providerName, modelName].
   * @private
   */
  _getProviderAndModel(model) {
    const separatorIndex = model.indexOf("/");
    if (separatorIndex !== -1) {
      const providerName = model.substring(0, separatorIndex);
      const modelName = model.substring(separatorIndex + 1);
      return [providerName, modelName];
    } else {
      const defaultProvider = providerFactory.getProvider();
      return [defaultProvider.name, model];
    }
  }

  /**
   * Handles standard (non-streaming) chat completion requests.
   * @param {import('fastify').FastifyRequest} request - Fastify request object.
   * @param {import('fastify').FastifyReply} reply - Fastify reply object.
   */
  chatCompletion = async (request, reply) => {
    const requestId = request.body?.requestId || request.id;
    const abortController = new AbortController();
    activeGenerations.set(requestId, abortController);

    try {
      const { model, messages, nocache, ...restOptions } = request.body;
      const [providerName, modelName] = this._getProviderAndModel(model);
      const provider = providerFactory.getProvider(providerName);

      reply.header("X-Request-ID", requestId);

      // Optimized cache check
      if (cache.isEnabled() && !nocache) {
        const cacheKeyData = { provider: providerName, model: modelName, messages, ...restOptions };
        const cacheKey = cache.generateKey(cacheKeyData);
        const cachedResponse = await cache.get(cacheKey);
        if (cachedResponse) {
          logger.info(`Cache hit for ${providerName}/${modelName}`);
          return reply.send({ ...cachedResponse, cached: true });
        }
      }

      const options = {
        model: modelName,
        messages,
        ...restOptions,
        abortSignal: abortController.signal,
      };

      const response = await provider.chatCompletion(options);

      // Set cache if enabled
      if (cache.isEnabled() && !nocache) {
        const cacheKeyData = { provider: providerName, model: modelName, messages, ...restOptions };
        const cacheKey = cache.generateKey(cacheKeyData);
        await cache.set(cacheKey, response);
      }

      return reply.send(response);
    } catch (error) {
      if (error.name === "AbortError") {
        logger.info(`Request ${requestId} was aborted by the client.`);
        return reply.status(499).send({ error: "Request aborted" });
      }
      logger.error(`Error in chatCompletion: ${error.message}`, {
        requestId,
        stack: error.stack,
      });
      // Maintain original error format for client-side consistency
      return reply.status(200).send({
        error: {
          message: error.message || "An unexpected error occurred.",
          code: error.status || 500,
          type: error.name || "ServerError",
        },
      });
    } finally {
      activeGenerations.delete(requestId);
    }
  };

  /**
   * Handles streaming chat completion requests using Server-Sent Events (SSE).
   * @param {import('fastify').FastifyRequest} request - Fastify request object.
   * @param {import('fastify').FastifyReply} reply - Fastify reply object.
   */
  chatCompletionStream = async (request, reply) => {
    const requestId = request.body?.requestId || request.id;
    const abortController = new AbortController();
    activeGenerations.set(requestId, abortController);

    const stream = new PassThrough({ highWaterMark: 1, autoDestroy: true });
    reply.raw.on("close", () => {
      if (!stream.destroyed) {
        abortController.abort();
        activeGenerations.delete(requestId);
        stream.destroy();
      }
    });
    
    // Set SSE headers
    reply.header("Content-Type", "text/event-stream");
    reply.header("Cache-Control", "no-cache, no-transform");
    reply.header("Connection", "keep-alive");
    reply.header("X-Request-ID", requestId);
    reply.send(stream);

    let lastActivityTime = Date.now();
    const heartbeatInterval = setInterval(() => stream.write(":heartbeat\n\n"), HEARTBEAT_INTERVAL_MS);
    const timeoutCheckInterval = setInterval(() => {
      if (Date.now() - lastActivityTime > TIMEOUT_DURATION_MS) {
        abortController.abort();
      }
    }, TIMEOUT_DURATION_MS / 2);

    const cleanup = () => {
      clearInterval(heartbeatInterval);
      clearInterval(timeoutCheckInterval);
      activeGenerations.delete(requestId);
      if (!stream.writableEnded) stream.end();
      if (!stream.destroyed) stream.destroy();
    };

    try {
      const { model, messages, ...restOptions } = request.body;
      const [providerName, modelName] = this._getProviderAndModel(model);
      const provider = providerFactory.getProvider(providerName);

      const options = {
        model: modelName,
        messages,
        ...restOptions,
        abortSignal: abortController.signal,
      };

      for await (const chunk of provider.chatCompletionStream(options)) {
        lastActivityTime = Date.now();
        stream.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      stream.write("data: [DONE]\n\n");
    } catch (error) {
      if (error.name !== "AbortError") {
        logger.error(`Error in chatCompletionStream: ${error.message}`, {
          requestId,
          stack: error.stack,
        });
        const errorPayload = {
          error: {
            message: error.message,
            code: error.status || 500,
            type: error.name || "StreamError",
          },
        };
        stream.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
      }
    } finally {
      cleanup();
    }
  };

  /**
   * Handles requests to stop an ongoing generation.
   * @param {import('fastify').FastifyRequest} request - Fastify request object.
   * @param {import('fastify').FastifyReply} reply - Fastify reply object.
   */
  stopGeneration = async (request, reply) => {
    const { requestId } = request.body;
    if (!requestId) {
      return reply.status(400).send({
        error: "Bad Request",
        message: "Missing 'requestId' in request body.",
      });
    }

    const abortController = activeGenerations.get(requestId);
    if (abortController) {
      logger.info(`Stopping generation for requestId: ${requestId}`);
      abortController.abort();
      activeGenerations.delete(requestId);
      return reply
        .status(200)
        .send({ success: true, message: "Stop signal sent." });
    } else {
      logger.info(
        `No active generation found for requestId: ${requestId}. Ignoring stop request.`
      );
      return reply.status(404).send({
        success: false,
        message: "No active generation found for the given requestId.",
      });
    }
  };

  /**
   * Gets combined capabilities information from providers, cache, and system.
   * @param {import('fastify').FastifyRequest} request - Fastify request object.
   * @param {import('fastify').FastifyReply} reply - Fastify reply object.
   */
  getChatCapabilities = async (request, reply) => {
    try {
      const circuitBreakerStates = getCircuitBreakerStates();
      const cacheStats = cache.getStats ? cache.getStats() : { enabled: false };
      const capabilities = await providerFactory.getAllProviderCapabilities();

      return reply.send({
        capabilities,
        defaultProvider: providerFactory.getProvider().name,
        circuitBreakers: circuitBreakerStates,
        cacheStats,
        systemStatus: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error(`Error getting chat capabilities: ${error.message}`, {
        stack: error.stack,
      });
      throw error;
    }
  };
}

const controller = new ChatController();
export default controller;
