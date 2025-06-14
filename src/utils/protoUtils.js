/**
 * Protocol Buffer Utilities
 * Handles loading Proto files and creating gRPC clients
 */
import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import logger from "./logger.js";

// __dirname is provided by Node in CJS bundles; we support CJS only here

// Path to proto file
const PROTO_PATH = path.resolve(__dirname, "protos/models.proto");

// Lazy-load the proto service definition
let modelService;
/** Asynchronously lazy-load the proto service definition */
async function getModelService() {
  if (!modelService) {
    const packageDefinition = await protoLoader.load(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [path.resolve(__dirname, "..")]    
    });
    const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
    modelService = protoDescriptor.modelservice;
  }
  return modelService;
}

/**
 * Create a gRPC client for the model classification service
 * @param {string} serverAddress - The address of the classification server
 * @returns {Object} gRPC client for the model classification service
 */
export async function createModelClassificationClient(serverAddress = "localhost:8080") {
  // Enhanced options for better compatibility with Go server
  const options = {
    "grpc.max_receive_message_length": 1024 * 1024 * 1, // 1MB
    "grpc.max_send_message_length": 1024 * 1024 * 1, // 1MB
    "grpc.default_compression_algorithm": 0, // No compression
    "grpc.default_compression_level": 0, // No compression
  };

  const svc = await getModelService();
  return new svc.ModelClassificationService(
    serverAddress,
    grpc.credentials.createInsecure(),
    options
  );
}

/**
 * Create a proper LoadedModelList proto message
 * @param {Array} modelList - Array of model objects
 * @param {string} defaultProvider - Default provider name
 * @param {string} defaultModel - Default model ID
 * @returns {Object} Protocol Buffer LoadedModelList object properly formatted for GRPC
 */
export function createLoadedModelList(modelList = [], defaultProvider = "", defaultModel = "") {
  try {
    // Process models to proper format first
    const formattedModels = modelList.map(model => createProtoModel(model));
    
    // Return the object in the format expected by gRPC
    return {
      models: formattedModels,
      default_provider: defaultProvider,
      default_model: defaultModel
    };
  } catch (error) {
    logger.error(`Error creating LoadedModelList: ${error.message}`, error);
    logger.error(`Stack: ${error.stack}`, error);
    throw error;
  }
}

/**
 * Create a proper Model proto message object
 * @param {Object} model - The model data
 * @returns {Object} Protocol Buffer Model object properly formatted for GRPC
 */
export function createProtoModel(model) {
  try {
    // Create a model object that matches the Go proto definition
    return {
      id: String(model.id || ""),
      name: String(model.name || ""),
      context_size: Number(model.tokenLimit || 0),
      max_tokens: Number(model.tokenLimit || 0),
      provider: String(model.provider || ""),
      display_name: String(model.displayName || ""),
      description: String(model.description || ""),
      cost_per_token: Number(model.costPerToken || 0),
      capabilities: Array.isArray(model.capabilities) ? model.capabilities.map(String) : [],
      
      // Classification fields with correct types
      family: String(model.family || ""),
      type: String(model.type || ""),
      series: String(model.series || ""),
      variant: String(model.variant || ""),
      is_default: Boolean(model.isDefault || false),
      is_multimodal: Boolean(model.isMultimodal || model.capabilities?.includes("vision") || false),
      is_experimental: Boolean(model.isExperimental || false),
      version: String(model.version || ""),
      
      // Initialize metadata as a map of strings
      metadata: convertMetadataToStringMap(model.metadata || {})
    };
  } catch (error) {
    logger.error(`Error creating Model proto: ${error.message}`, error);
    logger.error(`Stack: ${error.stack}`, error);
    throw error;
  }
}

/**
 * Convert metadata object to a map of strings
 * @param {Object} metadata - The metadata object
 * @returns {Object} Metadata with all values as strings
 */
function convertMetadataToStringMap(metadata) {
  const stringMap = {};
  
  Object.entries(metadata).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      stringMap[key] = typeof value === "object" ? 
        JSON.stringify(value) : String(value);
    }
  });
  
  return stringMap;
}

/**
 * Convert standard model object to Protocol Buffer model object
 * @param {Object} model - The model object to convert
 * @returns {Object} Protocol Buffer model object
 */
export function convertToProtoModel(model) {
  return createProtoModel(model);
}

/**
 * Convert Protocol Buffer model object to standard model object
 * @param {Object} protoModel - The Protocol Buffer model object to convert
 * @returns {Object} Standard model object
 */
export function convertFromProtoModel(protoModel) {
  if (!protoModel) {
    logger.warn("Received undefined or null protoModel in convertFromProtoModel");
    return {};
  }
  
  // Extract standard fields with camelCase keys and ensure correct types
  const model = {
    id: protoModel.id || "",
    name: protoModel.name || "",
    contextSize: typeof protoModel.context_size === "number" ? protoModel.context_size : 0,
    maxTokens: typeof protoModel.max_tokens === "number" ? protoModel.max_tokens : 0,
    provider: protoModel.provider || "",
    displayName: protoModel.display_name || "",
    description: protoModel.description || "",
    costPerToken: typeof protoModel.cost_per_token === "number" ? protoModel.cost_per_token : 0,
    capabilities: Array.isArray(protoModel.capabilities) ? protoModel.capabilities : [],
    
    // Classification fields with camelCase keys
    family: protoModel.family || "",
    type: protoModel.type || "",
    series: protoModel.series || "",
    variant: protoModel.variant || "",
    isDefault: Boolean(protoModel.is_default),
    isMultimodal: Boolean(protoModel.is_multimodal),
    isExperimental: Boolean(protoModel.is_experimental),
    version: protoModel.version || ""
  };

  // Add metadata fields to model if they exist
  if (protoModel.metadata && typeof protoModel.metadata === "object") {
    model.metadata = {};
    for (const [key, value] of Object.entries(protoModel.metadata)) {
      if (value !== undefined) {
        model.metadata[key] = value;
      }
    }
  }

  return model;
}

/**
 * Create classification criteria for filtering models
 * @param {Object} options - Options for classification criteria
 * @param {string[]} [options.properties] - Properties to filter by
 * @param {boolean} [options.includeExperimental] - Whether to include experimental models
 * @param {boolean} [options.includeDeprecated] - Whether to include deprecated models
 * @param {number} [options.minContextSize] - Minimum context size
 * @returns {Object} Classification criteria object
 */
export function createClassificationCriteria(options = {}) {
  try {
    return {
      properties: options.properties || [],
      include_experimental: Boolean(options.includeExperimental) || false,
      include_deprecated: Boolean(options.includeDeprecated) || false,
      min_context_size: Number(options.minContextSize) || 0
    };
  } catch (error) {
    logger.error(`Error creating ClassificationCriteria: ${error.message}`, error);
    logger.error(`Stack: ${error.stack}`, error);
    throw error;
  }
}

/**
 * Promisify a gRPC client method
 * @param {Function} method - gRPC client method
 * @param {Object} request - Request object
 * @returns {Promise} Promise that resolves with the response
 */
export function promisifyGrpcMethod(method, request) {
  return new Promise((resolve, reject) => {
    method(request, (error, response) => {
      if (error) {
        reject(error);
      } else {
        resolve(response);
      }
    });
  });
}

export default {
  createModelClassificationClient,
  createLoadedModelList,
  createProtoModel,
  convertToProtoModel,
  convertFromProtoModel,
  createClassificationCriteria,
  promisifyGrpcMethod
}; 