/**
 * Model Classification Service
 * Handles sending model data to the classification server using Protocol Buffers
 */
import * as grpc from "@grpc/grpc-js";
import providerFactory from "../providers/ProviderFactory.js";
import protoUtils from "../utils/protoUtils.js";
import chalk from "chalk";
import * as fs from "fs";

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
              console.warn(`Model without ID detected for provider ${provider}, skipping`);
              continue;
            }
            
            // Enhance with classification properties if available (if needed later)
            // this.enhanceModelWithClassificationProperties(modelObj);
            
            // Convert to proto format
            try {
              const protoModel = protoUtils.createProtoModel(modelObj);
              modelList.push(protoModel);
            } catch (error) {
              console.error(`Error converting model ${modelObj.id} to proto format: ${error.message}`);
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
        console.warn(`Error getting default provider: ${error.message}`);
      }
      
      // Create LoadedModelList with proper types
      // console.log(modelList);
      return {
        models: modelList,
        default_provider: defaultProviderName,
        default_model: defaultModelName
      };
    } catch (error) {
      console.error(`Error in createProtoModelList: ${error.message}`);
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
        console.error("Classification client not initialized");
        throw new Error("Classification service client not initialized");
      }

      // Convert pre-fetched models to proto format
      const modelList = this.createProtoModelList(providersInfo);
      
      // Log the server address we're connecting to
      console.log(`Connecting to classification server at ${this.serverAddress}`);
      console.log(`Number of models to classify: ${modelList.models.length}`);
      // console.log(modelList);

      // Return a Promise that will resolve with the classified models
      return new Promise((resolve, reject) => {
        // Set a timeout for the gRPC call
        const timeout = setTimeout(() => {
          reject(new Error("Classification request timed out after 15 seconds"));
        }, 15000);
        
        // Log the number of models being sent for debugging
        console.log(`Preparing to send ${modelList.models.length} models for classification`);
        
        // Call the gRPC service with retry logic
        const attemptClassify = (retryCount = 0, maxRetries = 3) => {
          console.log(chalk.blue('[gRPC Client] Making classifyModels call...'));
          // Write request body to file
          try {
            fs.writeFileSync('req.json', JSON.stringify(modelList, null, 2));
            console.log(chalk.magenta('[Debug] Request body written to req.json'));
          } catch (writeError) {
            console.error(chalk.red(`[Debug] Error writing request body to req.json: ${writeError.message}`));
          }
          this.client.classifyModels(modelList, (error, response) => {
            clearTimeout(timeout); // Clear timeout once callback is received
            
            if (error) {
              // Handle gRPC errors
              console.error(chalk.red(`[gRPC Client] classifyModels Error (Attempt ${retryCount + 1}/${maxRetries + 1}): ${error.code} - ${error.details || error.message}`));
              
              // Check if the error is retryable (e.g., UNAVAILABLE, DEADLINE_EXCEEDED)
              const isRetryable = error.code === grpc.status.UNAVAILABLE || 
                                  error.code === grpc.status.DEADLINE_EXCEEDED;
              
              // Retry only for specific retryable errors
              if (isRetryable && retryCount < maxRetries) {
                console.log(`Retrying gRPC classifyModels (Attempt ${retryCount + 2}/${maxRetries + 1})...`);
                
                // Exponential backoff delay with jitter: 2^n * 500ms + random(0-200ms)
                const backoff = Math.min((Math.pow(2, retryCount) * 500) + Math.random() * 200, 5000);
                setTimeout(() => attemptClassify(retryCount + 1, maxRetries), backoff);
              } else {
                // No more retries or non-retryable error, reject the promise
                console.log(chalk.red('[gRPC Client] classifyModels failed, rejecting.'));
                reject(new Error(`gRPC classifyModels failed after ${retryCount + 1} attempts: ${error.details || error.message}`));
              }
            } else {
              console.log(chalk.green('[gRPC Client] classifyModels call successful.'));
              
              // Check if response is valid
              if (!response) {
                console.log(chalk.red('[gRPC Client] classifyModels received empty response, rejecting.'));
                reject(new Error("Received empty response from classification server"));
                return;
              }

              console.log(`Successfully classified models, received ${response.hierarchical_groups?.length || 0} hierarchical groups`);
              resolve(response); // Resolve the promise with the response, not return it from callback
            }
          });
        };
        
        // Start the classification process
        attemptClassify();
      });
    } catch (error) {
      console.error(`Error in getClassifiedModels: ${error.message}`);
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
        console.error("Classification client not initialized");
        throw new Error("Classification service client not initialized");
      }
      
      // Log the server address we're connecting to
      console.log(`Connecting to classification server at ${this.serverAddress} for criteria matching`);
      console.log(`Criteria: ${JSON.stringify(criteria)}`);
      
      // Convert criteria to protocol buffer format
      const protoCriteria = protoUtils.createProtoClassificationCriteria(criteria);
      
      // Return a Promise that will resolve with the matching models
      return new Promise((resolve, reject) => {
        // Set a timeout for the gRPC call
        const timeout = setTimeout(() => {
          reject(new Error("Classification criteria request timed out after 10 seconds"));
        }, 10000);
        
        // Call the gRPC service with retry logic
        const attemptGetModelsByCriteria = (retryCount = 0, maxRetries = 2) => {
          console.log(chalk.blue('[gRPC Client] Making getModelsByCriteria call...'));
          // Write request body to file
          try {
            fs.writeFileSync('req.json', JSON.stringify(protoCriteria, null, 2));
            console.log(chalk.magenta('[Debug] Criteria request body written to req.json'));
          } catch (writeError) {
            console.error(chalk.red(`[Debug] Error writing criteria request body to req.json: ${writeError.message}`));
          }
          this.client.getModelsByCriteria(protoCriteria, (error, response) => {
            clearTimeout(timeout); // Clear timeout once callback is received
            
            if (error) {
              // Handle gRPC errors
              console.error(chalk.red(`[gRPC Client] getModelsByCriteria Error (Attempt ${retryCount + 1}/${maxRetries + 1}): ${error.code} - ${error.details || error.message}`));
              
              // Check if the error is retryable
              const isRetryable = error.code === grpc.status.UNAVAILABLE || 
                                  error.code === grpc.status.DEADLINE_EXCEEDED;
              
              // Retry only for specific retryable errors
              if (isRetryable && retryCount < maxRetries) {
                console.log(`Retrying gRPC getModelsByCriteria (Attempt ${retryCount + 2}/${maxRetries + 1})...`);
                
                // Simple backoff delay: 1s, 2s, ...
                setTimeout(() => attemptGetModelsByCriteria(retryCount + 1, maxRetries), (retryCount + 1) * 1000);
              } else {
                // No more retries or non-retryable error, reject the promise
                console.log(chalk.red('[gRPC Client] getModelsByCriteria failed, rejecting.'));
                reject(new Error(`gRPC getModelsByCriteria failed after ${retryCount + 1} attempts: ${error.details || error.message}`));
              }
            } else {
              console.log(chalk.green('[gRPC Client] getModelsByCriteria call successful.'));
              
              // Check if response is valid
              if (!response) {
                console.log(chalk.red('[gRPC Client] getModelsByCriteria received empty response, rejecting.'));
                reject(new Error("Received empty response from classification server"));
                return;
              }
              
              console.log(`Successfully got models by criteria, found ${response.models?.length || 0} matching models`);
              
              // Resolve the promise with the response
              resolve(response);
            }
          });
        };
        
        // Start the get models by criteria process
        attemptGetModelsByCriteria();
      });
    } catch (error) {
      console.error(`Error in getModelsByCriteria: ${error.message}`);
      throw error;
    }
  }
} 