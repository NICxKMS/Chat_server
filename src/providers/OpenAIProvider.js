/**
 * OpenAI Provider Implementation
 * Efficiently integrates with OpenAI's API using their official SDK
 */
import { OpenAI } from "openai";
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
    console.log(`OpenAIProvider initialized with ${this.cachedModels.length} initial models from config`);
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
        console.log(`Using ${this.cachedModels.length} cached OpenAI models from previous API call`);
        return this.cachedModels;
      }
      
      console.log("Fetching models from OpenAI API...");
      
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
        
        if (!response || !response.data || !Array.isArray(response.data)) {
          console.error("Invalid response format from OpenAI API:", response);
          throw new Error("Invalid response format from OpenAI models API");
        }
        
        console.log(`Received ${response.data.length} models from OpenAI API`);
        
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
            features: this._getModelFeatures(model.id)
          }));
      
      
        // Cache all available models from API - no config filtering
        this.cachedModels = filteredModels;
        this.modelsLoadedFromAPI = true;
        this.hasModels = true;
        
        console.log(`Successfully loaded ${this.cachedModels.length} models from OpenAI API`);
        
        return filteredModels;
      } catch (error) {
        console.error("Error fetching OpenAI models from API:", error.message);
        
        // If we have previously loaded models from the API, return those
        if (this.modelsLoadedFromAPI && this.cachedModels.length > 0) {
          console.log(`Using ${this.cachedModels.length} previously cached models from API due to error`);
          return this.cachedModels;
        }
        
        // If we have config models, return those
        if (this.hasModels && this.cachedModels.length > 0) {
          console.log(`Using ${this.cachedModels.length} models from config due to API error`);
          return this.cachedModels;
        }
        
        // Otherwise use fallback models
        console.log(`Using ${fallbackModels.length} hardcoded fallback models due to API error`);
        const models = this._createModelObjects(fallbackModels);
        this.cachedModels = models;
        this.hasModels = true;
        return models;
      }
    } catch (error) {
      console.error("Error in getModels:", error.message);
      
      // Return any models we have or use fallback models
      if (this.hasModels && this.cachedModels.length > 0) {
        return this.cachedModels;
      }
      
      return this._createModelObjects(this.config.models || []);
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
      features: this._getModelFeatures(id)
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
  
  /**
   * Get features supported by a model
   */
  _getModelFeatures(modelId) {
    // Default features
    const features = {
      vision: false,
      streaming: true,
      functionCalling: false,
      tools: false,
      json: false,
      system: true
    };
    
    // GPT-4 Vision models
    if (modelId.includes("vision") || modelId.includes("gpt-4-turbo") || modelId.includes("gpt-4o")) {
      features.vision = true;
    }
    
    // Tool/function calling models
    if (modelId.includes("gpt-4") || modelId.includes("gpt-3.5-turbo")) {
      features.functionCalling = true;
      features.tools = true;
    }
    
    // JSON mode support
    if (modelId.includes("gpt-4") || modelId.includes("gpt-3.5-turbo")) {
      features.json = true;
    }
    
    return features;
  }

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
      console.error(`OpenAI API error: ${error.message}`);
      
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
          if (item.type === 'text') {
            return { type: 'text', text: item.text };
          } else if (item.type === 'image_url' && item.image_url?.url) {
            // OpenAI accepts image URLs directly (including base64 data URLs)
            return { type: 'image_url', image_url: { url: item.image_url.url } };
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
      else if (typeof message.content === 'string') {
        return {
          role: message.role,
          content: message.content
        };
      } else {
         // Handle cases where content might be missing or has unexpected format
         logger.warn(`Message with unexpected content format skipped for OpenAI:`, message);
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
       ...(options.response_format?.type === 'json_object' && { response_format: { type: 'json_object' } })
    };

    try {
      const startTime = Date.now();
      logger.debug({ openAIPayload: payload }, "Sending request to OpenAI");

      const response = await this.client.chat.completions.create(payload);

      const latency = Date.now() - startTime;
      logger.debug({ openAIResponse: response }, "Received response from OpenAI");

      // Normalize the response
      return this._normalizeResponse(response, modelName, latency);
    } catch (error) {
      const latency = Date.now() - startTime; // Record latency even on error
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
   * @param {object} options - Standardized request options.
   * @yields {object} Standardized response chunks.
   * @throws {Error} If API error occurs.
   */
  async *chatCompletionStream(options) {
    let modelName;
    let streamStartTime;
    try {
      // Standardize and validate options
      const standardOptions = this.standardizeOptions(options);
      this.validateOptions(standardOptions);

      // Extract model name
      modelName = standardOptions.model.includes("/")
        ? standardOptions.model.split("/")[1]
        : standardOptions.model;

      // Process messages for potential multimodal content
      const processedMessages = this._processMessagesForOpenAI(standardOptions.messages);

      // Prepare the payload for streaming
      const payload = {
        model: modelName,
        messages: processedMessages,
        temperature: standardOptions.temperature,
        max_completion_tokens: standardOptions.max_tokens,
        stream: true,
        // Include other optional parameters
        ...(standardOptions.top_p !== undefined && { top_p: standardOptions.top_p }),
        ...(standardOptions.frequency_penalty !== undefined && { frequency_penalty: standardOptions.frequency_penalty }),
        ...(standardOptions.presence_penalty !== undefined && { presence_penalty: standardOptions.presence_penalty }),
        ...(standardOptions.stop && { stop: standardOptions.stop }),
        ...(standardOptions.response_format?.type === 'json_object' && { response_format: { type: 'json_object' } })
      };

      logger.debug({ openAIStreamPayload: payload }, "Sending stream request to OpenAI");
      streamStartTime = Date.now();

      // Use the OpenAI SDK's streaming method
      const stream = await this.client.chat.completions.create(payload);

      let accumulatedLatency = 0;
      let firstChunk = true;
       let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }; // Initialize usage
       let finishReason = "unknown"; // Initialize finish reason
       let finalChunkProcessed = false;

      for await (const chunk of stream) {
        const chunkLatency = firstChunk ? Date.now() - streamStartTime : 0;
        accumulatedLatency += chunkLatency;

        if (firstChunk) {
          // Convert latency to seconds for the metrics function
          metrics.recordStreamTtfb(this.name, modelName, chunkLatency / 1000); 
          firstChunk = false;
        }

        // Extract usage and finish reason if available in the chunk
        // OpenAI stream chunks typically contain delta content, but the final chunk might have full usage/finish_reason.
        // Sometimes usage/finish reason might be on the `.x_stream_final_response.usage` or similar experimental fields.

        // Prioritize final response data if available (check varies by SDK version)
         const finalResponse = chunk.x_stream_final_response; // Example check
         if (finalResponse) {
             if (finalResponse.usage) {
                usage = { // Update with final accurate usage
                  promptTokens: finalResponse.usage.prompt_tokens || usage.promptTokens,
                  completionTokens: finalResponse.usage.completion_tokens || usage.completionTokens,
                  totalTokens: finalResponse.usage.total_tokens || usage.totalTokens
                };
             }
             if (finalResponse.choices && finalResponse.choices[0]?.finish_reason) {
                finishReason = finalResponse.choices[0].finish_reason;
             }
              finalChunkProcessed = true; // Mark that we got the final meta-data chunk
         } else {
            // For regular delta chunks, update based on the chunk data itself
             const choice = chunk.choices?.[0];
             if (choice?.finish_reason) {
               finishReason = choice.finish_reason; // Update finish reason if present in a delta
             }
             // Usage might be harder to accumulate accurately from deltas alone
             // We often rely on the final chunk or estimate based on content length.
         }


        const normalizedChunk = this._normalizeStreamChunk(chunk, modelName, chunkLatency, finishReason, usage);
         if (normalizedChunk.content || normalizedChunk.finishReason !== 'unknown' || normalizedChunk.toolCalls) { // Yield if there is content, tool calls, or a finish reason update
              yield normalizedChunk;
         }

      }

       logger.info(`OpenAI stream completed for model ${modelName}. Finish Reason: ${finishReason}`);
       // If the final metadata wasn't processed via an x_stream_final_response chunk,
       // send one last meta-chunk if the finish reason is known.
       if (!finalChunkProcessed && finishReason !== 'unknown') {
           yield {
               id: `openai-final-${Date.now()}`,
               model: modelName,
               provider: this.name,
               createdAt: new Date().toISOString(),
               content: null,
               usage: usage, // Send last known usage
               latency: 0,
               finishReason: finishReason,
               raw: null
           };
       }


    } catch (error) {
      const streamLatency = streamStartTime ? Date.now() - streamStartTime : 0;
      logger.error(`OpenAI stream error: ${error.message}`, { model: modelName, error });
       let statusCode = 500;
       if (error.status) {
         statusCode = error.status;
       }
      metrics.incrementStreamErrorCount(this.name, modelName, statusCode.toString());

      // Yield a final error chunk
      yield {
         id: `openai-stream-error-${Date.now()}`,
         model: modelName,
         provider: this.name,
         error: {
           message: `OpenAI stream error: ${error.message}`,
           code: statusCode,
           type: error.name || 'ProviderStreamError'
         },
         finishReason: "error",
         usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
         latency: streamLatency
       };
        // throw error; // Option to rethrow

    } finally {
       if (streamStartTime) {
         const durationSeconds = (Date.now() - streamStartTime) / 1000;
         metrics.recordStreamDuration(this.name, modelName, durationSeconds);
       }
    }
  }

  /**
   * Normalizes a streaming chunk from the OpenAI API response.
   * @param {object} chunk - Raw chunk data from the OpenAI stream.
   * @param {string} model - Model name.
   * @param {number} latency - Latency for this chunk (usually only first chunk).
   * @param {string} finishReason - Current best guess of finish reason.
   * @param {object} usage - Current accumulated usage data.
   * @returns {object} Standardized stream chunk.
   */
  _normalizeStreamChunk(chunk, model, latency, finishReason, usage) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    return {
      id: chunk.id,
      model: chunk.model || model,
      provider: this.name,
      createdAt: chunk.created ? new Date(chunk.created * 1000).toISOString() : new Date().toISOString(),
      // Extract content delta safely
      content: delta?.content || null,
      // Include tool calls delta if present
      toolCalls: delta?.tool_calls || null,
      usage: usage, // Send current state of usage
      latency: latency, // Only relevant for first chunk (TTFB)
      finishReason: finishReason, // Send current state of finish reason
      raw: chunk // Include the raw chunk for potential downstream use
    };
  }
}

export default OpenAIProvider; 