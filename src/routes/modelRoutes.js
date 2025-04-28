/**
 * Model Routes Plugin
 * Defines endpoints for model-related operations
 */
// import express from "express"; // Removed
import modelController from "../controllers/ModelController.js";
import logger from "../utils/logger.js";

// JSON schema for classification criteria (request body)
const classifyCriteriaSchema = {
  type: "object",
  minProperties: 1,
  additionalProperties: { type: ["string", "number", "boolean", "object", "array"] }
};
// JSON schema for providerName param
const providerParamsSchema = {
  type: "object",
  required: ["providerName"],
  properties: { providerName: { type: "string" } }
};

// Fastify Plugin function
async function modelRoutes (fastify, options) {

  // GET / - Get all models from all providers
  fastify.get("/", modelController.getAllModels);

  // // GET /models/list - REMOVED ALIAS
  // router.get('/list', modelController.getAllModels.bind(modelController));

  // GET /categories - Get models categorized for dropdown UI
  fastify.get("/categories", modelController.getCategorizedModels);

  // // GET /models/categorized - REMOVED ALIAS
  // router.get('/categorized', modelController.getCategorizedModels.bind(modelController));

  // GET /providers - Get all providers and their capabilities
  fastify.get("/providers", modelController.getProviders);

  // // GET /models/capabilities/all - REMOVED ALIAS
  // router.get('/capabilities/all', modelController.getProviderCapabilities.bind(modelController));

  // GET /classified - Get models classified by external service
  fastify.get("/classified", (request, reply, done) => {
    logger.debug("=========== MODEL CLASSIFIED ROUTE ===========");
    logger.debug(`Request user: ${JSON.stringify(request.user)}`);
    logger.debug(`Auth header: ${request.headers.authorization ? "Present" : "Not present"}`);
    
    // Continue to controller
    modelController.getClassifiedModels(request, reply);
  });

  // GET /classified/criteria - validation for classification criteria
  fastify.get(
    "/classified/criteria",
    modelController.getClassifiedModelsWithCriteria
  );

  // GET /:providerName - Get models for a specific provider (must be last)
  fastify.get(
    "/:providerName",
    { schema: { params: providerParamsSchema } },
    modelController.getProviderModels
  );

}

// export default router; // Removed
export default modelRoutes; // Export the plugin function 