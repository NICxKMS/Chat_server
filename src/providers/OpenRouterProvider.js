/**
 * OpenRouter Provider Implementation
 * Provides access to multiple LLM APIs through a single interface
 * Efficiently integrates with OpenRouter's API
 */
import axios from "axios";
import BaseProvider from "./BaseProvider.js";
import { createBreaker } from "../utils/circuitBreaker.js";
import * as metrics from "../utils/metrics.js";
import logger from "../utils/logger.js";

// Helper to check if a string is a base64 data URL and extract parts
const parseBase64DataUrl = (str) => {
  const match = str.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.*)$/);
  if (match) {
    return { mimeType: match[1], data: match[2] };
  }
  return null;
};

class OpenRouterProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.name = "openrouter";
    
    // Configure HTTP client settings
    this.baseUrl = config.baseUrl || "https://openrouter.ai/api/v1";
    this.apiKey = config.apiKey;
    this.timeout = config.timeout || 60000;
    
    // Initialize HTTP client
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeout,
      headers: {
        "Authorization": `Bearer ${this.apiKey}`
      }
    });
    
    // Extract API version info
    this.apiVersionInfo = {
      version: "v1",
      lastUpdated: new Date().toISOString()
    };
    
    // Set up circuit breaker for API calls
    this.completionBreaker = createBreaker(`${this.name}-completion`, 
      (options) => this._rawChatCompletion(options),
      {
        failureThreshold: 3,
        resetTimeout: 30000
      }
    );
  }
  
  /**
   * Validate the API key format 
   * OpenRouter now expects a proper JWT or the new "sk-or-" prefixed keys
   */
  isValidApiKey(apiKey) {
    // Check for the new OpenRouter API key format (sk-or-v1-...)
    if (apiKey.startsWith("sk-or-v1-")) {
      return true;
    }
    
    // Otherwise check if it's a valid JWT (three sections separated by dots)
    const jwtParts = apiKey.split(".");
    return jwtParts.length === 3;
  }

  /**
   * Get available models from OpenRouter
   */
  async getModels() {
    try {
      // Start with hardcoded models (if any) for fast initial response
      let models = (this.config.models || []).map(id => ({
        id,
        name: id,
        provider: this.name,
        tokenLimit: 8192, // Default token limit
        features: {
          streaming: true,
          system: true
        }
      }));
      
      // Dynamically fetch models if enabled
      if (this.config.dynamicModelLoading) {
        try {
          // Call OpenRouter API for models
          const response = await this.client.get("/models");
          
          if (response.data && Array.isArray(response.data.data)) {
            // Process each model from the API
            const dynamicModels = response.data.data.map((model) => {
              return {
                id: model.id,
                name: model.name || model.id,
                provider: this.name,
                tokenLimit: model.context_length || 8192,
                features: {
                  streaming: model.features?.includes("streaming") || true,
                  vision: model.features?.includes("vision") || false,
                  json: model.features?.includes("json") || false,
                  tools: model.features?.includes("tools") || false,
                  system: true
                }
              };
            });
            
            // Combine with existing models, prioritizing API results
            const modelIds = new Set(models.map(m => m.id));
            for (const model of dynamicModels) {
              if (!modelIds.has(model.id)) {
                models.push(model);
              }
            }
          }
        } catch (error) {
          logger.warn(`Failed to dynamically load OpenRouter models: ${error.message}`);
        }
      }
      
      return models;
    } catch (error) {
      logger.error(`OpenRouter getModels error: ${error.message}`);
      return [];
    }
  }

  /**
   * Handle API errors with better diagnostics
   */
  _handleApiError(error, context = "API call") {
    if (axios.isAxiosError(error)) {
      // Extract detailed error information
      const status = error.response?.status;
      const statusText = error.response?.statusText;
      const data = error.response?.data;
      
      // Check for authentication errors
      if (status === 401 || status === 403) {
        logger.error(`OpenRouter authentication error (${status}): ${statusText}`);
        logger.error("Please verify your API key is valid and properly formatted");
        // Log any clerk auth messages if present
        if (error.response?.headers?.["x-clerk-auth-message"]) {
          logger.error(`Auth details: ${error.response.headers["x-clerk-auth-message"]}`);
        }
      } else if (status === 400) {
        logger.error({ data }, `OpenRouter bad request (400)`);
      } else {
        logger.error(`${context}: ${error.message}`);
      }
    } else {
      logger.error(`${context}: ${error.message}`);
    }
  }

  /**
   * Send a chat completion request to OpenRouter
   */
  async chatCompletion(options) {
    try {
      // Standardize and validate options
      const standardOptions = this.standardizeOptions(options);
      this.validateOptions(standardOptions);
      
      // Use circuit breaker for resilient API call
      const response = await this.completionBreaker.fire(standardOptions);
      
      // Record successful API call
      metrics.incrementProviderRequestCount(
        this.name,
        standardOptions.model,
        "success"
      );
      
      return response;
    } catch (error) {
      // Use enhanced error handling
      this._handleApiError(error, `ChatCompletion with model ${options.model}`);
      
      // Record failed API call
      metrics.incrementProviderRequestCount(
        this.name,
        options.model,
        "error"
      );
      
      throw error;
    }
  }

  /**
   * Processes messages into the OpenRouter (OpenAI-compatible) format,
   * handling multimodal content.
   * @param {Array<object>} messages - Standardized messages array.
   * @returns {Array<object>} Messages formatted for the OpenRouter API.
   */
  _processMessagesForOpenRouter(messages) {
    return messages.map(message => {
      // If content is an array (multimodal)
      if (Array.isArray(message.content)) {
        const contentParts = message.content.map(item => {
          if (item.type === 'text') {
            return { type: 'text', text: item.text };
          } else if (item.type === 'image_url' && item.image_url?.url) {
            // OpenRouter accepts image URLs directly (including base64 data URLs)
            // following the OpenAI format.
            return { type: 'image_url', image_url: { url: item.image_url.url } };
          } else {
            logger.warn(`Unsupported content type in OpenRouter message: ${item.type}`);
            return null;
          }
        }).filter(part => part !== null);

        return {
          role: message.role,
          content: contentParts
        };
      }
      // If content is just a string (text only)
      else if (typeof message.content === 'string') {
        return {
          role: message.role,
          content: message.content
        };
      } else {
         logger.warn(`Message with unexpected content format skipped for OpenRouter:`, message);
         return null;
      }
    }).filter(message => message !== null);
  }

  /**
   * Raw chat completion method (used by circuit breaker)
   */
  async _rawChatCompletion(options) {
    // Prepare request body for OpenRouter API (OpenAI-compatible)
    const processedMessages = this._processMessagesForOpenRouter(options.messages);

    const requestBody = {
      model: options.model, // Model ID already includes provider prefix for OpenRouter
      messages: processedMessages,
      temperature: options.temperature,
      max_tokens: options.max_tokens,
      stream: false
    };
    
    // Add optional parameters if provided
    if (options.top_p !== undefined) {requestBody.top_p = options.top_p;}
    if (options.frequency_penalty !== undefined) {requestBody.frequency_penalty = options.frequency_penalty;}
    if (options.presence_penalty !== undefined) {requestBody.presence_penalty = options.presence_penalty;}
    if (options.stop) {requestBody.stop = options.stop;}
    
    try {
      // Start timer for latency tracking
      const startTime = Date.now();
      
      // Make the API request
      const response = await this.client.post("/chat/completions", requestBody);
      
      // Calculate latency
      const latency = Date.now() - startTime;
      
      // Parse the response into standardized format
      const result = {
        id: response.data.id,
        model: response.data.model,
        provider: this.name,
        createdAt: new Date(response.data.created * 1000).toISOString(),
        content: response.data.choices[0]?.message?.content || "",
        usage: {
          promptTokens: response.data.usage?.prompt_tokens || 0,
          completionTokens: response.data.usage?.completion_tokens || 0,
          totalTokens: response.data.usage?.total_tokens || 0
        },
        latency,
        finishReason: response.data.choices[0]?.finish_reason || "unknown",
        raw: response.data
      };
      
      return result;
    } catch (error) {
      // Handle errors gracefully with fallback
      this._handleApiError(error, `OpenRouter completion with ${options.model}`);
      return this._completionFallback(options, error);
    }
  }

  /**
   * Fallback for when the API request fails
   */
  async _completionFallback(options, error) {
    // Track error metrics
    metrics.incrementProviderErrorCount(
      this.name,
      options.model,
      error.response?.status || "unknown"
    );
    
    // Create a standard error response
    return {
      id: `error-${Date.now()}`,
      model: options.model,
      provider: this.name,
      createdAt: new Date().toISOString(),
      content: "",
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0
      },
      latency: 0,
      finishReason: "error",
      errorDetails: {
        message: error.response?.data?.error?.message || error.message || "Unknown error",
        type: error.response?.data?.error?.type || "api_error",
        param: error.response?.data?.error?.param || null,
        code: error.response?.status?.toString() || "500"
      }
    };
  }

  /**
   * Sends a chat completion request to OpenRouter with streaming response (SSE).
   * Uses Axios with `responseType: 'stream'` to handle the Server-Sent Events.
   * Implements the `chatCompletionStream` method defined in `BaseProvider`.
   * @param {object} options - The request options (model, messages, etc.), standardized.
   * @yields {object} Standardized response chunks compatible with the API format.
   * @throws {Error} If the API request fails or the stream encounters an error.
   */
  async *chatCompletionStream(options) {
    const startTime = process.hrtime();
    let modelName;
    let accumulatedLatency = 0;
    let firstChunk = true;
    let stream;

    try {
      // Standardize and validate options
      const standardOptions = this.standardizeOptions(options);
      this.validateOptions(standardOptions);
      
      modelName = standardOptions.model;

      // Prepare request body for OpenRouter API (OpenAI-compatible)
      const requestBody = {
        model: modelName,
        messages: standardOptions.messages,
        temperature: standardOptions.temperature,
        max_tokens: standardOptions.max_tokens,
        stream: true // Enable streaming
      };
      
      // Add optional parameters if provided
      if (standardOptions.top_p !== undefined) {requestBody.top_p = standardOptions.top_p;}
      if (standardOptions.frequency_penalty !== undefined) {requestBody.frequency_penalty = standardOptions.frequency_penalty;}
      if (standardOptions.presence_penalty !== undefined) {requestBody.presence_penalty = standardOptions.presence_penalty;}
      if (standardOptions.stop) {requestBody.stop = standardOptions.stop;}

      // Create request configuration
      const requestConfig = {
        responseType: "stream"
      };

      // Add abort signal if provided
      if (standardOptions.abortSignal instanceof AbortSignal) {
        requestConfig.signal = standardOptions.abortSignal;
      }

      // Use axios with responseType: 'stream' to handle the SSE stream
      const response = await this.client.post("/chat/completions", requestBody, requestConfig);

      stream = response.data; // Get the stream from the response data
      
      let buffer = "";
      let ended = false;
      
      // Clean up function to ensure stream is properly destroyed
      const cleanupStream = () => {
        ended = true;
        if (stream && !stream.destroyed && typeof stream.destroy === 'function') {
          try {
            stream.destroy();
          } catch (e) {
            logger.error("Error destroying stream:", e);
          }
        }
      };

      // Handle abort signal if provided
      if (standardOptions.abortSignal instanceof AbortSignal) {
        standardOptions.abortSignal.addEventListener('abort', cleanupStream, { once: true });
      }

      try {
        for await (const chunk of stream) {
          if (ended) break; // Check if stream was aborted
          buffer += chunk.toString(); // Append chunk to buffer

          // Process complete messages in the buffer
          let processedMessages = 0;
          let boundary = buffer.indexOf("\n\n");
          
          while (boundary !== -1) {
            processedMessages++;
            const message = buffer.substring(0, boundary);
            buffer = buffer.substring(boundary + 2);
            
            if (message.startsWith("data: ")) {
              const dataStr = message.substring(6);
              if (dataStr.trim() === "[DONE]") {
                ended = true;
                break; // Stream finished with DONE marker
              }
              
              try {
                const data = JSON.parse(dataStr);
                
                if (firstChunk) {
                  const duration = process.hrtime(startTime);
                  accumulatedLatency = (duration[0] * 1000) + (duration[1] / 1000000);
                  metrics.recordStreamTtfb(this.name, modelName, accumulatedLatency / 1000);
                  firstChunk = false;
                }
                
                const normalizedChunk = this._normalizeStreamChunk(data, modelName, accumulatedLatency);
                yield normalizedChunk;

              } catch (jsonError) {
                // Log the error and the problematic string data correctly
                logger.error(`Error processing OpenRouter stream chunk: ${jsonError.message}`, { dataStr });
                // Log error but continue processing other messages
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
          
          // If multiple messages were processed, log it
          if (processedMessages > 1) {
            // logger.debug(`Processed ${processedMessages} messages from buffer in one chunk`);
          }
          
          // Check for [DONE] outside of complete messages to handle edge cases
          if (buffer.includes("[DONE]")) {
            ended = true;
            break;
          }
        }
        
        // Process any remaining data in the buffer after the stream ends
        if (buffer.length > 0 && !ended) {
          if (buffer.startsWith("data: ")) {
            const dataStr = buffer.substring(6).trim();
            if (dataStr && dataStr !== "[DONE]") {
              try {
                const data = JSON.parse(dataStr);
                const normalizedChunk = this._normalizeStreamChunk(data, modelName, accumulatedLatency);
                yield normalizedChunk;
              } catch (jsonError) {
                logger.error(`Error parsing final JSON from buffer: ${jsonError.message}`, buffer);
              }
            }
          }
        }
        
        // Record successful stream completion
        metrics.incrementProviderRequestCount(this.name, modelName, "success");

      } finally {
        // Clean up the abort signal listener if it was added
        if (standardOptions.abortSignal instanceof AbortSignal) {
          standardOptions.abortSignal.removeEventListener('abort', cleanupStream);
        }
        
        // Always ensure the stream is properly destroyed
        cleanupStream();
      }

    } catch (error) {
      this._handleApiError(error, `OpenRouter stream with ${modelName || "unknown model"}`);
      if (modelName) {
        metrics.incrementProviderRequestCount(this.name, modelName, "error");
        metrics.incrementProviderErrorCount(this.name, modelName, error.response?.status || "network");
      }
      // Throw specific error message for upstream handling
      throw new Error(`OpenRouter stream error: ${error.message}`);
    }
  }

  /**
   * Normalizes a streaming chunk received from the OpenRouter API (which uses OpenAI format).
   * @param {object} chunk - The raw, parsed JSON object from an SSE data line.
   * @param {string} model - The model name used for the request.
   * @param {number} latency - The latency to the first chunk (milliseconds).
   * @returns {object} A standardized chunk object matching the API schema.
   */
  _normalizeStreamChunk(chunk, model, latency) {
    try {
      // OpenRouter stream chunks often follow OpenAI's format
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      
      // Extract finish_reason and usage *from the chunk* if available
      const finishReason = choice?.finish_reason || "unknown";
      const usage = chunk.usage || { // Initialize usage, OpenRouter might send it in the last chunk
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0
      };

      return {
        id: chunk.id,
        model: chunk.model || model, // Use model from chunk if available
        provider: this.name,
        createdAt: chunk.created ? new Date(chunk.created * 1000).toISOString() : new Date().toISOString(),
        content: delta?.content || null,
        toolCalls: delta?.tool_calls || null, // Include tool call deltas
        usage: usage, // Use usage extracted from chunk or default
        latency: latency,
        finishReason: finishReason, // Use finishReason extracted from chunk or default
        raw: chunk
      };
    } catch (error) {
      logger.error(`Error normalizing OpenRouter stream chunk: ${error.message}`, { chunk });
      // Return a minimal error chunk or rethrow
      return {
        id: `error-chunk-${Date.now()}`,
        error: `Failed to normalize chunk: ${error.message}`,
        raw: chunk
      };
    }
  }
}

export default OpenRouterProvider; 