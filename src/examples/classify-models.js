/**
 * Example client for the Model Classification Service
 * Demonstrates how to use the protoUtils to communicate with the Go gRPC server
 */
import protoUtils from "../utils/protoUtils.js";
import logger from "../utils/logger.js";

// Sample models data
const sampleModels = [
  {
    id: "gpt-4",
    name: "GPT-4",
    provider: "openai",
    contextSize: 8192,
    maxTokens: 4096,
    capabilities: ["function-calling"]
  },
  {
    id: "gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    contextSize: 128000,
    maxTokens: 4096,
    capabilities: ["vision", "function-calling"],
    isMultimodal: true
  },
  {
    id: "claude-3-opus",
    name: "Claude 3 Opus",
    provider: "anthropic",
    contextSize: 200000,
    maxTokens: 4096,
    capabilities: ["vision", "function-calling"],
    isMultimodal: true
  }
];

// Main function
async function main() {
  try {
    // Create client (connect to localhost:8080 by default)
    const client = protoUtils.createModelClassificationClient();

    // Classify models example
    await classifyModelsExample(client);

    // Classify with criteria example
    await classifyWithCriteriaExample(client);

  } catch (error) {
    logger.error("Main function error", { message: error.message, details: error });
  }
}

// Example 1: Classify models
async function classifyModelsExample(client) {
  // Create the request payload
  const request = protoUtils.createLoadedModelList(
    sampleModels,
    "openai",
    "gpt-4"
  );

  try {
    // Make the request
    const response = await protoUtils.promisifyGrpcMethod(
      client.ClassifyModels.bind(client),
      request
    );

    // Display results
    response.classified_groups.forEach(group => {
      // REMOVED console.log(...)
    });
  } catch (error) {
    logger.error("Classification example failed", { error });
  }
}

// Example 2: Classify with criteria
async function classifyWithCriteriaExample(client) {
  // Create classification criteria
  const criteria = protoUtils.createClassificationCriteria({
    properties: ["provider", "family", "capability"],
    includeExperimental: true,
    minContextSize: 4096
  });

  try {
    // Make the request
    const response = await protoUtils.promisifyGrpcMethod(
      client.ClassifyModelsWithCriteria.bind(client),
      criteria
    );

    // Display results
    response.classified_groups.forEach(group => {
      // REMOVED console.log(...)
    });

    // Show available properties
    response.available_properties.forEach(prop => {
      // REMOVED console.log(...)
    });
  } catch (error) {
    logger.error("Classification with criteria example failed", { error });
  }
}

// Run the example
main().catch(error => logger.error("Unhandled error in main execution", { error })); 