/**
 * Model Controller
 * Handles all model-related API endpoints
 */
import providerFactory from "../providers/ProviderFactory.js";
import * as cache from "../utils/cache.js";
import * as metrics from "../utils/metrics.js";
import { ModelClassificationService } from "../services/ModelClassificationService.js";
import { createBreaker } from "../utils/circuitBreaker.js";
import logger from "../utils/logger.js";
import { applyCaching } from "./ModelControllerCache.js";
import firestoreCacheService from "../services/FirestoreCacheService.js";

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
    this.useClassificationService = process.env.USE_CLASSIFICATION_SERVICE !== "false";
    
    if (this.useClassificationService) {
      const serverAddress = `${process.env.CLASSIFICATION_SERVER_HOST || "localhost"}:${process.env.CLASSIFICATION_SERVER_PORT || "8080"}`;
      this.modelClassificationService = new ModelClassificationService(serverAddress);
      
      // Create circuit breakers for classification service calls
      this.classifyBreaker = createBreaker("classification-classify", 
        (providersInfo) => this.modelClassificationService.getClassifiedModels(providersInfo), 
        { failureThreshold: 3, resetTimeout: 30000 } // Example options
      );
      this.criteriaBreaker = createBreaker("classification-criteria", 
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
   * Get classified models from the external gRPC service.
   * @param {FastifyRequest} request - Fastify request object.
   * @param {FastifyReply} reply - Fastify reply object.
   */
  async getClassifiedModels(request, reply) {
    // Ensure service is enabled and initialized
    if (!this.useClassificationService || !this.modelClassificationService) {
      logger.warn("Attempted to call getClassifiedModels when service is disabled/unavailable.");
      // Return fallback or error. For now, return 501 Not Implemented
      return reply.status(501).send({ error: "Model classification service is not enabled." });
    }
    
    try {
      metrics.incrementRequestCount();
      
      // Use cached results if available
      const cacheKey = "classifiedModels";
      const cachedData = await cache.getOrSet(cacheKey, async () => {
        // Fetch fresh provider info (or use cached if appropriate elsewhere)
        const providersInfo = await providerFactory.getProvidersInfo();
          
        // Call the classification service via the circuit breaker
        logger.debug("Calling classification service via circuit breaker...");
        const classifiedModels = await this.classifyBreaker.fire(providersInfo);
        logger.debug("Classification service call successful.");
          
        // Convert proto response to standard JS objects if necessary (assuming service returns proto)
        // This depends on the service implementation. If it already converts, this is not needed.
        // Example: return convertProtoResponse(classifiedModels);
        return classifiedModels; // Assuming the service returns a usable format
      });
      
      return reply.send(cachedData); // Send cached or freshly fetched data
      
    } catch (error) {
      logger.error(`Error getting classified models: ${error.message}`, { 
        stack: error.stack, 
        breaker_state: this.classifyBreaker?.state 
      });
      
      // Check if it's a circuit breaker error
      if (error.name === "BreakerOpenError") {
        return reply.status(503).send({ error: "Model classification service is temporarily unavailable. Please try again later." });
      } else {
        // Other errors (timeout from gRPC, internal service error, etc.)
        return reply.status(502).send({ error: "Failed to get classified models from the upstream service.", message: error.message });
      }
    }
  }
  
  /**
   * Get classified models based on specific criteria.
   * @param {FastifyRequest} request - Fastify request object.
   * @param {FastifyReply} reply - Fastify reply object.
   */
  async getClassifiedModelsWithCriteria(request, reply) {
    // Ensure service is enabled and initialized
    if (!this.useClassificationService || !this.modelClassificationService) {
      logger.warn("Attempted to call getClassifiedModelsWithCriteria when service is disabled/unavailable.");
      return reply.status(501).send({ error: "Model classification service is not enabled." });
    }

    try {
      metrics.incrementRequestCount();
      const criteria = request.body; // Assuming criteria are in the request body

      if (!criteria || typeof criteria !== "object" || Object.keys(criteria).length === 0) {
        return reply.status(400).send({ error: "Missing or invalid classification criteria in request body." });
      }

      // Use caching based on criteria
      const cacheKey = `classifiedModelsCriteria:${JSON.stringify(criteria)}`;
      const cachedData = await cache.getOrSet(cacheKey, async () => {
        // Call the classification service via the circuit breaker
        logger.debug("Calling classification service (criteria) via circuit breaker...");
        const classifiedModels = await this.criteriaBreaker.fire(criteria);
        logger.debug("Classification service call (criteria) successful.");
        // Assuming the service returns a usable format
        return classifiedModels; 
      });

      return reply.send(cachedData);

    } catch (error) {
      logger.error(`Error getting classified models with criteria: ${error.message}`, { 
        stack: error.stack, 
        criteria: request.body, 
        breaker_state: this.criteriaBreaker?.state 
      });
      
      // Check if it's a circuit breaker error
      if (error.name === "BreakerOpenError") {
        return reply.status(503).send({ error: "Model classification service is temporarily unavailable. Please try again later." });
      } else {
        // Other errors
        return reply.status(502).send({ error: "Failed to get classified models by criteria from the upstream service.", message: error.message });
      }
    }
  }
}

// Create singleton instance
const controller = new ModelController();

// Apply Firestore caching only if enabled, otherwise use regular controller
export default firestoreCacheService.isEnabled() ? 
  applyCaching(controller) : 
  controller; 