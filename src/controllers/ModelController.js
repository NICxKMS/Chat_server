/**
 * Model Controller
 * Handles all model-related API endpoints
 */
import providerFactory from "../providers/ProviderFactory.js";
import * as cache from "../utils/cache.js";
import * as metrics from "../utils/metrics.js";
import { ModelClassificationService } from "../services/ModelClassificationService.js";
import { getCircuitBreakerStates } from "../utils/circuitBreaker.js";
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
    if (!this.useClassificationService || !this.modelClassificationService) {
      logger.warn("getClassifiedModels called but service disabled/unavailable.");
      // Service disabled is not necessarily an error, return empty list or fallback?
      // For now, returning 503 seems consistent with gRPC unavailability
      return reply.status(503).send({ 
          error: "Classification service unavailable", 
          message: "The model classification service is currently disabled or unavailable."
      });
    }

    try {
      metrics.incrementRequestCount();

      // --- Start Critical Section --- 
      let classifiedModels;
      try {
          // Fetch provider info first
          logger.info("Fetching provider info for classification service...");
          const providersInfo = await providerFactory.getProvidersInfo();
          logger.info("Provider info fetched.");
          
          // Check if providersInfo is valid before proceeding
          if (!providersInfo || Object.keys(providersInfo).length === 0) {
            logger.warn("No provider info available to send to classification service.");
            // Decide what to return: empty result or error?
            // Returning an empty valid response might be appropriate
            return reply.send({ hierarchical_groups: [], available_properties: [], timestamp: new Date().toISOString() }); 
          }

          logger.info("Calling GetClassifiedModels gRPC service with provider info");
          // Pass providersInfo to the service method
          classifiedModels = await this.modelClassificationService.getClassifiedModels(providersInfo);
          logger.info("Received response from GetClassifiedModels gRPC service");
      } catch (internalError) {
          // Catch errors specifically from the service call/data prep
          logger.error(`Internal error during getClassifiedModels service call: ${internalError.message}`, { stack: internalError.stack });
          // Throw a new error or the original to be caught by the outer handler
          // Throwing ensures it goes to the centralized Fastify error handler
          throw new Error(`Internal classification service error: ${internalError.message}`);
      }
      // --- End Critical Section --- 

      // Explicitly return the reply object after sending
      return reply.send(classifiedModels);

    } catch (error) {
      // This outer catch handles:
      // 1. Errors thrown from the inner try/catch (e.g., internalError)
      // 2. Specific gRPC communication errors (like UNAVAILABLE)
      // 3. Any other unexpected errors in this handler
      
      // Log appropriately (already done by the handler)
      // logger.error(`Error in getClassifiedModels handler: ${error.message}`, { stack: error.stack });

      // Specific handling for gRPC UNAVAILABLE error
      if (error.code === 14 /* grpc.status.UNAVAILABLE */) {
          logger.error(`gRPC service unavailable: ${error.message}`, { stack: error.stack });
          return reply.status(503).send({ 
              error: "Classification service unavailable",
              message: `Failed to connect to classification service: ${error.details || error.message}`
          });
      }
      
      // For any other errors (including the re-thrown internalError), let the centralized handler deal with it.
      // The centralized handler will log it and return a 500 (or mapped status).
      throw error; 
    }
  }
  
  /**
   * Get classified models from the external gRPC service with criteria.
   * @param {FastifyRequest} request - Fastify request object.
   * @param {FastifyReply} reply - Fastify reply object.
   */
  async getClassifiedModelsWithCriteria(request, reply) {
      if (!this.useClassificationService || !this.modelClassificationService) {
          logger.warn("getClassifiedModelsWithCriteria called but service disabled/unavailable.");
          return reply.status(503).send({ 
              error: "Classification service unavailable", 
              message: "The model classification service is currently disabled or unavailable."
          });
      }
  
      try {
          // Record request in metrics
          metrics.incrementRequestCount();
  
          // Extract criteria from query parameters (Fastify: request.query)
          const criteria = request.query || {}; 
          logger.info("Calling GetClassifiedModelsWithCriteria gRPC service with criteria:", criteria);
  
          // Call the gRPC service with criteria
          const classifiedModels = await this.modelClassificationService.getClassifiedModelsWithCriteria(criteria);
          logger.info("Received response from GetClassifiedModelsWithCriteria gRPC service");
  
          return reply.send(classifiedModels);
  
      } catch (error) {
          logger.error(`Error getting classified models with criteria from gRPC service: ${error.message}`, { criteria: request.query, stack: error.stack });
          // Add specific error handling for gRPC errors
          if (error.code === 14 /* UNAVAILABLE */) {
              return reply.status(503).send({ 
                  error: "Classification service unavailable",
                  message: `Failed to connect to classification service: ${error.details || error.message}`
              });
          } else if (error.code === 3 /* INVALID_ARGUMENT */) {
            return reply.status(400).send({ 
                error: "Invalid criteria",
                message: `Invalid criteria provided for classification: ${error.details || error.message}`
            });
          }
          // Otherwise, throw a generic server error
          throw new Error(`Failed to get classified models with criteria: ${error.message}`);
          // reply.status(500).send({ 
          //   error: "Failed to get classified models with criteria", 
          //   message: error.message 
          // });
      }
  }
}

// Create singleton instance
const controller = new ModelController();

// Apply caching if Firestore cache is available
export default applyCaching(controller); 