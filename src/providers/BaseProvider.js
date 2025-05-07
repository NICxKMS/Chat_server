/**
 * BaseProvider abstract class
 * Defines the interface that all AI provider implementations must follow
 */

// Add imports for HTTP/2 client and SSE parsing
import got from "got";
import { Agent as Http2Agent } from "http2-wrapper";
import { createParser } from "eventsource-parser";
import JSONParse from "jsonparse";
import * as metrics from "../utils/metrics.js";
import logger from "../utils/logger.js";
import {
  ProviderHttpError,
  ProviderRateLimitError,
  ProviderAuthenticationError,
  StreamReadError
} from "../utils/CustomError.js"; // Import custom errors

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

    // Shared HTTP/2 client for streaming calls with persistent session
    const http2Agent = new Http2Agent({ keepAlive: true });
    const gotOptions = {
      http2: true,
      agent: { http2: http2Agent },
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      responseType: "text",
      throwHttpErrors: false
    };
    if (config.baseUrl) {
      // Remove trailing slashes from baseUrl
      gotOptions.prefixUrl = config.baseUrl.replace(/\/+$/g, "");
    }
    this.http2Client = got.extend(gotOptions);
    // Track HTTP/2 session reuse
    this._lastHttp2Session = null;
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
  async chatCompletion() {
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
  async *chatCompletionStream() {
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
   * Parse a Server-Sent Events (SSE) stream into JSON objects.
   * @param {ReadableStream<Buffer>} stream - Incoming SSE data stream.
   * @returns {AsyncGenerator<any>} Yields parsed JSON event data objects.
   */
  async *_parseSSE(stream) {
    const parserQueue = [];
    let resolveParserPromise;
    let parserPromise = new Promise(resolve => { resolveParserPromise = resolve; });

    // Use a streaming JSON parser for efficient per-chunk parsing
    const jsonParser = new JSONParse();
    let currentEventType = null;
    jsonParser.onValue = function (value) {
      // Emit only completed top-level values
      if (this.stack.length === 0) {
        parserQueue.push({ event: currentEventType, data: value });
        const oldResolve = resolveParserPromise;
        parserPromise = new Promise(resolve => { resolveParserPromise = resolve; });
        oldResolve();
      }
    };
    const parser = createParser((event) => {
      if (event.type === "event") {
        const type = event.event || "message";
        if (event.data === "[DONE]") {
          parserQueue.push({ event: type, data: "[DONE]" });
          const oldResolve = resolveParserPromise;
          parserPromise = new Promise(resolve => { resolveParserPromise = resolve; });
          oldResolve();
        } else if (event.data) {
          // Stream JSON text into the parser
          currentEventType = type;
          jsonParser.write(event.data);
        }
      }
    });

    let streamEnded = false;

    const streamReader = async () => {
      try {
        for await (const chunk of stream) {
          const raw = chunk.toString();
          parser.feed(raw);
        }
      } catch (err) {
        // Instead of pushing an error event, throw a custom error
        logger.error("[_parseSSE.streamReader] Stream read error", { error: err });
        throw new StreamReadError(err.message, this.name, err);
      } finally {
        streamEnded = true;
        if (resolveParserPromise) {
          resolveParserPromise(); // Ensure promise resolves
        }
      }
    };

    const readerPromise = streamReader().catch(err => {
      // Ensure the main generator loop is aware of the error from streamReader
      // This makes the error propagate to the consumer of _parseSSE
      throw err; 
    });

    try {
      while (true) {
        if (parserQueue.length > 0) {
          const item = parserQueue.shift();
          yield item;
          // No longer yielding StreamReadError as an event, it's thrown by streamReader
        } else if (streamEnded) {
          break;
        } else {
          await parserPromise;
        }
      }
    } finally {
      await readerPromise; // Ensure streamReader finishes and its potential error is surfaced
    }
  }

  /**
   * Generic SSE POST over HTTP/2 using got + eventsource-parser.
   * Yields parsed JSON chunks.
   */
  async *_streamViaGot(path, payload, signal) {
    const start = Date.now();
    const stream = this.http2Client.stream(path, {
      method: "POST",
      body: JSON.stringify(payload),
      signal,
    });

    let httpErrorResponseInfo = null;
    let httpErrorDataBuffer = "";
    let isErrorResponse = false;
    let ttfbRecorded = false;

    const initialResponsePromise = new Promise((resolve, reject) => {
      stream.once("error", (err) => {
        logger.error("[BaseProvider._streamViaGot] Stream error during initial response phase.", { error: err });
        reject(err); // This could be a network error, SSL error, etc.
      });

      stream.once("response", (res) => {
        if (res.statusCode >= 400) {
          isErrorResponse = true;
          httpErrorResponseInfo = {
            statusCode: res.statusCode,
            headers: res.headers,
            httpVersion: res.httpVersion
          };
          logger.warn(`[BaseProvider._streamViaGot] HTTP error response detected: ${res.statusCode}. Buffering error body.`, { path });
          stream.on("data", (chunk) => httpErrorDataBuffer += chunk.toString());
          stream.once("end", () => resolve(res));
          stream.once("error", (bodyError) => {
            logger.error("[BaseProvider._streamViaGot] Error reading error response body.", { error: bodyError });
            reject(new StreamReadError(`Failed to read error response body: ${bodyError.message}`, this.name, bodyError));
          });
        } else {
          const currSession = stream.session;
          
          this._lastHttp2Session = currSession;
          resolve(res);
        }
      });
    });

    try {
      await initialResponsePromise;
    } catch (streamSetupError) {
      logger.error("[BaseProvider._streamViaGot] Stream setup error (initialResponsePromise rejected).", { streamSetupError });
      // If it's already a custom error, rethrow. Otherwise, wrap as a generic ProviderHttpError.
      if (streamSetupError instanceof StreamReadError || streamSetupError instanceof ProviderHttpError) {
        throw streamSetupError;
      }
      throw new ProviderHttpError(streamSetupError.message, 503, "PROVIDER_SETUP_FAILURE", this.name, streamSetupError);
    }

    if (isErrorResponse) {
      let message = `Upstream provider error: ${httpErrorResponseInfo.statusCode}`;
      let type = "PROVIDER_HTTP_ERROR"; // Default type
      let providerErrorPayload = null;
      try {
        providerErrorPayload = JSON.parse(httpErrorDataBuffer);
        message = providerErrorPayload.error?.message || message;
        type = providerErrorPayload.error?.type || type; // Use type from payload if available
      } catch (e) {
        logger.warn("[BaseProvider._streamViaGot] Could not parse HTTP error data as JSON.", { data: httpErrorDataBuffer, parseError: e.message });
        // Keep the generic message and type if parsing fails
      }
      
      // Throw specific custom error types based on status code
      if (httpErrorResponseInfo.statusCode === 429) {
        throw new ProviderRateLimitError(this.name, providerErrorPayload, message);
      }
      if (httpErrorResponseInfo.statusCode === 401 || httpErrorResponseInfo.statusCode === 403) {
        throw new ProviderAuthenticationError(this.name, providerErrorPayload, message);
      }
      // Default to ProviderHttpError for other 4xx/5xx errors
      throw new ProviderHttpError(message, httpErrorResponseInfo.statusCode, type.toUpperCase().replace(/\s+/g, "_"), this.name, providerErrorPayload);
    }

    logger.debug("[BaseProvider._streamViaGot] No HTTP error, proceeding with SSE parsing.", { path });
    for await (const data of this._parseSSE(stream)) {
      if (!ttfbRecorded) {
        metrics.recordStreamTtfb(this.name, payload.model, (Date.now() - start) / 1000);
        ttfbRecorded = true;
      }
      yield data;
    }

    metrics.recordStreamDuration(this.name, payload.model, (Date.now() - start) / 1000);
    logger.debug(`[BaseProvider._streamViaGot] Streaming finished successfully for ${path}`);
  }
}

export default BaseProvider; 