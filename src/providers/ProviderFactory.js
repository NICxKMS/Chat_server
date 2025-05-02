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
    try {
      // Initialize provider instances
      this.providers = this._initializeProviders();
      
      // Find a valid default provider
      const availableProviders = Object.keys(this.providers);
      if (availableProviders.includes("openai")) {
        this.defaultProvider = "openai";
      } else if (availableProviders.includes("anthropic")) {
        this.defaultProvider = "anthropic";
      } else if (availableProviders.includes("gemini")) {
        this.defaultProvider = "gemini";
      } else if (availableProviders.includes("openrouter")) {
        this.defaultProvider = "openrouter";
      } else {
        this.defaultProvider = availableProviders[0] || "none";
        logger.warn(`No primary providers found, using ${this.defaultProvider} as default`);
      }
      
    } catch (error) {
      logger.error("Error initializing provider factory:", error);
      // Initialize with empty providers if there's an error
      this.providers = { 
        none: {
          name: "none",
          getModels: async () => [],
          config: { defaultModel: "none" }
        }
      };
      this.defaultProvider = "none";
    }
  }
  
  /**
   * Get a provider by name
   */
  getProvider(providerName) {
    const name = providerName || this.defaultProvider;
    
    if (!this.providers[name]) {
      throw new Error(`Provider ${name} not found or not initialized`);
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
        if (!this.providers[providerName]) {
          return {
            [providerName]: {
              models: [],
              error: `Provider ${providerName} not found or not initialized`
            }
          };
        }
        
        // Get info for the specified provider
        try {
          const provider = this.providers[providerName];
          const models = await provider.getModels();
          
          results[providerName] = {
            models: models,
            defaultModel: provider.config.defaultModel
          };
        } catch (error) {
          results[providerName] = {
            models: [],
            error: `Failed to get models for ${providerName}: ${error.message}`
          };
        }
        
        return results;
      }
      
      // Get info for all providers
      const providerInfoPromises = Object.entries(this.providers).map(async ([name, provider]) => {
        try {
          const models = await provider.getModels();
          
          results[name] = {
            models: models,
            defaultModel: provider.config.defaultModel
          };
        } catch (error) {
          results[name] = {
            models: [],
            error: `Failed to get models for ${name}: ${error.message}`
          };
        }
      });
      
      await Promise.all(providerInfoPromises);
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
  
  /**
   * Initialize provider instances
   */
  _initializeProviders() {
    try {
      // Get config values
      const openaiConfig = config.providers.openai || {};
      const anthropicConfig = config.providers.anthropic || {};
      const geminiConfig = config.providers.gemini || {};
      const openrouterConfig = config.providers.openrouter || {};

      // Initialize provider object
      const providers = {};

      // Only initialize providers with valid API keys
      if (openaiConfig.apiKey) {
        providers.openai = new OpenAIProvider({
          apiKey: openaiConfig.apiKey,
          baseUrl: openaiConfig.baseUrl,
          defaultModel: openaiConfig.defaultModel,
          ...openaiConfig
        });
      }

      if (anthropicConfig.apiKey) {
        providers.anthropic = new AnthropicProvider({
          apiKey: anthropicConfig.apiKey,
          baseUrl: anthropicConfig.baseUrl || "https://api.anthropic.com",
          defaultModel: anthropicConfig.defaultModel || "claude-3-opus-20240229",
          modelFamily: "claude",
          ...anthropicConfig
        });
      }

      if (geminiConfig.apiKey) {
        providers.gemini = new GeminiProvider({
          apiKey: geminiConfig.apiKey,
          baseUrl: geminiConfig.baseUrl,
          defaultModel: geminiConfig.defaultModel,
          ...geminiConfig
        });
      }

      if (openrouterConfig.apiKey) {
        providers.openrouter = new OpenRouterProvider({
          apiKey: openrouterConfig.apiKey,
          baseUrl: openrouterConfig.baseUrl,
          defaultModel: openrouterConfig.defaultModel,
          ...openrouterConfig
        });
      }

      if (Object.keys(providers).length === 0) {
        logger.warn("No providers were initialized due to missing API keys");
        providers.none = {
          name: "none",
          getModels: async () => [],
          config: { defaultModel: "none" }
        };
      }

      return providers;
    } catch (error) {
      logger.error("Error initializing providers:", error);
      throw error;
    }
  }
}

// Create and export singleton instance
const factory = new ProviderFactory();
export default factory; 