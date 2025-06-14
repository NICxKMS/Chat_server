/**
 * Provider Factory
 * Creates and initializes provider instances based on configuration
 */
import OpenAIProvider from "./OpenAIProvider.js";
import { AnthropicProvider } from "./AnthropicProvider.js";
import GeminiProvider from "./GeminiProvider.js";
import OpenRouterProvider from "./OpenRouterProvider.js";
import config from "../config/config.js";
import logger from "../utils/logger.js";

/**
 * Provider Factory Class
 * Creates and manages provider instances
 */
class ProviderFactory {
  /**
   * Initialize the provider factory
   */
  constructor() {
    // Store raw configs for lazy instantiation
    this.configs = {
      openai: config.providers.openai || {},
      anthropic: config.providers.anthropic || {},
      gemini: config.providers.gemini || {},
      openrouter: config.providers.openrouter || {}
    };
    this.providers = {}; // Instance cache
    // Determine available provider names by API key presence
    const available = Object.entries(this.configs)
      .filter(([, cfg]) => cfg.apiKey)
      .map(([name]) => name);
    // Select default by priority
    if (available.includes("openai")) this.defaultProvider = "openai";
    else if (available.includes("anthropic")) this.defaultProvider = "anthropic";
    else if (available.includes("gemini")) this.defaultProvider = "gemini";
    else if (available.includes("openrouter")) this.defaultProvider = "openrouter";
    else this.defaultProvider = available[0] || "none";
    // Eagerly instantiate all configured providers
    available.forEach(name => this._instantiateProvider(name));
    // Ensure a fallback 'none' provider exists if no providers initialized
    if (Object.keys(this.providers).length === 0) {
      this._instantiateProvider("none");
    }
  }

  // Lazily instantiate providers on first use
  _instantiateProvider(name) {
    const cfg = this.configs[name] || {};
    switch (name) {
      case "openai":
        this.providers.openai = new OpenAIProvider({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, defaultModel: cfg.defaultModel, ...cfg });
        break;
      case "anthropic":
        this.providers.anthropic = new AnthropicProvider({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl || "https://api.anthropic.com", defaultModel: cfg.defaultModel, modelFamily: "claude", ...cfg });
        break;
      case "gemini":
        this.providers.gemini = new GeminiProvider({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, defaultModel: cfg.defaultModel, ...cfg });
        break;
      case "openrouter":
        this.providers.openrouter = new OpenRouterProvider({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, defaultModel: cfg.defaultModel, ...cfg });
        break;
      case "none":
      default:
        this.providers.none = { name: "none", getModels: async () => [], config: { defaultModel: "none" } };
    }
  }

  /**
   * Get or create a provider instance by name
   */
  getProvider(providerName) {
    const name = providerName || this.defaultProvider;
    if (!this.providers[name]) {
      if (this.configs[name]?.apiKey || name === "none") {
        this._instantiateProvider(name);
      } else {
        throw new Error(`Provider ${name} not found or not initialized`);
      }
    }
    return this.providers[name];
  }

  /**
   * Get info for all providers or a specific provider
   */
  async getProvidersInfo(providerName) {
    try {
      const results = {};

      // If provider name is specified, return info for that provider only
      if (providerName) {
        try {
          const provider = this.getProvider(providerName);
          const models = await provider.getModels();
          return { [providerName]: { models, defaultModel: provider.config.defaultModel } };
        } catch (error) {
          return { [providerName]: { models: [], error: `Failed to get models for ${providerName}: ${error.message}` } };
        }
      }

      // Get info for all configured providers
      const providerNames = Object.keys(this.configs).filter(name => this.configs[name]?.apiKey);
      const infoPromises = providerNames.map(async name => {
        try {
          const provider = this.getProvider(name);
          const models = await provider.getModels();
          results[name] = { models, defaultModel: provider.config.defaultModel };
        } catch (error) {
          results[name] = { models: [], error: `Failed to get models for ${name}: ${error.message}` };
        }
      });
      await Promise.all(infoPromises);

      return results;
      
    } catch (error) {
      return {
        error: {
          models: [],
          error: `Failed to get provider info: ${error.message}`
        }
      };
    }
  }

  /**
   * Get all available providers
   */
  getProviders() {
    return { ...this.providers };
  }

  /**
   * Check if a provider is available
   */
  hasProvider(providerName) {
    return !!this.providers[providerName];
  }
}

// Create and export singleton instance
const factory = new ProviderFactory();
export default factory; 