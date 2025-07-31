/**
 * @file Implements the Gemini provider for integrating with Google's Generative AI SDK.
 * @version 2.0.0
 */

import { GoogleGenAI } from "@google/genai";
import BaseProvider from "./BaseProvider.js";
import logger from "../utils/logger.js";

/**
 * Checks if a string is a valid base64 data URL.
 * @param {string} str - The string to validate.
 * @returns {boolean} - True if the string is a base64 data URL, false otherwise.
 */
const isBase64DataUrl = (str) =>
  /^data:image\/(?:jpeg|png|gif|webp);base64,/.test(str);

/**
 * Implements the BaseProvider interface for the Google Gemini API.
 */
class GeminiProvider extends BaseProvider {
  /**
   * @param {object} config - The provider configuration.
   */
  constructor(config) {
    super(config);
    this.name = "gemini";
    this.hasValidApiKey = !!config.apiKey;

    if (!this.hasValidApiKey) {
      logger.warn(
        "Gemini API key is missing. Using fallback mode with limited functionality."
      );
    }

    this.genAI = new GoogleGenAI({
      apiKey: config.apiKey,
      channelOptions: {
        "grpc.keepalive_time_ms": config.grpcKeepaliveTimeMs || 30000,
        "grpc.keepalive_timeout_ms": config.grpcKeepaliveTimeoutMs || 10000,
        "grpc.keepalive_permit_without_calls": 1,
      },
    });
  }

  /**
   * Fetches available models from the Gemini API.
   * @returns {Promise<Array<object>>} - A promise that resolves to an array of model objects.
   */
  async getModels() {
    const fallbackModels = (this.config.models || []).map((id) => ({
      id,
      name: id,
      provider: this.name,
    }));

    if (!this.hasValidApiKey || this.config.dynamicModelLoading === false) {
      return fallbackModels;
    }

    try {
      const pager = await this.genAI.models.list();
      let rawModels = [];

      // The SDK may return models in different shapes depending on the version.
      if (pager && Array.isArray(pager.pageInternal)) {
        rawModels = pager.pageInternal;
      } else if (pager && Array.isArray(pager.models)) {
        rawModels = pager.models;
      } else if (pager && typeof pager[Symbol.asyncIterator] === "function") {
        for await (const model of pager) {
          rawModels.push(model);
        }
      } else {
        logger.warn(
          "Unexpected response from GenAI SDK models.list(), falling back to configured models"
        );
        return fallbackModels;
      }

      const dynamicModels = rawModels
        .map((raw) => {
          const parts = raw.name.split("/");
          const id = parts[parts.length - 1];
          return {
            id,
            name: raw.displayName || id,
            displayName: raw.displayName,
            provider: this.name,
            tokenLimit: raw.outputTokenLimit,
            contextSize: raw.inputTokenLimit,
            description: raw.description || "",
          };
        })
        .filter((m) => m.id.startsWith("gemini-"));

      if (dynamicModels.length > 0) {
        return dynamicModels;
      }

      logger.warn(
        "No Gemini models returned from API, falling back to static configured models"
      );
      return fallbackModels;
    } catch (error) {
      logger.error(`Gemini getModels error: ${error.message}`);
      return fallbackModels;
    }
  }

  /**
   * Sends a chat completion request to the Gemini API.
   * @param {object} options - The request options.
   * @returns {Promise<object>} - A promise that resolves to the standardized API response.
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
      const opts = this.standardizeOptions(options);
      this.validateOptions(opts);
      const { contents, systemInstruction } = this._processMessages(
        opts.messages
      );

      const result = await this.genAI.models.generateContent({
        model: opts.model,
        contents: contents,
        systemInstruction: systemInstruction,
        generationConfig: {
          temperature: opts.temperature,
          maxOutputTokens: opts.max_tokens,
          stopSequences: opts.stop,
        },
        safetySettings: [],
        tools: [],
        toolConfig: {},
        cachedContent: "",
        thinkingConfig: {
          thinkingBudget: -1,
        },
      });

      const latency = Date.now() - startTime;
      const response = result.response;
      const choice = response.candidates?.[0];
      const usage = response.usageMetadata || {};

      return {
        id: `gemini-${Date.now()}`,
        model: opts.model,
        provider: this.name,
        createdAt: new Date().toISOString(),
        content: choice?.content?.parts?.map((p) => p.text).join("") || "",
        usage: {
          promptTokens: usage.promptTokenCount || 0,
          completionTokens: usage.candidatesTokenCount || 0,
          totalTokens: usage.totalTokenCount || 0,
        },
        latency,
        finishReason: choice?.finishReason || "unknown",
        raw: response,
      };
    } catch (error) {
      logger.error(`Gemini chat error: ${error.message}`, {
        errorName: error.name,
        stack: error.stack,
      });
      return {
        id: `error-${Date.now()}`,
        model: options.model,
        provider: this.name,
        createdAt: new Date().toISOString(),
        content: `Error: ${error.message}`,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latency: 0,
        finishReason: "error",
        errorDetails: { message: error.message, name: error.name },
      };
    }
  }

  /**
   * Processes an array of messages into a format suitable for the Gemini API,
   * separating the system prompt from the conversational history.
   *
   * @param {Array<object>} messages - The array of message objects.
   * @returns {{contents: Array<object>, systemInstruction: object|undefined}}
   */
  _processMessages(messages) {
    let systemInstruction;
    const contents = [];

    for (const message of messages) {
      if (message.role === "system" && !systemInstruction) {
        if (typeof message.content === "string") {
          systemInstruction = { parts: [{ text: message.content }] };
        } else if (
          Array.isArray(message.content) &&
          message.content.length > 0 &&
          message.content[0].type === "text"
        ) {
          systemInstruction = { parts: [{ text: message.content[0].text }] };
        }
        continue;
      }

      const role = message.role === "assistant" ? "model" : "user";
      const parts = [];

      if (typeof message.content === "string") {
        if (message.content) {
          parts.push({ text: message.content });
        }
      } else if (Array.isArray(message.content)) {
        for (const item of message.content) {
          if (item.type === "text" && item.text) {
            parts.push({ text: item.text });
          } else if (item.type === "image_url" && item.image_url?.url) {
            const url = item.image_url.url;
            if (isBase64DataUrl(url)) {
              const base64Data = url.split(",")[1];
              const mimeType =
                url.match(/^data:(image\/[^;]+);base64,/)?.[1] || "image/jpeg";
              parts.push({ inlineData: { mimeType, data: base64Data } });
            } else {
              logger.warn(`Skipping non-base64 image URL for Gemini: ${url}`);
            }
          }
        }
      }

      if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }

    return { contents, systemInstruction };
  }

  /**
   * Sends a chat completion request with a streaming response.
   * @param {object} options - The request options.
   * @yields {object} - Standardized response chunks.
   */
  async *chatCompletionStream(options) {
    if (!this.hasValidApiKey) {
      throw new Error("Gemini provider requires a valid API key for streaming.");
    }
    const opts = this.standardizeOptions(options);
    this.validateOptions(opts);

    const startTime = Date.now();
    const modelName = opts.model;
    const { contents, systemInstruction } = this._processMessages(
      opts.messages
    );

    const stream = await this.genAI.models.generateContentStream({
      model: modelName,
      contents: contents,
      generationConfig: {
        temperature: opts.temperature,
        maxOutputTokens: opts.max_tokens,
        stopSequences: opts.stop,
      },
      thinkingConfig: {
        thinkingBudget: -1,
      },
      systemInstruction: systemInstruction,
      signal: opts.abortSignal,
    });

    for await (const chunk of stream) {
      const latency = Date.now() - startTime;
      yield this._normalizeStreamChunk(chunk, modelName, latency);
    }
  }

  /**
   * Normalizes a streaming chunk from the Gemini API.
   * @param {object} chunk - The raw chunk from the API.
   * @param {string} model - The model name.
   * @param {number} latency - The request latency.
   * @returns {object} - A standardized chunk object.
   */
  _normalizeStreamChunk(chunk, model, latency) {
    let content = "";
    // Use a for...of loop for efficient iteration without intermediate arrays.
    if (chunk.candidates?.[0]?.content?.parts) {
      for (const part of chunk.candidates[0].content.parts) {
        if (part.text) {
          content += part.text;
        }
      }
    }

    const finishReason = chunk.candidates?.[0]?.finishReason || null;
    const usageMetadata = chunk.usageMetadata || {};
    const {
      promptTokenCount = 0,
      candidatesTokenCount = 0,
      totalTokenCount = 0,
    } = usageMetadata;

    return {
      id: `chunk-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`,
      model: model,
      provider: this.name,
      createdAt: new Date().toISOString(),
      content: content,
      finishReason: finishReason,
      usage: {
        promptTokens: promptTokenCount,
        completionTokens: candidatesTokenCount,
        totalTokens: totalTokenCount,
      },
      latency: latency || 0,
      raw: chunk,
    };
  }
}

export default GeminiProvider;
