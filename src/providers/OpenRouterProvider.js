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
import http from "http";
import https from "https";
import { 
  ProviderSseError,
  // Import other custom errors if needed directly
} from "../utils/CustomError.js";

// Agents for keep-alive connections

// Helper to check if a string is a base64 data URL and extract parts

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
      headers: { Authorization: `Bearer ${this.apiKey}` },
      httpAgent: new http.Agent({ keepAlive: true }),
      httpsAgent: new https.Agent({ keepAlive: true })
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
        // features: {
        //   streaming: true,
        //   system: true
        // }
      }));
      
      // Dynamically fetch models if enabled
      if (this.config.dynamicModelLoading) {
        try {
          // Call OpenRouter API for models
          const response = await this.client.get("/models");
          // Dump raw OpenRouter models to file
          // try {
          //   fs.writeFileSync("openrouter_raw_models.json", JSON.stringify(response.data, null, 2));
          // } catch (err) {
          //   logger.error("Error writing raw OpenRouter models to file", { error: err.message });
          // }
          
          if (response.data && Array.isArray(response.data.data)) {
            // Map the API's model objects directly to our ProviderModel format
            const apiModels = response.data.data.map(raw => ({
              id: raw.id,
              name: raw.name || raw.id,
              provider: this.name,
              tokenLimit: raw.top_provider.max_completion_tokens || raw.context_length || 8192,
              contextSize: raw.context_length || 8192,
              description: raw.description || "",
              // features: {
              //   streaming: raw.features?.includes("streaming") ?? true,
              //   vision: raw.features?.includes("vision") ?? false,
              //   json: raw.features?.includes("json") ?? false,
              //   tools: raw.features?.includes("tools") ?? false,
              //   system: true
              // }
            }));
            // Return the API models (skip config fallback)
            return apiModels;
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
        logger.error({ data }, "OpenRouter bad request (400)");
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
          if (item.type === "text") {
            return { type: "text", text: item.text };
          } else if (item.type === "image_url" && item.image_url?.url) {
            // OpenRouter accepts image URLs directly (including base64 data URLs)
            // following the OpenAI format.
            return { type: "image_url", image_url: { url: item.image_url.url } };
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
      else if (typeof message.content === "string") {
        return {
          role: message.role,
          content: message.content
        };
      } else {
        logger.warn("Message with unexpected content format skipped for OpenRouter:", message);
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
      const response = await this.client.post(
        "/chat/completions",
        requestBody,
        { signal: options.abortSignal }
      );
      
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
    const so = this.standardizeOptions(options);
    this.validateOptions(so);
    
    // OpenRouter model IDs are often prefixed (e.g., "openai/gpt-3.5-turbo")
    // The payload should send the model ID as is, BaseProvider might use parts of it for metrics.
    const payload = {
      model: so.model, // Use the full model string from options
      messages: this._processMessagesForOpenRouter(so.messages), // Ensure this method exists and is correct
      temperature: so.temperature,
      max_tokens: so.max_tokens, // OpenRouter uses max_tokens, not max_completion_tokens
      stream: true,
      // OpenRouter might support stream_options like OpenAI, but it's not explicitly documented for all models.
      // Adding it might be benign or could cause issues with some models. Best to check OpenRouter docs.
      // stream_options: { include_usage: true }, 
      ...(so.top_p !== undefined && { top_p: so.top_p }),
      ...(so.frequency_penalty !== undefined && { frequency_penalty: so.frequency_penalty }),
      ...(so.presence_penalty !== undefined && { presence_penalty: so.presence_penalty }),
      ...(so.stop && { stop: so.stop }),
      // ...(so.response_format?.type === "json_object" && { response_format: { type: "json_object" } }) // Check if OpenRouter supports this for all models
    };

    try {
      for await (const evt of this._streamViaGot("chat/completions", payload, so.abortSignal)) {
        if (evt.event === "error") { // Check for LLM-sent error events
          const errData = evt.data || {};
          logger.warn("[OpenRouterProvider] Received error event from LLM stream", { errData });
          throw new ProviderSseError(
            errData.message || "An error occurred in the OpenRouter stream.",
            this.name,
            errData.code || errData.type || "LLM_STREAM_ERROR",
            errData,
            evt
          );
        }

        const chunk = evt.data;
        if (chunk === "[DONE]") {
          logger.debug("[OpenRouterProvider] Received [DONE] marker.");
          continue;
        }

        // Normalize and yield the actual data chunk
        const normalized = this._normalizeStreamChunk(chunk, so.model); // Pass so.model for consistency
        if (normalized) { // _normalizeStreamChunk might return null for invalid chunks
          yield normalized;
        }
      }
    } catch (error) {
      logger.error(`[OpenRouterProvider.chatCompletionStream] Error during streaming for ${so.model}: ${error.message}`, {
        errorName: error.name,
        errorCode: error.code,
        statusCode: error.statusCode,
        providerDetails: error.details,
        stack: error.stack 
      });
      throw error; // Re-throw the caught error (custom or otherwise)
    }
  }

  /**
   * Normalizes a streaming chunk received from the OpenRouter API (which uses OpenAI format).
   * @param {object} chunk - The raw, parsed JSON object from an SSE data line.
   * @param {string} model - The model name used for the request.
   * @returns {object} A standardized chunk object matching the API schema.
   */
  _normalizeStreamChunk(chunk, modelName) {
    if (typeof chunk !== "object" || chunk === null) {
      logger.warn("[OpenRouterProvider._normalizeStreamChunk] Received non-object chunk, skipping normalization.", { chunk });
      return null;
    }

    // OpenRouter generally follows OpenAI's streaming format
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    const finishReason = choice?.finish_reason;
    
    // OpenRouter can also send a final chunk with usage details (especially for OpenAI-compatible models)
    const usage = chunk.usage ? {
      promptTokens: chunk.usage.prompt_tokens || 0,
      completionTokens: chunk.usage.completion_tokens || 0,
      totalTokens: chunk.usage.total_tokens || 0
    } : null;

    return {
      id: chunk.id,
      model: chunk.model || modelName, // Use model from chunk if available, else fallback to request's modelName
      provider: this.name,
      createdAt: chunk.created ? new Date(chunk.created * 1000).toISOString() : new Date().toISOString(),
      content: delta?.content || null,
      toolCalls: delta?.tool_calls || null,
      usage: usage,
      latency: 0, // TTFB handled in BaseProvider
      finishReason: finishReason || null,
      raw: chunk
    };
  }
}

export default OpenRouterProvider; 