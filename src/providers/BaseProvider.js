/**
 * BaseProvider abstract class
 * Defines the interface that all AI provider implementations must follow
 */

import { createBreaker } from "../utils/circuitBreaker.js";
import * as metrics from "../utils/metrics.js";
import { responseTimeHistogram } from "../utils/metrics.js";
import { createHttpClient } from "../utils/httpClient.js";

class BaseProvider {
  /**
   * Create a new provider
   */
  constructor(config) {
    if (this.constructor === BaseProvider) {
      throw new Error("BaseProvider is an abstract class and cannot be instantiated directly");
    }
    
    this.name = "base";
    this.config = config;
    this.apiVersionInfo = {
      version: "v1",
      lastUpdated: new Date().toISOString()
    };
    // Store registered breakers
    this._breakers = {};
  }

  /**
   * Register a circuit breaker for a provider method.
   * @param {string} key - Suffix for breaker name (e.g., 'completion').
   * @param {string} methodName - Name of the method to wrap.
   * @param {object} options - Circuit breaker options.
   * @returns {object} The created circuit breaker instance.
   */
  registerBreaker(key, methodName, options) {
    const breakerName = `${this.name}-${key}`;
    // Bind the provider method
    const rawMethod = this[methodName].bind(this);
    // Wrap the method to record metrics
    const wrappedMethod = async (params) => {
      const start = Date.now();
      try {
        const result = await rawMethod(params);
        const latency = Date.now() - start;
        // Record response time and success count
        responseTimeHistogram.labels(this.name, params.model || "unknown", "200").observe(latency / 1000);
        metrics.incrementProviderRequestCount(this.name, params.model || "unknown", "success");
        return result;
      } catch (error) {
        const status = error.status || error.code || "error";
        metrics.incrementProviderErrorCount(this.name, params.model || "unknown", String(status));
        throw error;
      }
    };
    // Create breaker with wrapped method
    const breaker = createBreaker(breakerName, wrappedMethod, options);
    this._breakers[key] = breaker;
    return breaker;
  }

  /**
   * Get available models from the provider
   * Should be implemented by each provider
   */
  async getModels() {
    throw new Error("Method getModels() must be implemented by derived classes");
  }

  /**
   * Get info about the provider
   */
  getInfo() {
    return {
      name: this.name,
      models: [], // This will be populated by the child class
      defaultModel: this.config.defaultModel,
      apiVersion: this.apiVersionInfo.version,
      lastUpdated: this.apiVersionInfo.lastUpdated
    };
  }

  /**
   * Send a chat completion request (non-streaming)
   * Must be implemented by each provider.
   * @param {object} options - The request options (model, messages, etc.).
   * @returns {Promise<object>} A promise resolving to the standardized API response.
   */
  async chatCompletion(options) {
    throw new Error("Method chatCompletion() must be implemented by derived classes");
  }

  /**
   * Send a chat completion request with a streaming response using Server-Sent Events (SSE).
   * Must be implemented by providers that support streaming.
   * This method should be an async generator (`async function*`).
   * @param {object} options - The request options (model, messages, etc.).
   * @yields {object} Standardized response chunks compatible with the API format.
   * @throws {Error} If streaming is not supported or an API error occurs.
   */
  async *chatCompletionStream(options) {
    // Default implementation throws an error indicating lack of support.
    // Derived classes must override this method to provide streaming functionality.
    throw new Error(`Streaming not supported by ${this.name} provider`);
    
    // The `yield` is technically unreachable but satisfies the async generator signature
     
    yield {}; 
  }

  /**
   * Normalize a provider response to a standard format
   * @param {object} response - The raw response object from the provider API.
   * @returns {object} A standardized response object.
   */
  normalizeResponse(response) {
    return {
      id: response.id || `response-${Date.now()}`,
      model: response.model || "unknown",
      provider: this.name,
      createdAt: response.created 
        ? new Date(response.created * 1000).toISOString() 
        : new Date().toISOString(),
      content: response.content || "",
      usage: {
        promptTokens: response.usage?.prompt_tokens || response.usage?.input_tokens || 0,
        completionTokens: response.usage?.completion_tokens || response.usage?.output_tokens || 0,
        totalTokens: response.usage?.total_tokens || 
          (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0)
      },
      latency: 0, // Should be set by the specific provider
      finishReason: response.finish_reason || response.stop_reason || "unknown",
      raw: response
    };
  }

  /**
   * Normalizes and validates common chat options.
   * @param {object} options - The raw options from the request body.
   * @returns {object} Standardized options suitable for provider methods.
   */
  standardizeOptions(options) {
    const { model, messages, temperature = 0.7, max_tokens = 1000, ...rest } = options;
    
    return {
      model: model || this.config.defaultModel || "",
      messages: messages || [],
      temperature: parseFloat(temperature.toString()),
      max_tokens: parseInt(max_tokens.toString(), 10),
      ...rest
    };
  }

  /**
   * Validates the essential options for a chat completion request.
   * @param {object} options - Standardized options.
   * @throws {Error} If essential options (model, messages) are missing or invalid.
   */
  validateOptions(options) {
    const { model, messages } = options;
    
    if (!model) {
      throw new Error("Model parameter is required");
    }
    
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("Messages array is required and must not be empty");
    }
    
    messages.forEach((message, index) => {
      if (!message.role || !message.content) {
        throw new Error(`Message at index ${index} must have role and content properties`);
      }
    });
  }

  /**
   * Create a configured HTTP client for providers.
   * @param {object} options - Configuration for HTTP client.
   * @param {string} options.baseURL - Base URL for API calls.
   * @param {object} [options.headers] - Default headers.
   * @param {number} [options.timeout] - Request timeout in ms.
   * @param {number} [options.maxRetries] - Retry attempts for network errors.
   * @returns {AxiosInstance} Configured HTTP client.
   */
  createClient({ baseURL, headers = {}, timeout, maxRetries }) {
    return createHttpClient({
      baseURL,
      headers,
      timeout: timeout ?? this.config.timeout,
      maxRetries: maxRetries ?? this.config.maxRetries
    });
  }

  /**
   * Generic streaming wrapper to handle TTFB, duration, and error metrics.
   * @param {Function} rawFn - async function returning an async iterable (raw stream) taking standardized options.
   * @param {object} options - The raw options for streaming.
   * @param {Function} normalizeFn - Function to normalize each raw chunk to standardized format.
   * @yields {object} Standardized stream chunks.
   */
  async *streamWrapper(rawFn, options, normalizeFn) {
    // Standardize and validate options
    const standardOptions = this.standardizeOptions(options);
    this.validateOptions(standardOptions);
    const model = standardOptions.model;
    // High-resolution timer start
    const hrStart = process.hrtime();
    let firstChunk = true;
    let ttfbMs = 0;
    try {
      // Obtain raw stream
      const stream = await rawFn.call(this, standardOptions);
      for await (const chunk of stream) {
        if (firstChunk) {
          const diff = process.hrtime(hrStart);
          ttfbMs = diff[0] * 1000 + diff[1] / 1e6;
          metrics.recordStreamTtfb(this.name, model, ttfbMs / 1000);
          firstChunk = false;
        }
        // Yield normalized chunk
        yield normalizeFn.call(this, chunk, model, ttfbMs);
      }
      // Record successful stream request
      metrics.incrementProviderRequestCount(this.name, model, "success");
    } catch (error) {
      // Record stream error
      metrics.incrementStreamErrorCount(this.name, model, error.status || "error");
      throw error;
    } finally {
      const diff = process.hrtime(hrStart);
      const totalSeconds = diff[0] + diff[1] / 1e9;
      metrics.recordStreamDuration(this.name, model, totalSeconds);
    }
  }
}

export default BaseProvider; 