/**
 * OpenAI Provider Implementation
 * Efficiently integrates with OpenAI's API using their official SDK
 */
import { OpenAI } from "openai";
import BaseProvider from "./BaseProvider.js";
import { createBreaker } from "../utils/circuitBreaker.js";
import * as metrics from "../utils/metrics.js";
import logger from "../utils/logger.js";
import { 
  
  ProviderSseError,
  // Import other custom errors if needed directly, though BaseProvider should handle most.
} from "../utils/CustomError.js";


class OpenAIProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.name = "openai";
    
    // Initialize OpenAI SDK with custom configuration
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeout,
      maxRetries: config.maxRetries || 3
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
    
    // Initialize with fallback models if specified in config
    this.cachedModels = this.config.models ? this._createModelObjects(this.config.models) : [];
    
    // Track if models were loaded from API (not just config)
    this.modelsLoadedFromAPI = false;
    // Track if we have any models (config or API)
    this.hasModels = this.cachedModels.length > 0;
    
    // Log initialization status
    // logger.info(`OpenAIProvider initialized with ${this.cachedModels.length} initial models from config`);
  }

  /**
   * Get available models from OpenAI
   * @param {Object} options - Options for fetching models
   * @param {boolean} options.forceRefresh - Whether to force refresh from API
   */
  async getModels(options = {}) {
    try {
      // Return cache if we have data from API and not forcing refresh
      if (this.modelsLoadedFromAPI && this.cachedModels.length > 0 && !options.forceRefresh) {
        return this.cachedModels;
      }
      
      // logger.info("Fetching models from OpenAI API...");
      
      // Create fallback models in case API call fails
      const fallbackModels = [
        "gpt-4",
        "gpt-4-turbo",
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-3.5-turbo",
        "gpt-3.5-turbo-16k",
      ];
      
      // Call the OpenAI API to get available models
      try {
        // Explicitly call the list method and await the response
        const response = await this.client.models.list();
        
        // Dump raw API model list to file
        // try {
        //   fs.writeFileSync("openai_raw_models.json", JSON.stringify(response.data, null, 2));
        // } catch (writeErr) {
        //   logger.error("Error writing raw OpenAI models to file", { error: writeErr.message });
        // }
        
        if (!response || !response.data || !Array.isArray(response.data)) {
          logger.error("Invalid response format from OpenAI API", { response });
          throw new Error("Invalid response format from OpenAI models API");
        }
        
        // logger.info(`Received ${response.data.length} models from OpenAI API`);
        
        let filteredModels = response.data
          .filter(model => {
            let id = model.id || ""; // Ensure `id` is a string
            let firstChar = id[0];   // Get the first character safely
      
            return !(
              firstChar === "t" || 
            firstChar === "b" || 
            firstChar === "w" || 
            (id.length > 1 && id.slice(0, 2) === "om") || // Check "om" only if ID has at least 2 chars
            (id.length > 2 && id.slice(0, 3) === "dav")  // Check "dav" only if ID has at least 3 chars
            );
          })
          .map(model => ({
            id: model.id,
            name: model.id,
            provider: this.name,
            tokenLimit: this._getTokenLimit(model.id),
            // features: this._getModelFeatures(model.id)
          }));
              
        
        return filteredModels;
      } catch (error) {
        logger.error("Error fetching OpenAI models from API", { error: error.message });
                
        // use fallback models
        logger.warn(`Using ${fallbackModels.length} hardcoded fallback models due to API error`);
        const models = this._createModelObjects(fallbackModels);
        return models;
      }
    } catch (error) {
      logger.error("Error in getModels", { error: error.message });
      

      return this._createModelObjects(fallbackModels|| []);
    }
  }

  /**
   * Create model objects from model IDs
   */
  _createModelObjects(modelIds) {
    return modelIds.map(id => ({
      id,
      name: id,
      provider: this.name,
      tokenLimit: this._getTokenLimit(id),
      // features: this._getModelFeatures(id)
    }));
  }

  /**
   * Get token limit for a model
   */
  _getTokenLimit(modelId) {
    const tokenLimits = {
      "gpt-4": 8192,
      "gpt-4-32k": 32768,
      "gpt-4-turbo": 128000,
      "gpt-4o": 128000,
      "gpt-3.5-turbo": 4096,
      "gpt-3.5-turbo-16k": 16384
    };
    
    // Match model to its base version (without date suffix)
    const baseModel = Object.keys(tokenLimits).find(base => 
      modelId.startsWith(base)
    );
    
    return baseModel ? tokenLimits[baseModel] : 4096; // Default to 4K
  }
  
  // /**
  //  * Get features supported by a model
  //  */
  // _getModelFeatures(modelId) {
  //   // Default features
  //   const features = {
  //     vision: false,
  //     streaming: true,
  //     functionCalling: false,
  //     tools: false,
  //     json: false,
  //     system: true
  //   };
  //   
  //   // GPT-4 Vision models
  //   if (modelId.includes("vision") || modelId.includes("gpt-4-turbo") || modelId.includes("gpt-4o")) {
  //     features.vision = true;
  //   }
  //   
  //   // Tool/function calling models
  //   if (modelId.includes("gpt-4") || modelId.includes("gpt-3.5-turbo")) {
  //     features.functionCalling = true;
  //     features.tools = true;
  //   }
  //   
  //   // JSON mode support
  //   if (modelId.includes("gpt-4") || modelId.includes("gpt-3.5-turbo")) {
  //     features.json = true;
  //   }
  //   
  //   return features;
  // }

  /**
   * Send a chat completion request to OpenAI
   */
  async chatCompletion(options) {
    try {
      // Standardize and validate options
      const standardOptions = this.standardizeOptions(options);
      this.validateOptions(standardOptions);
      
      // Extract model name (without provider prefix)
      const modelName = standardOptions.model.includes("/") 
        ? standardOptions.model.split("/")[1] 
        : standardOptions.model;
      
      // Update options with extracted model name
      const apiOptions = {
        ...standardOptions,
        model: modelName
      };
      
      // Use circuit breaker for API calls
      const response = await this.completionBreaker.fire(apiOptions);
      
      // Record successful API call
      metrics.incrementProviderRequestCount(
        this.name,
        modelName,
        "200"
      );
      
      return response;
    } catch (error) {
      // logger.error(`OpenAI API error: ${error.message}`); // REMOVED this line
      
      // Record failed API call
      metrics.incrementProviderRequestCount(
        this.name,
        options.model?.includes("/") ? options.model.split("/")[1] : options.model,
        "error"
      );
      
      throw error;
    }
  }

  /**
   * Processes messages into the OpenAI API format, handling multimodal content.
   * @param {Array<object>} messages - Standardized messages array.
   * @returns {Array<object>} Messages formatted for the OpenAI API.
   */
  _processMessagesForOpenAI(messages) {
    return messages.map(message => {
      // If content is an array (multimodal)
      if (Array.isArray(message.content)) {
        const contentParts = message.content.map(item => {
          if (item.type === "text") {
            return { type: "text", text: item.text };
          } else if (item.type === "image_url" && item.image_url?.url) {
            // OpenAI accepts image URLs directly (including base64 data URLs)
            return { type: "image_url", image_url: { url: item.image_url.url } };
          } else {
            // Skip unknown content parts or log a warning
            logger.warn(`Unsupported content type in OpenAI message: ${item.type}`);
            return null;
          }
        }).filter(part => part !== null); // Remove null parts

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
        // Handle cases where content might be missing or has unexpected format
        logger.warn("Message with unexpected content format skipped for OpenAI:", message);
        return null; // Or return a default structure if appropriate
      }
    }).filter(message => message !== null); // Filter out skipped messages
  }

  /**
   * Raw chat completion method (used by circuit breaker)
   * Sends the actual request to the OpenAI API.
   * @param {object} options - Standardized options.
   * @returns {Promise<object>} Standardized response object.
   */
  async _rawChatCompletion(options) {
    // Extract model name (without provider prefix)
    const modelName = options.model.includes("/")
      ? options.model.split("/")[1]
      : options.model;

    // Process messages for potential multimodal content
    const processedMessages = this._processMessagesForOpenAI(options.messages);

    // Prepare the request payload
    const payload = {
      model: modelName,
      messages: processedMessages,
      temperature: options.temperature,
      max_tokens: options.max_tokens,
      stream: false, // This is for non-streaming
      // Include other optional parameters if they exist
      ...(options.top_p !== undefined && { top_p: options.top_p }),
      ...(options.frequency_penalty !== undefined && { frequency_penalty: options.frequency_penalty }),
      ...(options.presence_penalty !== undefined && { presence_penalty: options.presence_penalty }),
      ...(options.stop && { stop: options.stop }),
      // Add JSON mode parameter if requested and applicable
      ...(options.response_format?.type === "json_object" && { response_format: { type: "json_object" } })
    };

    let startTime;
    try {
      startTime = Date.now();
      // logger.debug({ openAIPayload: payload }, "Sending request to OpenAI");

      const response = await this.client.chat.completions.create(
        payload,
        { signal: options.abortSignal }
      );

      const latency = startTime ? Date.now() - startTime : 0;
      logger.debug("Received response from OpenAI");

      // Normalize the response
      return this._normalizeResponse(response, modelName, latency);
    } catch (error) {
      logger.error(`OpenAI raw completion error: ${error.message}`, { model: modelName, error });
      // Enhance error handling: Check for specific OpenAI error types/codes
      let statusCode = 500;
      if (error.status) {
        statusCode = error.status; // Use status code from OpenAI error object if available
      }
      metrics.incrementProviderRequestCount(this.name, modelName, statusCode.toString());
      metrics.incrementProviderErrorCount(this.name, modelName, statusCode.toString());

      // Re-throw the error for centralized handling
      throw error;
    }
  }

  /**
   * Normalize OpenAI response to common format
   */
  _normalizeResponse(response, model, latency) {
    const choice = response.choices?.[0];
    const usage = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    return {
      id: response.id,
      model: response.model || model,
      provider: this.name,
      createdAt: response.created ? new Date(response.created * 1000).toISOString() : new Date().toISOString(),
      // Handle potential null message or content
      content: choice?.message?.content?.trim() ?? "",
      usage: {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens
      },
      latency: latency,
      finishReason: choice?.finish_reason || "unknown",
      // Include tool calls if present
      toolCalls: choice?.message?.tool_calls || null,
      raw: response
    };
  }

  /**
   * Send a chat completion request with streaming response (SSE).
   * Delegates to BaseProvider._streamViaGot for HTTP/2 + SSE parsing.
   */
  async *chatCompletionStream(options) {
    const so = this.standardizeOptions(options);
    this.validateOptions(so);
    const modelName = so.model.includes("/") ? so.model.split("/")[1] : so.model;
    const payload = {
      model: modelName,
      messages: this._processMessagesForOpenAI(so.messages),
      temperature: so.temperature,
      max_completion_tokens: so.max_tokens,
      stream: true,
      stream_options: { include_usage: true },
      ...(so.top_p !== undefined && { top_p: so.top_p }),
      ...(so.frequency_penalty !== undefined && { frequency_penalty: so.frequency_penalty }),
      ...(so.presence_penalty !== undefined && { presence_penalty: so.presence_penalty }),
      ...(so.stop && { stop: so.stop }),
      ...(so.response_format?.type === "json_object" && { response_format: { type: "json_object" } })
    };

    try {
      for await (const evt of this._streamViaGot("chat/completions", payload, so.abortSignal)) {
        if (evt.event === "error") { // This is an error *event* sent by the LLM within the SSE stream
          const errData = evt.data || {};
          logger.warn("[OpenAIProvider] Received error event from LLM stream", { errData });
          throw new ProviderSseError(
            errData.message || "An error occurred in the OpenAI stream.",
            this.name,
            errData.code || errData.type || "LLM_STREAM_ERROR",
            errData, // details
            evt // originalEvent
          );
        }
        
        // Assuming evt.data contains the actual chunk data for normal events
        const chunk = evt.data;
        if (chunk === "[DONE]") { // Check for our [DONE] marker from _parseSSE
          logger.debug("[OpenAIProvider] Received [DONE] marker.");
          // Potentially yield a final chunk if OpenAI has specific end-of-stream data not in [DONE]
          // Or just break/return if [DONE] is the true end for normalized data.
          // For now, assume [DONE] is final and _normalizeStreamChunk handles regular chunks.
          continue; 
        }

        // Normalize and yield the actual data chunk
        // TTFB is handled in _streamViaGot, so latency here is effectively 0 for subsequent chunks.
        // Finish reason and usage might come in the *last* data chunk from OpenAI if stream_options: { include_usage: true } is set.
        const normalized = this._normalizeStreamChunk(chunk, modelName);
        yield normalized;
      }
    } catch (error) {
      // Log the error with provider context
      logger.error(`[OpenAIProvider.chatCompletionStream] Error during streaming for ${modelName}: ${error.message}`, {
        errorName: error.name,
        errorCode: error.code,
        statusCode: error.statusCode,
        providerDetails: error.details,
        stack: error.stack
      });
      // Re-throw the error; it will be one of our custom errors or a generic Error
      // The ChatController will handle formatting it for the client.
      throw error;
    }
  }

  _normalizeStreamChunk(chunk, modelName) {
    // If chunk is not an object (e.g. [DONE] string that wasn't caught above, or other non-JSON) return null or handle as error.
    if (typeof chunk !== "object" || chunk === null) {
      logger.warn("[OpenAIProvider._normalizeStreamChunk] Received non-object chunk, skipping normalization.", { chunk });
      return null; // Or throw new Error("Invalid chunk type");
    }

    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    const finishReason = choice?.finish_reason;
    
    // OpenAI with `stream_options: { include_usage: true }` sends usage in the *last* event
    // This event might have null delta content but will contain the usage object.
    const usage = chunk.usage ? {
      promptTokens: chunk.usage.prompt_tokens || 0,
      completionTokens: chunk.usage.completion_tokens || 0,
      totalTokens: chunk.usage.total_tokens || 0
    } : null; // Default to null if not present in this specific chunk

    return {
      id: chunk.id,
      model: chunk.model || modelName,
      provider: this.name,
      createdAt: chunk.created ? new Date(chunk.created * 1000).toISOString() : new Date().toISOString(),
      content: delta?.content || null,
      toolCalls: delta?.tool_calls || null,
      usage: usage, // Will be null for most chunks, populated for the last one if stream_options used
      latency: 0, // TTFB is handled by BaseProvider, subsequent chunk latency is not individually tracked here
      finishReason: finishReason || null, // Will be null for most chunks, populated for the last one
      raw: chunk
    };
  }
}

export default OpenAIProvider; 