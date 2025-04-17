/**
 * Model Controller
 * Handles all model-related API endpoints
 */
import providerFactory from "../providers/ProviderFactory.js";
import * as cache from "../utils/cache.js";
import * as metrics from "../utils/metrics.js";
import { ModelClassificationService } from "../services/ModelClassificationService.js";
import { getCircuitBreakerStates, createBreaker } from "../utils/circuitBreaker.js";
import protoUtils from "../utils/protoUtils.js";
import logger from "../utils/logger.js";
import { applyCaching } from "./ModelControllerCache.js";

class ModelController {
  constructor() {
    // Bind methods (consider if still necessary with Fastify style)
    this.getAllModels = this.getAllModels.bind(this);
    this.getProviderModels = this.getProviderModels.bind(this);
    this.getProviderCapabilities = this.getProviderCapabilities.bind(this);
    this.getCategorizedModels = this.getCategorizedModels.bind(this);
    this.getClassifiedModels = this.getClassifiedModels.bind(this);
    this.getClassifiedModelsWithCriteria = this.getClassifiedModelsWithCriteria.bind(this);
    this.getProviders = this.getProviders.bind(this);

    // Initialize classification service if enabled
    this.useClassificationService = process.env.USE_CLASSIFICATION_SERVICE !== 'false';
    
    if (this.useClassificationService) {
      const serverAddress = `${process.env.CLASSIFICATION_SERVER_HOST || 'localhost'}:${process.env.CLASSIFICATION_SERVER_PORT || '8080'}`;
      this.modelClassificationService = new ModelClassificationService(serverAddress);
      
      // Create circuit breakers for classification service calls
      this.classifyBreaker = createBreaker('classification-classify', 
        (providersInfo) => this.modelClassificationService.getClassifiedModels(providersInfo), 
        { failureThreshold: 3, resetTimeout: 30000 } // Example options
      );
      this.criteriaBreaker = createBreaker('classification-criteria', 
        (criteria) => this.modelClassificationService.getModelsByCriteria(criteria),
        { failureThreshold: 3, resetTimeout: 30000 } // Example options
      );
      
    } else {
      this.modelClassificationService = null;
    }
    
    logger.info("ModelController initialized");
  }

  /**
   * Get all available models grouped by provider, along with default settings.
   * Fetches info from all configured providers.
   * @param {FastifyRequest} request - Fastify request object.
   * @param {FastifyReply} reply - Fastify reply object.
   */
  async getAllModels(request, reply) {
    try {
      // Record request in metrics
      metrics.incrementRequestCount();
      
      // Get models from all providers using the factory
      const providersInfo = await providerFactory.getProvidersInfo();
      const modelsByProvider = {};
      
      for (const [provider, info] of Object.entries(providersInfo)) {
        if (info && typeof info === "object" && "models" in info && Array.isArray(info.models)) {
          modelsByProvider[provider] = {
            models: info.models.map(model => typeof model === "string" ? model : model.id),
            defaultModel: info.defaultModel
          };
        }
      }
      
      // Safely access config properties
      const defaultProvider = providerFactory.getProvider();
      const defaultModel = defaultProvider && 
        typeof defaultProvider.config === "object" ? 
        defaultProvider.config.defaultModel : undefined;
      
      // Return formatted response
      return reply.send({
        models: modelsByProvider,
        providers: Object.keys(providerFactory.getProviders()),
        default: {
          provider: defaultProvider.name,
          model: defaultModel
        }
      });
    } catch (error) {
      logger.error(`Error getting models: ${error.message}`, { stack: error.stack });
      // Let Fastify's default error handler (or our custom one later) handle it
      throw error;
      // reply.status(500).send({ 
      //   error: "Failed to get models", 
      //   message: error.message 
      // });
    }
  }

  /**
   * Get models for a specific provider, handling special cases like 'categories'.
   * @param {FastifyRequest} request - Fastify request object.
   * @param {FastifyReply} reply - Fastify reply object.
   */
  async getProviderModels(request, reply) {
    try {
      // Record request in metrics
      metrics.incrementRequestCount();
      
      const { providerName } = request.params; // Use request.params
      
      if (!providerName) {
        // Return error response directly
        return reply.status(400).send({ 
          error: "Provider name is required" 
        });
      }
      
      // Special handling for paths used by other routes (Fastify handles route precedence)
      // No need for the explicit check here like in the Express version
      // if (providerName === "categories" || providerName === "categorized") { ... }
      
      try {
        // Get provider from factory
        const provider = providerFactory.getProvider(providerName);
        
        // Get models from provider
        const models = await provider.getModels();
        
        // Safely access config properties
        const defaultModel = typeof provider.config === "object" ? 
          provider.config.defaultModel : undefined;
          
        // Return formatted response
        return reply.send({
          provider: providerName,
          models: models,
          defaultModel: defaultModel
        });
      } catch (error) {
        // Handle provider not found specifically
        logger.warn(`Provider not found: ${providerName}`, { message: error.message });
        // Return 404 directly
        return reply.status(404).send({ 
          error: `Provider '${providerName}' not found or not configured`,
          message: error.message
        });
      }
    } catch (error) {
      logger.error(`Error getting provider models: ${error.message}`, { providerName: request.params?.providerName, stack: error.stack });
      // Let Fastify's error handler handle it
      throw error;
      // reply.status(500).send({ 
      //   error: "Failed to get provider models", 
      //   message: error.message 
      // });
    }
  }

  /**
   * Get detailed capabilities information for all configured providers.
   * @param {FastifyRequest} request - Fastify request object.
   * @param {FastifyReply} reply - Fastify reply object.
   */
  async getProviderCapabilities(request, reply) {
    try {
      // Record request in metrics
      metrics.incrementRequestCount();
      
      // Get all provider info
      const providersInfo = await providerFactory.getProvidersInfo();
      
      return reply.send({
        providers: providersInfo,
        defaultProvider: providerFactory.getProvider().name
      });
    } catch (error) {
      logger.error(`Error getting provider capabilities: ${error.message}`, { stack: error.stack });
      // Let Fastify's error handler handle it
      throw error;
      // reply.status(500).send({ 
      //   error: "Failed to get provider capabilities", 
      //   message: error.message 
      // });
    }
  }

  /**
   * Get categorized models, either via the classification service or a hardcoded fallback.
   * Used by the `/models/categories` and `/models/categorized` endpoints.
   * @param {FastifyRequest} request - Fastify request object.
   * @param {FastifyReply} reply - Fastify reply object.
   */
  async getCategorizedModels(request, reply) {
    try {
      // Record request in metrics
      metrics.incrementRequestCount();
      
      // Check if classification service is enabled and available
      if (this.useClassificationService && this.modelClassificationService) {
        // If enabled, delegate to the classification service method
        // Ensure the delegated method also uses (request, reply) and throws errors
        return await this.getClassifiedModels(request, reply); // Assuming getClassifiedModels is adapted
      }
      
      // Fallback: If classification service is not available, return hardcoded sample data.
      logger.warn("Classification service disabled or unavailable, returning hardcoded sample categories.");
      const categories = [
        {
          name: "Latest & Greatest",
          providers: [
            {
              name: "openai",
              models: [
                { name: "gpt-4o", isExperimental: false },
                { name: "gpt-4-turbo", isExperimental: false },
                { name: "gpt-4", isExperimental: false }
              ]
            },
            {
              name: "anthropic",
              models: [
                { name: "claude-3-opus", isExperimental: false },
                { name: "claude-3-sonnet", isExperimental: false },
                { name: "claude-3-haiku", isExperimental: false }
              ]
            },
            {
              name: "google",
              models: [
                { name: "gemini-1.5-pro", isExperimental: false },
                { name: "gemini-1.5-flash", isExperimental: false },
                { name: "gemini-1.0-pro", isExperimental: false }
              ]
            }
          ]
        }
      ];
      
      return reply.send(categories);

    } catch (error) {
      logger.error(`Error getting categorized models: ${error.message}`, { stack: error.stack });
      throw error;
      // reply.status(500).send({ 
      //   error: "Failed to get categorized models", 
      //   message: error.message 
      // });
    }
  }
  
  /**
   * Get available providers and their capabilities
   * @param {FastifyRequest} request - Fastify request object.
   * @param {FastifyReply} reply - Fastify reply object.
   */
  async getProviders(request, reply) {
    try {
      const providers = await providerFactory.getProvidersInfo();
      return reply.send(providers); // Explicitly return reply.send()
    } catch (error) {
      logger.error(`Error getting providers: ${error.message}`, { stack: error.stack });
      // Let Fastify's error handler handle it
      throw error;
      // No explicit return needed here as error is thrown
    }
  }

  /**
   * Internal logic to fetch classified models using the classification service.
   * Does not handle HTTP reply directly. Throws errors on failure.
   * @returns {Promise<Object>} Classified models data
   * @private
   */
  async _fetchClassifiedModels() {
    // Ensure service is enabled and initialized
    if (!this.useClassificationService || !this.modelClassificationService) {
      logger.warn("Attempted to fetch classified models when service is disabled/unavailable.");
      // Throw an error that can be caught by the caller
      throw new Error("Model classification service is not enabled.");
    }

    // Use cached results if available (applyCaching handles the fetch logic)
    const cacheKey = "classifiedModels";
    const classifiedData = await applyCaching(cacheKey, async () => {
        // Fetch fresh provider info
        const providersInfo = await providerFactory.getProvidersInfo();
        
        // Call the classification service via the circuit breaker
        logger.debug("Calling classification service via circuit breaker...");
        // Note: .fire() will throw BreakerOpenError if breaker is open
        const classifiedModels = await this.classifyBreaker.fire(providersInfo); 
        logger.debug("Classification service call successful.");
        
        // Assuming the service returns a usable format
        return classifiedModels; 
    });
    
    return classifiedData; // Return fetched or cached data
  }


  /**
   * GET /models/classified - Route handler for getting classified models.
   * @param {FastifyRequest} request - Fastify request object.
   * @param {FastifyReply} reply - Fastify reply object.
   */
  async getClassifiedModels(request, reply) {
    try {
      metrics.incrementRequestCount();
      
      // Call the internal fetch logic
      const classifiedData = await this._fetchClassifiedModels();
      
      // Send successful response
      return reply.send(classifiedData); 
      
    } catch (error) {
      // Log error with context
      logger.error(`Error in getClassifiedModels handler: ${error.message}`, { 
          stack: error.stack, 
          // Check breaker state if the breaker exists
          breaker_state: this.classifyBreaker?.state 
      });
      
      // Determine status code based on error type
      let statusCode = 500;
      let errorMessage = "Failed to get classified models.";
      if (error.message === "Model classification service is not enabled.") {
          statusCode = 501; // Not Implemented
          errorMessage = error.message;
      } else if (error.name === 'BreakerOpenError') {
          statusCode = 503; // Service Unavailable
          errorMessage = "Model classification service is temporarily unavailable. Please try again later.";
      } else {
          statusCode = 502; // Bad Gateway (upstream error)
          errorMessage = "Failed to get classified models from the upstream service.";
      }
        
      // Send error response using reply
      return reply.status(statusCode).send({ error: errorMessage, message: error.message });
    }
  }
  
  /**
   * Internal logic to fetch classified models based on criteria.
   * Does not handle HTTP reply directly. Throws errors on failure.
   * @param {Object} criteria - The classification criteria.
   * @returns {Promise<Object>} Classified models data.
   * @private
   */
  async _fetchClassifiedModelsWithCriteria(criteria) {
    // Ensure service is enabled and initialized
    if (!this.useClassificationService || !this.modelClassificationService) {
      logger.warn("Attempted to fetch classified models with criteria when service is disabled/unavailable.");
      throw new Error("Model classification service is not enabled.");
    }

    // Basic validation of criteria (can be expanded)
    if (!criteria || typeof criteria !== 'object' || Object.keys(criteria).length === 0) {
      // Throw a specific validation error
      const validationError = new Error("Missing or invalid classification criteria.");
      validationError.name = 'ValidationError'; // For potential mapping in error handler
      throw validationError; 
    }

    // Use caching based on criteria
    const cacheKey = `classifiedModelsCriteria:${JSON.stringify(criteria)}`;
    const classifiedData = await applyCaching(cacheKey, async () => {
        // Call the classification service via the circuit breaker
        logger.debug("Calling classification service (criteria) via circuit breaker...");
        const classifiedModels = await this.criteriaBreaker.fire(criteria);
        logger.debug("Classification service call (criteria) successful.");
        // Assuming the service returns a usable format
        return classifiedModels; 
    });

    return classifiedData;
  }


  /**
   * POST /models/classified/criteria - Route handler for getting classified models by criteria.
   * @param {FastifyRequest} request - Fastify request object.
   * @param {FastifyReply} reply - Fastify reply object.
   */
  async getClassifiedModelsWithCriteria(request, reply) {
    try {
      metrics.incrementRequestCount();
      const criteria = request.body; // Assuming criteria are in the request body

      // Call the internal fetch logic with criteria
      const classifiedData = await this._fetchClassifiedModelsWithCriteria(criteria);

      // Send successful response
      return reply.send(classifiedData);

    } catch (error) {
      // Log error with context
      logger.error(`Error in getClassifiedModelsWithCriteria handler: ${error.message}`, { 
          stack: error.stack, 
          criteria: request.body, 
          breaker_state: this.criteriaBreaker?.state 
      });
      
      // Determine status code based on error type
      let statusCode = 500;
      let errorMessage = "Failed to get classified models by criteria.";
      if (error.message === "Model classification service is not enabled.") {
          statusCode = 501; // Not Implemented
          errorMessage = error.message;
      } else if (error.name === 'ValidationError') { // Handle validation error from internal method
          statusCode = 400; // Bad Request
          errorMessage = error.message; 
      } else if (error.name === 'BreakerOpenError') {
          statusCode = 503; // Service Unavailable
          errorMessage = "Model classification service is temporarily unavailable. Please try again later.";
      } else {
          statusCode = 502; // Bad Gateway (upstream error)
          errorMessage = "Failed to get classified models by criteria from the upstream service.";
      }

      // Send error response using reply
      return reply.status(statusCode).send({ error: errorMessage, message: error.message });
    }
  }
}

// Create singleton instance
const controller = new ModelController();

// Apply caching if Firestore cache is available
export default applyCaching(controller); 