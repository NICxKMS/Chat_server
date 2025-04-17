/**
 * Example client for the Model Classification Service
 * Demonstrates how to use the protoUtils to communicate with the Go gRPC server
 */
import protoUtils from "../utils/protoUtils.js";

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
    console.log("Connected to Model Classification Service");

    // Classify models example
    console.log("\n--- Classifying Models Example ---");
    await classifyModelsExample(client);

    // Classify with criteria example
    console.log("\n--- Classifying With Criteria Example ---");
    await classifyWithCriteriaExample(client);

  } catch (error) {
    console.error("Error:", error.message);
    console.error("Details:", error);
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
    console.log(`Received ${response.classified_groups.length} classification groups:`);
    response.classified_groups.forEach(group => {
      console.log(`- ${group.property_name}: ${group.property_value} (${group.models.length} models)`);
    });
  } catch (error) {
    console.error("Classification failed:", error);
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
    console.log(`Received ${response.classified_groups.length} classification groups:`);
    response.classified_groups.forEach(group => {
      console.log(`- ${group.property_name}: ${group.property_value} (${group.models.length} models)`);
    });

    // Show available properties
    console.log("\nAvailable Classification Properties:");
    response.available_properties.forEach(prop => {
      console.log(`- ${prop.name} (${prop.display_name}): ${prop.description}`);
    });
  } catch (error) {
    console.error("Classification with criteria failed:", error);
  }
}

// Run the example
main().catch(console.error); 