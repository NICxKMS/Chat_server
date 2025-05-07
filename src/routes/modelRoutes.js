/**
 * Model Routes Plugin
 * Defines endpoints for model-related operations
 */
// import express from "express"; // Removed
import modelController from "../controllers/ModelController.js";
import logger from "../utils/logger.js";

// Fastify Plugin function
async function modelRoutes (fastify) {

  // GET / - Get all models from all providers
  fastify.get("/", modelController.getAllModels);



  // GET /categories - Get models categorized for dropdown UI
  fastify.get("/categories", modelController.getCategorizedModels);


  // GET /providers - Get all providers and their capabilities
  fastify.get("/providers", modelController.getProviders);


  // GET /classified - Get models classified by external service
  fastify.get("/classified", async (request, reply) => {
    logger.debug("=========== MODEL CLASSIFIED ROUTE ===========");
    logger.debug(`Request user: ${JSON.stringify(request.user)}`);
    logger.debug(`Auth header: ${request.headers.authorization ? "Present" : "Not present"}`);
    
    // Delegate to controller and return its promise
    return modelController.getClassifiedModels(request, reply);
  });

  // GET /classified/criteria - Get models classified with specific criteria
  // Uses request.query internally in the controller
  fastify.get("/classified/criteria", modelController.getClassifiedModelsWithCriteria);

  // GET /:providerName - Get models for a specific provider (must be last)
  // Uses request.params.providerName internally in the controller
  fastify.get("/:providerName", modelController.getProviderModels);

}

// export default router; // Removed
export default modelRoutes; // Export the plugin function 