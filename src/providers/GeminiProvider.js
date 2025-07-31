/**
 * Gemini Provider Implementation
 * Integrates with Google's Generative AI SDK for Gemini models
 */
import { GoogleGenAI } from "@google/genai";
// Removed manual HTTP imports; using GenAI SDK exclusively
import BaseProvider from "./BaseProvider.js";
import * as metrics from "../utils/metrics.js";
// Removed unused responseTimeHistogram import
import logger from "../utils/logger.js";

// Helper to check if a string is a base64 data URL
const isBase64DataUrl = (str) =>
  /^data:image\/(?:jpeg|png|gif|webp);base64,/.test(str);

class GeminiProvider extends BaseProvider {
  /**
   * Create a new Gemini provider
   */
  constructor(config) {
    super(config);
    this.name = "gemini";

    // Validate API key
    if (!config.apiKey) {
      logger.warn(
        "Gemini API key is missing or set to dummy-key. Using fallback mode with limited functionality."
      );
      this.hasValidApiKey = false;
    } else {
      this.hasValidApiKey = true;
    }

    // Initialize GenAI SDK client
    this.genAI = new GoogleGenAI({
      apiKey: config.apiKey,
      channelOptions: {
        "grpc.keepalive_time_ms": config.grpcKeepaliveTimeMs || 30000,
        "grpc.keepalive_timeout_ms": config.grpcKeepaliveTimeoutMs || 10000,
        "grpc.keepalive_permit_without_calls": 1,
      },
    });

    // Initialize with config models
    this.availableModels = this.config.models || [];
  }

  /**
   * Get available models from Google Generative AI
   */
  async getModels() {
    try {
      const result = await this.genAI.models.list();
      const rawModels = result.models || [];
      return rawModels
        .filter((m) => m.name.startsWith("models/gemini-"))
        .map((raw) => {
          const id = raw.name.replace("models/", "");
          return {
            id,
            name: raw.displayName || id,
            displayName: raw.displayName,
            provider: this.name,
            tokenLimit: raw.outputTokenLimit,
            contextSize: raw.inputTokenLimit,
            description: raw.description || "",
          };
        });
    } catch (error) {
      logger.error(`Gemini getModels error: ${error.message}`);
      // Fallback to simple config models list
      return (this.config.models || []).map((id) => ({
        id,
        name: id,
        provider: this.name,
      }));
    }
  }

  /**
   * Main chat completion method
   */
  async chatCompletion(options) {
    if (!this.hasValidApiKey) {
      return {
        id: `error-${Date.now()}`,
        model: options.model || this.config.defaultModel,
        provider: this.name,
        createdAt: new Date().toISOString(),
        content: "API key is missing or invalid.",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latency: 0,
        finishReason: "error",
        errorDetails: { message: "Missing or invalid API key" },
      };
    }
    try {
      const startTime = Date.now();
      // Use GenAI SDK chat API directly
      const result = await this.genAI.chats.create({
        model: options.model,
        messages: options.messages,
        config: {
          temperature: options.temperature,
          maxOutputTokens: options.max_tokens,
          stopSequences: options.stop,
          thinkingConfig: { thinkingBudget: -1 }
        },
      });
      const latency = Date.now() - startTime;
      // Map result to standardized response
      return {
        id: result.id || `gemini-${Date.now()}`,
        model: options.model,
        provider: this.name,
        createdAt: new Date().toISOString(),
        content: result.choices?.[0]?.message?.content || result.text || "",
        usage: {
          promptTokens: result.promptTokens || 0,
          completionTokens: result.completionTokens || 0,
          totalTokens: result.totalTokens || 0,
        },
        latency,
        finishReason: result.finishReason || "completed",
      };
    } catch (error) {
      logger.error(`Gemini chat error: ${error.message}`);
      return {
        id: `error-${Date.now()}`,
        model: options.model,
        provider: this.name,
        createdAt: new Date().toISOString(),
        content: `Error: ${error.message}`,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latency: 0,
        finishReason: "error",
      };
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

    messages.forEach((message) => {
      // Handle system instruction (only the first one is usually used by Gemini)
      if (message.role === "system" && !systemInstruction) {
        // Gemini expects system instruction as a separate object with a 'parts' array
        if (typeof message.content === "string") {
          systemInstruction = { parts: [{ text: message.content }] };
        } else if (
          Array.isArray(message.content) &&
          message.content.length > 0 &&
          message.content[0].type === "text"
        ) {
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
        message.content.forEach((item) => {
          if (item.type === "text") {
            currentParts.push({ text: item.text });
          } else if (item.type === "image_url" && item.image_url?.url) {
            const url = item.image_url.url;
            if (isBase64DataUrl(url)) {
              const base64Data = url.split(",")[1];
              const mimeType =
                url.match(/^data:(image\/[^;]+);base64,/)?.[1] || "image/jpeg"; // Default to jpeg
              currentParts.push({
                inline_data: {
                  mime_type: mimeType,
                  data: base64Data,
                },
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
      logger.warn(
        "Last message to Gemini is not from 'user'. API might behave unexpectedly."
      );
      // Option: Append empty user message
      // contents.push({ role: 'user', parts: [{ text: '' }] });
    }

    return { contents, systemInstruction };
  }

  /**
   * Send a chat completion request with streaming response using the Google AI SDK.
   * Implements the `chatCompletionStream` method defined in `BaseProvider`.
   * @param {object} options - The request options (model, messages, etc.), standardized.
   * @yields {object} Standardized response chunks compatible with the API format.
   * @throws {Error} If the API key is missing, the API request fails, or the stream encounters an error.
   */
  async *chatCompletionStream(options) {
    if (!this.hasValidApiKey) {
      throw new Error("Gemini provider requires a valid API key for streaming.");
    }
    // Standardize and validate options
    const opts = this.standardizeOptions(options);
    this.validateOptions(opts);

    const startTime = Date.now();
    const modelName = opts.model;

    // Combine messages into single contents array for streaming
    const contents = opts.messages.map(m => ({ parts: [{ text: m.content }] }));

    // Call SDK streaming endpoint
    const stream = await this.genAI.models.generateContentStream({
      model: modelName,
      contents: contents,
      config: {
        temperature: opts.temperature,
        maxOutputTokens: opts.max_tokens,
        stopSequences: opts.stop,
        thinkingConfig: { thinkingBudget: -1 },
        stream: true
      },
      signal: opts.abortSignal
    });

    // Iterate chunks from SDK
    for await (const chunk of stream) {
      const latency = Date.now() - startTime;
      yield this._normalizeStreamChunk(chunk, modelName, latency);
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
          .filter((part) => part.text)
          .map((part) => part.text)
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
        totalTokens: totalTokens,
      },
      latency: latency || 0,
      raw: chunk,
    };
  }
}

export default GeminiProvider;
