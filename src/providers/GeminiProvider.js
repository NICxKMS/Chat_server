/**
 * Gemini Provider Implementation
 * Integrates with Google's Generative AI SDK for Gemini models
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";
import http from "http";
import https from "https";
import BaseProvider from "./BaseProvider.js";
import { createBreaker } from "../utils/circuitBreaker.js";
import * as metrics from "../utils/metrics.js";
// Import the specific histogram instance
import { responseTimeHistogram } from "../utils/metrics.js";
import logger from "../utils/logger.js";

// Helper to check if a string is a base64 data URL
const isBase64DataUrl = (str) => /^data:image\/(?:jpeg|png|gif|webp);base64,/.test(str);

// Keep-alive agents to reuse HTTP connections
const keepAliveHttpAgent = new http.Agent({ keepAlive: true });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });

class GeminiProvider extends BaseProvider {
  /**
   * Create a new Gemini provider
   */
  constructor(config) {
    super(config);
    this.name = "gemini";
    

    
    // Validate API key
    if (!config.apiKey) {
      logger.warn("Gemini API key is missing or set to dummy-key. Using fallback mode with limited functionality.");
      this.hasValidApiKey = false;
    } else {
      this.hasValidApiKey = true;
    }
    
    // Store API version from config or environment
    this.apiVersion = config.apiVersion || process.env.GEMINI_API_VERSION || "v1beta";
    // logger.info(`Using Gemini API version: ${this.apiVersion}`);
    
    // Initialize Google Generative AI SDK with gRPC keepalive options to extend session idle timeout
    this.genAI = new GoogleGenerativeAI(
      config.apiKey,
      {
        channelOptions: {
          "grpc.keepalive_time_ms": config.grpcKeepaliveTimeMs || 30000,
          "grpc.keepalive_timeout_ms": config.grpcKeepaliveTimeoutMs || 10000,
          "grpc.keepalive_permit_without_calls": 1
        }
      }
    );
    
    // Extract API version info
    this.apiVersionInfo = {
      version: this.apiVersion,
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
    
    // Initialize with config models
    this.availableModels = this.config.models || [];
    
    // Log initialization
  }

  /**
   * Get available models from Google Generative AI
   */
  async getModels() {
    try {

      // Dynamically fetch models if enabled
      if (this.config.dynamicModelLoading) {
        try {
          // Use Axios to directly call the models endpoint
          const apiKey = this.config.apiKey;
          const baseUrl = `https://generativelanguage.googleapis.com/${this.apiVersion}`;
          
          const response = await axios.get(`${baseUrl}/models`, {
            headers: { "Content-Type": "application/json" },
            params: { key: apiKey },
            httpAgent: keepAliveHttpAgent,
            httpsAgent: keepAliveHttpsAgent
          });
          
          // Dump raw Gemini models list to file
          // try {
          //   fs.writeFileSync("gemini_raw_models.json", JSON.stringify(response.data, null, 2));
          // } catch (e) {
          //   logger.error("Error writing raw Gemini models to file", { error: e.message });
          // }
          
          // If raw models are available, map directly to ProviderModel objects
          if (response.data?.models && Array.isArray(response.data.models)) {
            return response.data.models
              .filter(model => {
                const firstChar = model.name?.[7];
                return firstChar !== "e" && firstChar !== "t" && firstChar !== "c";
              })
              .map(raw => {
                const id = raw.name.replace("models/", "");
                return {
                  id,
                  name: raw.displayName,
                  provider: this.name,
                  tokenLimit: raw.outputTokenLimit,
                  contextSize: raw.inputTokenLimit,
                  // features: this.getModelFeatures(),
                  description: raw.description || ""
                };
              });
          }
        } catch (error) {
          logger.warn(`Failed to dynamically load Gemini models: ${error.message}`);
        }
      }
      
      // Fallback to config models
      return (this.config.models || [
        "gemini-2.0-flash",
        "gemini-2.0-pro",
        "gemini-1.5-pro",
        "gemini-1.0-pro"
      ]).map(id => ({
        id,
        name: this.formatModelName(id),
        provider: this.name,
        tokenLimit: this.getTokenLimit(id),
        // features: this.getModelFeatures(),
        description: ""
      }));
      
    } catch (error) {
      logger.error(`Gemini getModels error: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Format the model name for display
   */
  formatModelName(modelId) {
    return modelId
      .replace("gemini-", "Gemini ")
      .split("-")
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
  
  /**
   * Get token limit for a model
   */
  getTokenLimit(modelId) {
    const limits = {
      "gemini-1.5-pro": 1000000,  // 1M tokens
      "gemini-1.5-flash": 1000000, // 1M tokens
      "gemini-1.0-pro": 32768     // 32K tokens
    };
    
    return limits[modelId] || 32768; // default to 32K
  }
  
  /**
   * Get info about this provider and its models
   */
  async getProvidersInfo(options = {}) {
    try {
      // First get all available models
      await this.fetchAvailableModels(options.includeInternal);
      
      // Convert to ProviderModel objects
      const models = await this.getModels();
      
      // Determine default model
      const defaultModel = this.config.defaultModel || (models.length > 0 ? models[0].id : "gemini-1.5-flash");
      
      return {
        name: this.name,
        models: models,
        defaultModel: defaultModel,
        features: {
          streaming: true,
          vision: true,
          tools: true
        },
        apiVersion: this.apiVersionInfo.version
      };
    } catch (error) {
      logger.error(`Error in getProvidersInfo: ${error.message}`);
      
      // Return at least some default information
      return {
        name: this.name,
        models: [],
        defaultModel: "gemini-1.5-flash",
        features: {
          streaming: true,
          vision: true,
          tools: false
        }
      };
    }
  }

  /**
   * Fetch available models from the API
   */
  async fetchAvailableModels(includeInternal = false) {
    try {
      if (!this.hasValidApiKey) {
        return this.availableModels; // Return cached models if no valid API key
      }

      // Directly use Axios to call the models API
      const apiKey = this.config.apiKey;
      const response = await axios.get(`https://generativelanguage.googleapis.com/${this.apiVersion}/models`, {
        headers: { "Content-Type": "application/json" },
        params: { key: apiKey },
        httpAgent: keepAliveHttpAgent,
        httpsAgent: keepAliveHttpsAgent
      });

      // Process response
      if (response.data && response.data.models) {
        // Filter to just Gemini models
        this.availableModels = response.data.models
          .filter(model => {
            const modelName = model.name.replace("models/", "");
            const isGemini = modelName.startsWith("gemini-");
            const isPublic = !modelName.includes("internal") || includeInternal;
            return isGemini && isPublic;
          })
          .map(model => model.name.replace("models/", ""));
      }

      return this.availableModels;
    } catch (error) {
      logger.error(`Error fetching Gemini models: ${error.message}`);
      return this.availableModels; // Return cached models on error
    }
  }

  /**
   * Get basic provider info
   */
  getInfo() {
    return {
      name: this.name,
      models: this.availableModels,
      defaultModel: this.config.defaultModel,
      apiVersion: this.apiVersionInfo.version,
      lastUpdated: this.apiVersionInfo.lastUpdated
    };
  }

  /**
   * Main chat completion method
   */
  async chatCompletion(options) {
    try {
      if (!this.hasValidApiKey) {
        return {
          id: `error-${Date.now()}`,
          model: options.model || this.config.defaultModel || "gemini-1.5-pro",
          provider: this.name,
          createdAt: new Date().toISOString(),
          content: "API key is invalid or missing. Please configure a valid Google API key.",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latency: 0,
          finishReason: "error",
          errorDetails: {
            message: "Missing or invalid API key",
            type: "auth_error",
            param: null,
            code: "401"
          }
        };
      }

      // Start timer for latency measurement
      const startTime = Date.now();

      // Send request with circuit breaker
      const response = await this.completionBreaker.fire(options);
      const latency = Date.now() - startTime;
      
      // Record successful request metrics
      responseTimeHistogram.observe(latency / 1000);
      metrics.incrementProviderRequestCount(this.name, options.model, "success");
      
      return response;
    } catch (error) {
      // Handle errors with fallback mechanism
      logger.error(`Gemini chat completion error: ${error.message}`);
      metrics.incrementProviderErrorCount(this.name, options.model || this.config.defaultModel, error.status || 500);
      
      try {
        return await this._completionFallback(options, error);
      } catch (fallbackError) {
        logger.error(`Fallback also failed: ${fallbackError.message}`);
        return {
          id: `error-${Date.now()}`,
          model: options.model || this.config.defaultModel || "gemini-1.5-pro",
          provider: this.name,
          createdAt: new Date().toISOString(),
          content: "",
          usage: {
            promptTokens: this._estimateTokens(options.messages.map(m => m.content).join(" ")),
            completionTokens: 40, // Approximate for the fallback message
            totalTokens: this._estimateTokens(options.messages.map(m => m.content).join(" ")) + 40
          },
          latency: 0,
          finishReason: "fallback",
          errorDetails: {
            message: error.message,
            type: "provider_error",
            param: null,
            code: "ECONNRESET"
          }
        };
      }
    }
  }

  /**
   * Raw chat completion implementation
   */
  async _rawChatCompletion(options) {
    const startTime = Date.now(); // Move startTime to the beginning of the method
    const modelName = options.model.startsWith("gemini-") ? options.model : "gemini-1.0-pro"; // Fallback model? Revisit
    const generativeModel = this.genAI.getGenerativeModel({ model: modelName });

    const { contents, systemInstruction } = this._processMessages(options.messages);

    // Prepare generation config
    const generationConfig = {
      // candidateCount: NOT_USED_DIRECTLY (inferred from response)
      // stopSequences: mapped below
      maxOutputTokens: options.max_tokens,
      temperature: options.temperature,
      topP: options.top_p, // top_p is often called topP in SDKs
      // topK: options.top_k // Map if available in options
    };
    if (options.stop) {
      generationConfig.stopSequences = Array.isArray(options.stop) ? options.stop : [options.stop];
    }

    // Prepare safety settings (example - adjust as needed)
    const safetySettings = [
      {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE",
      },
      // Add other categories as needed
    ];

    const requestPayload = {
      contents: contents,
      generationConfig: generationConfig,
      safetySettings: safetySettings,
    };

    // Add system instruction if present
    if (systemInstruction) {
      requestPayload.systemInstruction = systemInstruction;
    }

    // Extract abortSignal for cancellation support
    const abortSignal = options.abortSignal;
    
    try {
      // logger.debug({ geminiPayload: requestPayload }, "Sending request to Gemini"); // Log payload for debugging

      // Propagate abortSignal to the underlying fetch call
      const result = await generativeModel.generateContent(requestPayload, { signal: abortSignal });
      const response = result.response; // Access the response object

      const latency = Date.now() - startTime;
      // Record successful API call latency
      responseTimeHistogram
        .labels(this.name, modelName, "200")
        .observe(latency / 1000); // Observe in seconds

      // logger.debug({ geminiResponse: response }, "Received response from Gemini");

      // Extract text content safely
      const textContent = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const finishReason = response?.candidates?.[0]?.finishReason || "unknown";
      // Usage data might be in promptFeedback or elsewhere depending on API version/response structure
      const usage = {
        promptTokens: response?.usageMetadata?.promptTokenCount || 0,
        completionTokens: response?.usageMetadata?.candidatesTokenCount || 0,
        totalTokens: response?.usageMetadata?.totalTokenCount || 0,
      };

      return {
        id: `gemini-${Date.now()}`, // Gemini doesn't provide a response ID in this structure
        model: modelName,
        provider: this.name,
        createdAt: new Date().toISOString(),
        content: textContent,
        usage: usage,
        latency,
        finishReason: finishReason,
        raw: response // Include the full raw response
      };
    } catch (error) {
      const latency = Date.now() - startTime; // Measure latency even on error
      logger.error(`Gemini raw completion error: ${error.message}`, { model: modelName, error });
      // Record error latency
      responseTimeHistogram
        .labels(this.name, modelName, String(error.status || 500))
        .observe(latency / 1000);

      // Handle specific Gemini errors if possible (e.g., safety blocks)
      if (error.message.includes("SAFETY")) {
        // Handle safety blocks - maybe return a specific error message
        return {
          id: `gemini-err-${Date.now()}`,
          model: modelName,
          provider: this.name,
          createdAt: new Date().toISOString(),
          content: "[Blocked due to safety settings]",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latency,
          finishReason: "SAFETY",
          raw: error.response || error // Include error details if available
        };
      }

      // Re-throw a standardized error or handle fallback
      throw error; // Let the error propagate to be handled by the circuit breaker
    }
  }

  /**
   * Process messages into Gemini-compatible format (history + final prompt)
   * Handles system prompt aggregation and ensures alternating user/model roles in history.
   */
  _processMessages(messages) {
    const contents = [];
    let systemInstruction;
    let currentRole = null;
    let currentParts = [];

    messages.forEach(message => {
      // Handle system instruction (only the first one is usually used by Gemini)
      if (message.role === "system" && !systemInstruction) {
        // Gemini expects system instruction as a separate object with a 'parts' array
        if (typeof message.content === "string") {
          systemInstruction = { parts: [{ text: message.content }] };
        } else if (Array.isArray(message.content) && message.content.length > 0 && message.content[0].type === "text") {
          // Handle potential array format if system prompt ever becomes multimodal (unlikely for now)
          systemInstruction = { parts: [{ text: message.content[0].text }] };
        }
        return; // Skip adding system message to main contents
      }

      // Determine the API role ('user' or 'model')
      const apiRole = message.role === "assistant" ? "model" : "user";

      // Start a new content block if the role changes
      if (apiRole !== currentRole && currentParts.length > 0) {
        contents.push({ role: currentRole, parts: currentParts });
        currentParts = [];
      }
      currentRole = apiRole;

      // Process message content (text or multimodal)
      if (typeof message.content === "string") {
        currentParts.push({ text: message.content });
      } else if (Array.isArray(message.content)) {
        message.content.forEach(item => {
          if (item.type === "text") {
            currentParts.push({ text: item.text });
          } else if (item.type === "image_url" && item.image_url?.url) {
            const url = item.image_url.url;
            if (isBase64DataUrl(url)) {
              const base64Data = url.split(",")[1];
              const mimeType = url.match(/^data:(image\/[^;]+);base64,/)?.[1] || "image/jpeg"; // Default to jpeg
              currentParts.push({
                inline_data: {
                  mime_type: mimeType,
                  data: base64Data
                }
              });
            } else {
              // Handle non-base64 URLs if necessary (Gemini might support fetching)
              // For now, we'll log a warning and skip
              logger.warn(`Skipping non-base64 image URL for Gemini: ${url}`);
              // Potentially add a text placeholder:
              // currentParts.push({ text: `[Image URL: ${url}]` });
            }
          }
        });
      }
    });

    // Add the last accumulated parts
    if (currentParts.length > 0) {
      contents.push({ role: currentRole, parts: currentParts });
    }

    // Gemini requires alternating user/model roles, starting with user.
    // Add an empty user message if the first message isn't user.
    if (contents.length > 0 && contents[0].role !== "user") {
      contents.unshift({ role: "user", parts: [{ text: "" }] }); // Or a more meaningful placeholder
    }
    // Ensure the last message is from the user role for the API call
    if (contents.length > 0 && contents[contents.length - 1].role !== "user") {
      // This might happen if the last message was assistant. Often models expect a user prompt last.
      // Depending on the use case, you might append an empty user message or handle differently.
      logger.warn("Last message to Gemini is not from 'user'. API might behave unexpectedly.");
      // Option: Append empty user message
      // contents.push({ role: 'user', parts: [{ text: '' }] });
    }


    return { contents, systemInstruction };
  }

  /**
   * Completion fallback mechanism
   */
  async _completionFallback(options, error) {
    logger.warn(`Executing Gemini fallback for model ${options.model} due to error: ${error.message}`);
    // Increment fallback metric
    metrics.incrementProviderErrorCount(this.name, options.model, "fallback");

    // Simple fallback: return an error message
    return {
      id: `gemini-fallback-${Date.now()}`,
      model: options.model,
      provider: this.name,
      createdAt: new Date().toISOString(),
      content: `[Error communicating with Gemini: ${error.message}]`,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      latency: 0, // Latency doesn't apply to fallback generation
      finishReason: "error",
      raw: { error: error.message }
    };
  }

  /**
   * Estimate token count based on character count
   */
  _estimateTokens(text) {
    if (!text) {return 0;}
    // Simple estimation: ~4 chars per token for English text
    return Math.ceil(text.length / 4);
  }

  /**
   * Send a chat completion request with streaming response using the Google AI SDK.
   * Implements the `chatCompletionStream` method defined in `BaseProvider`.
   * @param {object} options - The request options (model, messages, etc.), standardized.
   * @yields {object} Standardized response chunks compatible with the API format.
   * @throws {Error} If the API key is missing, the API request fails, or the stream encounters an error.
   */
  async *chatCompletionStream(options) {
    const startTime = process.hrtime();
    let modelName;
    try {
      if (!this.hasValidApiKey) {
        throw new Error("Gemini provider requires a valid API key for streaming.");
      }

      // Standardize and validate options
      const standardOptions = this.standardizeOptions(options);
      this.validateOptions(standardOptions); // Use BaseProvider validation

      // Extract model name (remove provider prefix if present)
      modelName = standardOptions.model.includes("/")
        ? standardOptions.model.split("/")[1]
        : standardOptions.model;

      // Select the correct generative model
      const generativeModel = this.genAI.getGenerativeModel({ model: modelName });

      // Prepare messages and system prompt using the corrected method
      const { contents, systemInstruction } = this._processMessages(standardOptions.messages);

      // Validate that formattedContents is an array before proceeding
      if (!Array.isArray(contents)) {
        throw new Error("_processMessages did not return a valid formattedContents array.");
      }

      // Prepare request body (messages, generationConfig)
      const request = {
        contents: contents,
        generationConfig: {
          temperature: standardOptions.temperature,
          maxOutputTokens: standardOptions.max_tokens,
          stopSequences: standardOptions.stop
        },
        safetySettings: standardOptions.safety_settings || []
      };

      // Add system instruction if a system prompt exists
      if (systemInstruction) {
        request.systemInstruction = systemInstruction;
      }

      // Generate content stream using the Google AI SDK, propagating abortSignal
      const streamResult = await generativeModel.generateContentStream(
        request,
        { signal: standardOptions.abortSignal }
      );

      let firstChunk = true;
      let accumulatedLatency = 0;

      // Iterate through the stream response chunks
      for await (const chunk of streamResult.stream) {
        if (firstChunk) {
          const duration = process.hrtime(startTime);
          accumulatedLatency = (duration[0] * 1000) + (duration[1] / 1000000);
          metrics.recordStreamTtfb(this.name, modelName, accumulatedLatency / 1000);
          firstChunk = false;
        }

        // Normalize the Gemini chunk and yield it
        const normalizedChunk = this._normalizeStreamChunk(chunk, modelName, accumulatedLatency);
        yield normalizedChunk;
      }

      // Record successful stream completion
      metrics.incrementProviderRequestCount(
        this.name,
        modelName,
        "success"
      );

    } catch (error) {
      logger.error(`Gemini stream error: ${error.message}`, error);
      if (modelName) {
        metrics.incrementProviderErrorCount(this.name, modelName, error.status || 500);
      }
      // Rethrow abort errors silently
      if (error.name === "AbortError") {
        return;
      }
      throw new Error(`Gemini stream error: ${error.message}`);
    }
  }

  /**
   * Normalize a streaming chunk received from the Gemini API stream.
   * @param {object} chunk - The raw chunk object from the `generateContentStream`.
   * @param {string} model - The model name used for the request.
   * @param {number} latency - The latency to the first chunk (milliseconds).
   * @returns {object} A standardized chunk object matching the API schema.
   */
  _normalizeStreamChunk(chunk, model, latency) {
    let content = "";
    let finishReason = null;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    try {
      // Extract text content from the candidates
      if (chunk.candidates && chunk.candidates[0]?.content?.parts) {
        content = chunk.candidates[0].content.parts
          .filter(part => part.text)
          .map(part => part.text)
          .join("");
      }
      
      // Extract finish reason if available
      finishReason = chunk.candidates?.[0]?.finishReason || null;

      // Extract token counts if available
      const usageMetadata = chunk.usageMetadata;
      if (usageMetadata) {
        promptTokens = usageMetadata.promptTokenCount || 0;
        completionTokens = usageMetadata.candidatesTokenCount || 0;
        totalTokens = usageMetadata.totalTokenCount || 0;
      }
    } catch (e) {
      logger.error("Error parsing Gemini stream chunk:", e, chunk);
    }
    
    return {
      id: `chunk-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`,
      model: model,
      provider: this.name,
      createdAt: new Date().toISOString(),
      content: content,
      finishReason: finishReason,
      usage: {
        promptTokens: promptTokens,
        completionTokens: completionTokens,
        totalTokens: totalTokens
      },
      latency: latency || 0,
      raw: chunk
    };
  }
}

export default GeminiProvider; 