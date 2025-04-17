/**
 * Model Classification Service
 * Handles sending model data to the classification server using Protocol Buffers
 */
import * as grpc from "@grpc/grpc-js";
import providerFactory from "../providers/ProviderFactory.js";
import protoUtils from "../utils/protoUtils.js";
import chalk from "chalk";
import * as fs from "fs";
import logger from "../utils/logger.js";

export class ModelClassificationService {
  /**
   * Create a new ModelClassificationService
   * @param {string} serverAddress - The address of the classification server
   */
  constructor(serverAddress = "localhost:8080") {
    this.serverAddress = serverAddress;
    this.client = protoUtils.createModelClassificationClient(serverAddress);
  }

  /**
   * Convert provider info into the protobuf ModelList format.
   * @param {object} providersInfo - Data fetched from providerFactory.getProvidersInfo()
   * @returns {object} - A protobuf-compatible LoadedModelList object
   */
  createProtoModelList(providersInfo) {
    try {
      // Convert to proto format
      const modelList = [];
      
      for (const [provider, info] of Object.entries(providersInfo)) {
        if (info && typeof info === "object" && "models" in info && Array.isArray(info.models)) {
          for (const model of info.models) {
            // Convert string model IDs to objects, or use existing object
            const modelObj = typeof model === "string" 
              ? { id: model, name: model, provider } 
              : { ...model, provider, name: model.name || model.id };
            
            // Ensure model object has an ID
            if (!modelObj.id) {
              logger.warn(`Model without ID detected for provider ${provider}, skipping`);
              continue;
            }
            
            // Enhance with classification properties if available (if needed later)
            // this.enhanceModelWithClassificationProperties(modelObj);
            
            // Convert to proto format
            try {
              const protoModel = protoUtils.createProtoModel(modelObj);
              modelList.push(protoModel);
            } catch (error) {
              logger.error(`Error converting model ${modelObj.id} to proto format`, { error: error.message });
              // Continue with other models even if one fails
            }
          }
        }
      }
      
      // Get default provider safely
      let defaultProviderName = "none";
      let defaultModelName = "";
      
      try {
        const defaultProvider = providerFactory.getProvider(); // Still need this for defaults
        defaultProviderName = defaultProvider?.name || "none";
        defaultModelName = defaultProvider?.config?.defaultModel || "";
      } catch (error) {
        logger.warn(`Error getting default provider`, { error: error.message });
      }
      
      // Create LoadedModelList with proper types
      return {
        models: modelList,
        default_provider: defaultProviderName,
        default_model: defaultModelName
      };
    } catch (error) {
      logger.error(`Error in createProtoModelList`, { error: error.message });
      // Return empty model list on error
      return {
        models: [],
        default_provider: "none",
        default_model: ""
      };
    }
  }

  
  /**
   * Send models to the classification server and return classified models
   * @param {object} providersInfo - Pre-fetched provider information.
   * @returns {Promise<object>} - Classified models
   */
  async getClassifiedModels(providersInfo) { // Accept providersInfo as argument
    try {
      // Check if client is properly initialized
      if (!this.client) {
        logger.error("Classification client not initialized");
        throw new Error("Classification service client not initialized");
      }

      // Convert pre-fetched models to proto format
      const modelList = this.createProtoModelList(providersInfo);
      
      // Return a Promise that will resolve with the classified models
      return new Promise((resolve, reject) => {
        // Set a timeout for the gRPC call
        const timeout = setTimeout(() => {
          reject(new Error("Classification request timed out after 15 seconds"));
        }, 15000);
        
        // Call the gRPC service with retry logic
        const attemptClassify = (retryCount = 0, maxRetries = 3) => {
          // Write request body to file
          try {
            fs.writeFileSync('req.json', JSON.stringify(modelList, null, 2));
          } catch (writeError) {
            logger.error(`[Debug] Error writing request body to req.json`, { error: writeError.message });
          }
          this.client.classifyModels(modelList, (error, response) => {
            clearTimeout(timeout); // Clear timeout once callback is received
            
            if (error) {
              // Handle gRPC errors
              logger.error(`[gRPC Client] classifyModels Error (Attempt ${retryCount + 1}/${maxRetries + 1})`, { code: error.code, details: error.details || error.message });
              
              // Check if the error is retryable (e.g., UNAVAILABLE, DEADLINE_EXCEEDED)
              const isRetryable = error.code === grpc.status.UNAVAILABLE || 
                                  error.code === grpc.status.DEADLINE_EXCEEDED;
              
              // Retry only for specific retryable errors
              if (isRetryable && retryCount < maxRetries) {
                // Exponential backoff delay with jitter: 2^n * 500ms + random(0-200ms)
                const backoff = Math.min((Math.pow(2, retryCount) * 500) + Math.random() * 200, 5000);
                setTimeout(() => attemptClassify(retryCount + 1, maxRetries), backoff);
              } else {
                // No more retries or non-retryable error, reject the promise
                reject(new Error(`gRPC classifyModels failed after ${retryCount + 1} attempts: ${error.details || error.message}`));
              }
            } else {
              // Check if response is valid
              if (!response) {
                logger.error('[gRPC Client] classifyModels received empty response, rejecting.');
                reject(new Error("Received empty response from classification server"));
                return;
              }

              resolve(response); // Resolve the promise with the response, not return it from callback
            }
          });
        };
        
        // Start the classification process
        attemptClassify();
      });
    } catch (error) {
      logger.error(`Error in getClassifiedModels`, { error: error.message });
      throw error;
    }
  }

  /**
   * Get models that match specific criteria from the classification service.
   * @param {object} criteria - Criteria for filtering models (will be converted to proto).
   * @returns {Promise<object>} - Models matching criteria (raw proto response).
   */
  async getModelsByCriteria(criteria) {
    try {
      // Check if client is properly initialized
      if (!this.client) {
        logger.error("Classification client not initialized");
        throw new Error("Classification service client not initialized");
      }
      
      // Convert criteria to protocol buffer format
      const protoCriteria = protoUtils.createProtoClassificationCriteria(criteria);
      
      // Return a Promise that will resolve with the matching models
      return new Promise((resolve, reject) => {
        // Set a timeout for the gRPC call
        const timeout = setTimeout(() => {
          reject(new Error("Get models by criteria request timed out after 10 seconds"));
        }, 10000);
        
        // Call the gRPC service with retry logic
        const attemptGetModelsByCriteria = (retryCount = 0, maxRetries = 2) => {
          // Write request body to file
          try {
            fs.writeFileSync('req_criteria.json', JSON.stringify(protoCriteria, null, 2));
          } catch (writeError) {
            logger.error(`[Debug] Error writing criteria request body to req_criteria.json`, { error: writeError.message });
          }

          this.client.getModelsByCriteria(protoCriteria, (error, response) => {
            clearTimeout(timeout); // Clear timeout once callback is received
            
            if (error) {
              // Handle gRPC errors
              logger.error(`[gRPC Client] getModelsByCriteria Error (Attempt ${retryCount + 1}/${maxRetries + 1})`, { code: error.code, details: error.details || error.message });
              
              // Check if the error is retryable
              const isRetryable = error.code === grpc.status.UNAVAILABLE || 
                                  error.code === grpc.status.DEADLINE_EXCEEDED;
              
              // Retry only for specific retryable errors
              if (isRetryable && retryCount < maxRetries) {
                // Exponential backoff delay with jitter: 2^n * 500ms + random(0-200ms)
                const backoff = Math.min((Math.pow(2, retryCount) * 500) + Math.random() * 200, 3000);
                setTimeout(() => attemptGetModelsByCriteria(retryCount + 1, maxRetries), backoff);
              } else {
                // No more retries or non-retryable error, reject the promise
                reject(new Error(`gRPC getModelsByCriteria failed after ${retryCount + 1} attempts: ${error.details || error.message}`));
              }
            } else {
              if (!response) {
                logger.error('[gRPC Client] getModelsByCriteria received empty response, rejecting.');
                reject(new Error("Received empty response from classification server (getModelsByCriteria)"));
                return;
              }
              
              resolve(response);
            }
          });
        };
        
        // Start the get models by criteria process
        attemptGetModelsByCriteria();
      });
    } catch (error) {
      logger.error(`Error in getModelsByCriteria`, { error: error.message });
      throw error;
    }
  }
} 