/**
 * Anthropic API Provider
 * Implements the BaseProvider for Anthropic's Claude models
 */
import BaseProvider from "./BaseProvider.js";
import axios from "axios";
import { createBreaker } from "../utils/circuitBreaker.js";
import logger from "../utils/logger.js";
import * as metrics from "../utils/metrics.js";
import { promisify } from "util";

// Helper to check if a string is a base64 data URL and extract parts
const parseBase64DataUrl = (str) => {
  const match = str.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.*)$/);
  if (match) {
    return { mediaType: match[1], data: match[2] };
  }
  return null;
};

/**
 * Anthropic Provider implementation
 * Handles API requests to Anthropic for Claude models
 */
export class AnthropicProvider extends BaseProvider {
  /**
   * Create a new Anthropic provider
   */
  constructor(config) {
    super(config);
    
    this.name = "anthropic"; // Set the provider name
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || "https://api.anthropic.com";
    this.apiVersion = config.apiVersion || "2023-06-01";
    this.defaultModel = config.defaultModel || "claude-3-opus-20240229";
    this.modelFamily = config.modelFamily || "claude";
    
    // Validate config
    if (!this.apiKey) {
      throw new Error("Anthropic API key is required");
    }
    
    // Set up HTTP client
    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
        "anthropic-version": this.apiVersion
      }
    });
    
    // Set up circuit breaker for API requests
    this.completionBreaker = createBreaker(`${this.name}-completion`, 
      (params) => this.rawCompletion(params), 
      {
        failureThreshold: 3,
        resetTimeout: 30000,
        errorThreshold: 50
      }
    );
    
    logger.info(`Anthropic provider initialized with model family: ${this.modelFamily}`);
  }
  
  /**
   * Get available models from Anthropic
   */
  async getModels() {
    try {
      // Anthropic doesn't have a specific models endpoint, so we hardcode the available models
      // This should be updated as new models are released
      const claudeModels = [
        {
          id: "claude-3-opus-20240229",
          name: "Claude 3 Opus",
          provider: this.name,
          tokenLimit: 200000,
          features: {
            vision: true,
            tools: true,
            streaming: true,
            json: true,
            system: true
          }
        },
        {
          id: "claude-3-sonnet-20240229",
          name: "Claude 3 Sonnet",
          provider: this.name,
          tokenLimit: 200000,
          features: {
            vision: true,
            tools: true,
            streaming: true,
            json: true,
            system: true
          }
        },
        {
          id: "claude-3-haiku-20240307",
          name: "Claude 3 Haiku",
          provider: this.name,
          tokenLimit: 200000,
          features: {
            vision: true,
            tools: true,
            streaming: true,
            json: true,
            system: true
          }
        },
        {
          id: "claude-2.1",
          name: "Claude 2.1",
          provider: this.name,
          tokenLimit: 200000,
          features: {
            vision: false,
            tools: false,
            streaming: true,
            json: true,
            system: true
          }
        },
        {
          id: "claude-2.0",
          name: "Claude 2.0",
          provider: this.name,
          tokenLimit: 100000,
          features: {
            vision: false,
            tools: false,
            streaming: true,
            json: true,
            system: true
          }
        },
        {
          id: "claude-instant-1.2",
          name: "Claude Instant 1.2",
          provider: this.name,
          tokenLimit: 100000,
          features: {
            vision: false,
            tools: false,
            streaming: true,
            json: true,
            system: true
          }
        }
      ];
      
      return claudeModels;
    } catch (error) {
      logger.error(`Error fetching Anthropic models: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create Anthropic-compatible messages from standard format
   * Handles system messages, user/assistant roles, and multimodal content.
   * @param {Array<object>} messages - Standardized messages array.
   * @returns {object} { anthropicMessages: Array<object>, systemPrompt: string | undefined }
   */
  createMessages(messages) {
    let systemPrompt = undefined;
    const anthropicMessages = [];

    for (const message of messages) {
      if (message.role === "system") {
        // Capture the first system message content
        if (systemPrompt === undefined) {
          if (typeof message.content === 'string') {
            systemPrompt = message.content;
          } else if (Array.isArray(message.content) && message.content[0]?.type === 'text') {
            // Handle array format for system prompt if needed (usually just text)
            systemPrompt = message.content[0].text;
          }
        }
        continue; // Skip adding system message to the main message list
      }

      if (message.role === "user" || message.role === "assistant") {
        const contentParts = [];

        if (typeof message.content === "string") {
          contentParts.push({ type: "text", text: message.content });
        } else if (Array.isArray(message.content)) {
          message.content.forEach(item => {
            if (item.type === "text") {
              contentParts.push({ type: "text", text: item.text });
            } else if (item.type === "image_url" && item.image_url?.url) {
              const parsed = parseBase64DataUrl(item.image_url.url);
              if (parsed) {
                contentParts.push({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: parsed.mediaType,
                    data: parsed.data
                  }
                });
              } else {
                // Handle non-base64 URLs if necessary (Anthropic might support URLs directly in some cases)
                // For now, log a warning and potentially add a text placeholder
                logger.warn(`Skipping non-base64 image URL for Anthropic: ${item.image_url.url}`);
                // contentParts.push({ type: "text", text: `[Image URL: ${item.image_url.url}]` });
              }
            }
          });
        }

        // Only add the message if it has content parts
        if (contentParts.length > 0) {
          anthropicMessages.push({
            role: message.role,
            content: contentParts
          });
        }
      }
    }

    // Anthropic API requires messages to alternate between user and assistant.
    // Add an empty user message if the sequence starts with assistant.
    if (anthropicMessages.length > 0 && anthropicMessages[0].role === 'assistant') {
        anthropicMessages.unshift({ role: 'user', content: [{ type: 'text', text: '' }] }); // Or a more meaningful placeholder
         logger.warn("Anthropic message sequence started with assistant. Prepending empty user message.");
    }
    // Ensure the last message is not from the assistant (API requirement)
     if (anthropicMessages.length > 0 && anthropicMessages[anthropicMessages.length - 1].role === 'assistant') {
        // Anthropic API often errors if the last message is from the assistant.
        // Option 1: Append an empty user message (might not be ideal for all scenarios)
        // anthropicMessages.push({ role: 'user', content: [{ type: 'text', text: '' }] });
        // logger.warn("Last message to Anthropic was from assistant. API might error.");
        // Option 2: Log a warning and let it potentially fail (more informative)
        logger.warn("Last message to Anthropic is from the assistant. The API might reject this sequence.");
        // Option 3: Depending on use case, could trim the last assistant message, but that loses context.
    }


    return { anthropicMessages, systemPrompt };
  }

  /**
   * Send a completion request to Anthropic
   * @deprecated Use chatCompletion or chatCompletionStream instead
   */
  async sendCompletion(messages, options = {}) {
    // This method seems deprecated based on the newer chatCompletion structure
    // Should ideally be removed or updated to call chatCompletion
    logger.warn("AnthropicProvider.sendCompletion is deprecated. Use chatCompletion instead.");
    // Simple pass-through for compatibility, assuming options structure matches
    return this.chatCompletion({ messages, ...options });
  }

  /**
   * Raw completion API call to Anthropic
   */
  async rawCompletion(params) {
    try {
      const startTime = Date.now();
      
      // Make API request
      const response = await this.httpClient.post("/v1/messages", params);
      
      // Calculate latency
      const latency = Date.now() - startTime;
      
      // Parse response
      return this.parseResponse(response.data, params.model, latency);
    } catch (error) {
      logger.error(`Error in Anthropic rawCompletion: ${error.message}`);
      throw error;
    }
  }

  /**
   * Parses and standardizes the non-streaming response from the Anthropic API.
   * @param {object} data - The raw response data from Anthropic.
   * @param {string} model - The model name used.
   * @param {number} latency - The request latency in milliseconds.
   * @returns {object} A standardized response object.
   */
  parseResponse(data, model, latency) {
    // Extract the content text
    let contentText = "";
    
    if (data.content && Array.isArray(data.content)) {
      // Extract text content from content array
      contentText = data.content
        .filter(item => item.type === "text")
        .map(item => item.text || "")
        .join("");
    }
    
    // Create standardized response format
    const response = {
      id: data.id || `anthropic-${Date.now()}`,
      model: model,
      provider: this.name,
      createdAt: new Date().toISOString(),
      content: contentText,
      usage: {
        promptTokens: data.usage?.input_tokens || 0,
        completionTokens: data.usage?.output_tokens || 0,
        totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
      },
      latency: latency,
      finishReason: data.stop_reason || "unknown",
      raw: data
    };
    
    return response;
  }

  /**
   * Handle streaming response from Anthropic
   */
  async handleStreamResponse(response, model) {
    // Implementation for streaming would go here
    throw new Error("Streaming not implemented for Anthropic provider");
  }

  /**
   * Handle API errors
   */
  handleError(error) {
    let errorMessage = "Unknown error";
    let statusCode = 500;
    
    if (error.response) {
      // Get error details from Anthropic response
      const errorData = error.response.data;
      statusCode = error.response.status;
      
      if (errorData && errorData.error) {
        errorMessage = `${errorData.error.type}: ${errorData.error.message}`;
      } else {
        errorMessage = `HTTP Error: ${error.response.status}`;
      }
    } else if (error.request) {
      // No response received
      errorMessage = "No response received from Anthropic API";
    } else {
      // Request error
      errorMessage = error.message;
    }
    
    logger.error(`Anthropic API error: ${errorMessage}`);
    
    // Return error in standard format
    return {
      id: `error-${Date.now()}`,
      model: "unknown",
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
        message: errorMessage,
        type: "api_error",
        param: null,
        code: statusCode.toString()
      }
    };
  }

  /**
   * Send a chat completion request to Anthropic
   */
  async chatCompletion(options) {
    try {
      // Standardize and validate options (inherited from BaseProvider)
      const standardOptions = this.standardizeOptions(options);
      this.validateOptions(standardOptions); // Ensures model and messages exist

      // Process messages into Anthropic format
      const { anthropicMessages, systemPrompt } = this.createMessages(standardOptions.messages);

      // Prepare request parameters
      const params = {
        model: standardOptions.model || this.defaultModel,
        messages: anthropicMessages,
        max_tokens: standardOptions.max_tokens || 4096,
        temperature: standardOptions.temperature ?? 0.7, // Use nullish coalescing for 0 temperature
        stream: false
      };

      // Add optional parameters if provided
      if (systemPrompt) {params.system = systemPrompt;}
      if (standardOptions.top_p !== undefined) {params.top_p = standardOptions.top_p;}
      if (standardOptions.top_k !== undefined) {params.top_k = standardOptions.top_k;}
      if (standardOptions.stop) {params.stop_sequences = Array.isArray(standardOptions.stop) ? standardOptions.stop : [standardOptions.stop];}

      logger.debug(`Sending non-streaming request to Anthropic with model: ${params.model}`);

      // Use circuit breaker to make the raw API call
      // Note: The breaker function `rawCompletion` needs to be adapted or this call structure adjusted
      // Assuming rawCompletion will be updated to match this param structure
      return await this.completionBreaker.fire(params);

    } catch (error) {
      logger.error(`Error in Anthropic chatCompletion: ${error.message}`);
      // Consider using a centralized error handler or re-throwing specific types
      throw this.handleError(error); // Use existing error handling
    }
  }

  /**
   * Send a streaming chat completion request to Anthropic
   */
   async *chatCompletionStream(options) {
    let streamStartTime;
    let modelName;
    try {
      // Standardize and validate options
      const standardOptions = this.standardizeOptions(options);
      this.validateOptions(standardOptions);
      modelName = standardOptions.model || this.defaultModel; // Capture model name for metrics

      // Process messages into Anthropic format
      const { anthropicMessages, systemPrompt } = this.createMessages(standardOptions.messages);

      // Prepare request parameters for streaming
      const params = {
        model: modelName,
        messages: anthropicMessages,
        max_tokens: standardOptions.max_tokens || 4096,
        temperature: standardOptions.temperature ?? 0.7,
        stream: true // Enable streaming
      };

      // Add optional parameters
      if (systemPrompt) {params.system = systemPrompt;}
      if (standardOptions.top_p !== undefined) {params.top_p = standardOptions.top_p;}
      if (standardOptions.top_k !== undefined) {params.top_k = standardOptions.top_k;}
      if (standardOptions.stop) {params.stop_sequences = Array.isArray(standardOptions.stop) ? standardOptions.stop : [standardOptions.stop];}

      logger.debug(`Sending streaming request to Anthropic with model: ${params.model}`);

      streamStartTime = Date.now();

      // Make the streaming API request directly using httpClient
      // Circuit breaker integration for streams needs careful handling (e.g., break on initial connection failure)
      const response = await this.httpClient.post("/v1/messages", params, {
        responseType: 'stream'
      });

      let accumulatedLatency = 0; // Only for TTFB
      let firstChunk = true;
      let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let finishReason = "unknown";
      let currentMessageId = null;

      // Process the stream
      for await (const chunk of response.data) {
        const chunkLatency = firstChunk ? Date.now() - streamStartTime : 0;
        accumulatedLatency += chunkLatency;

        if (firstChunk) {
          // Convert latency to seconds for the metrics function
          metrics.recordStreamTtfb(this.name, modelName, chunkLatency / 1000);
          firstChunk = false;
        }

        // Process the chunk (assuming it's line-delimited JSON)
        const lines = chunk.toString('utf8').split('\n').filter(line => line.trim() !== '');
        for (const line of lines) {
          if (line.startsWith('event:')) {
             const eventType = line.replace('event:', '').trim();
             const dataLine = lines.find(l => l.startsWith('data:')); // Find corresponding data line
             if (dataLine) {
                const dataStr = dataLine.replace('data:', '').trim();
                try {
                  const data = JSON.parse(dataStr);
                   // Update usage and finish reason based on events
                   if (eventType === 'message_start' && data.message) {
                      currentMessageId = data.message.id;
                      if(data.message.usage) {
                           usage.promptTokens = data.message.usage.input_tokens || 0;
                           usage.totalTokens = usage.promptTokens; // Initialize total
                      }
                   }
                   if (eventType === 'message_delta' && data.usage) {
                       usage.completionTokens = data.usage.output_tokens || 0;
                       usage.totalTokens = usage.promptTokens + usage.completionTokens;
                   }
                    if (eventType === 'message_stop' && data.message) { // Anthropic uses message_stop for the final message state
                       // Finish reason might be in the top-level anthropic_version specific block
                       // Need to check the actual structure from Anthropic docs/tests
                       finishReason = data["message"]?.stop_reason || "stop"; // Example access path
                       // Ensure usage reflects the final count if provided here
                        if(data.message.usage) {
                           usage.completionTokens = data.message.usage.output_tokens || usage.completionTokens;
                           usage.totalTokens = usage.promptTokens + usage.completionTokens;
                        }
                    }

                   const normalizedChunk = this._normalizeStreamChunk(eventType, data, modelName, chunkLatency, finishReason, usage, currentMessageId);
                   if (normalizedChunk) { // Only yield if normalization produced a chunk
                      yield normalizedChunk;
                   }
                } catch (parseError) {
                  logger.warn(`Failed to parse Anthropic stream data: ${parseError.message}`, { line });
                }
             }
          } // else ignore non-event lines
        }
      }
       logger.info(`Anthropic stream completed for model ${modelName}. Finish Reason: ${finishReason}`);
       // Send final chunk if needed (Anthropic might not require explicit DONE)
        yield {
             id: currentMessageId ? `${currentMessageId}-final` : `anthropic-final-${Date.now()}`,
             model: modelName,
             provider: this.name,
             createdAt: new Date().toISOString(),
             content: null,
             usage: usage,
             latency: 0,
             finishReason: finishReason,
             raw: null // No final raw object unless specifically available
           };


    } catch (error) {
      const streamLatency = streamStartTime ? Date.now() - streamStartTime : 0;
      logger.error(`Anthropic stream error: ${error.message}`, { model: modelName, error });
      metrics.incrementStreamErrorCount(this.name, modelName, error.response?.status || 'unknown');

      // Yield a final error chunk
       yield {
         id: `anthropic-stream-error-${Date.now()}`,
         model: modelName,
         provider: this.name,
         error: {
           message: `Anthropic stream error: ${error.response?.data?.error?.message || error.message}`,
           code: error.response?.status || 500,
           type: error.response?.data?.error?.type || 'ProviderStreamError'
         },
         finishReason: "error",
         usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
         latency: streamLatency
       };
       // Handle stream cleanup if necessary
       // throw error; // Optional: rethrow

    } finally {
       if (streamStartTime) {
         const durationSeconds = (Date.now() - streamStartTime) / 1000;
         metrics.recordStreamDuration(this.name, modelName, durationSeconds);
       }
       // Perform any necessary cleanup, e.g., aborting requests if using AbortController
    }
  }

  /**
   * Normalizes a chunk from the Anthropic stream.
   * @param {string} eventType - The type of the event (e.g., 'message_delta').
   * @param {object} data - The parsed data object from the stream.
   * @param {string} model - The model name.
   * @param {number} latency - Latency (for first chunk).
   * @param {string} finishReason - Current finish reason.
   * @param {object} usage - Current usage object.
   * @param {string|null} messageId - The ID of the current message being streamed.
   * @returns {object | null} Standardized chunk or null if it's not a content chunk.
   */
  _normalizeStreamChunk(eventType, data, model, latency, finishReason, usage, messageId) {
    let contentDelta = null;

    if (eventType === 'content_block_delta' && data.delta?.type === 'text_delta') {
      contentDelta = data.delta.text;
    } else if (eventType === 'message_delta' && data.delta?.type === 'text_delta') {
        // Older Anthropic versions might use message_delta for text
        contentDelta = data.delta.text;
    }

    // Only yield chunks that contain actual text content delta
    if (contentDelta !== null && contentDelta !== '') {
      return {
        id: messageId ? `${messageId}-chunk-${Date.now()}` : `anthropic-chunk-${Date.now()}`,
        model: model,
        provider: this.name,
        createdAt: new Date().toISOString(),
        content: contentDelta,
        usage: usage, // Include cumulative usage
        latency: latency, // Only relevant for the first chunk (TTFB)
        finishReason: finishReason, // Include current finish reason state
        raw: { type: eventType, delta: data.delta } // Include minimal raw delta info
      };
    } else if (eventType === 'message_stop') {
        // We handle the final meta-information yield outside this function
        return null;
    }
    
    // Ignore other event types like message_start, content_block_start, ping etc. for standard chunk output
    return null;
  }
}

export default AnthropicProvider; 