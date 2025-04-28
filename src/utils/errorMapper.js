/**
 * Map a provider error to a standardized HTTP error
 * @param {Error} error - Original error from provider or network
 * @param {string} providerName - Name of the provider
 * @param {string} modelName - Name of the model
 * @returns {Error} Mapped error with status and name properties
 */
export function mapProviderError(error, providerName, modelName) {
  let mappedError = error;
  if (error.message) {
    if (/authentication|api key|invalid_request_error.*api_key/i.test(error.message)) {
      mappedError = new Error(`Authentication failed with provider ${providerName}. Check your API key.`);
      mappedError.status = 401;
      mappedError.name = "AuthenticationError";
    } else if (/rate limit|quota exceeded/i.test(error.message)) {
      mappedError = new Error(`Rate limit exceeded for provider ${providerName}.`);
      mappedError.status = 429;
      mappedError.name = "RateLimitError";
    } else if (/model not found|deployment does not exist/i.test(error.message)) {
      mappedError = new Error(`Model '${modelName}' not found or unavailable for provider ${providerName}.`);
      mappedError.status = 404;
      mappedError.name = "NotFoundError";
    } else if (error.response?.status && error.response.status >= 400 && error.response.status < 500) {
      mappedError = new Error(`Provider ${providerName} returned client error ${error.response.status}: ${error.message}`);
      mappedError.status = error.response.status;
      mappedError.name = "ProviderClientError";
    } else {
      mappedError = new Error(`Provider ${providerName} encountered an error: ${error.message}`);
      mappedError.status = 502;
      mappedError.name = "ProviderError";
    }
  }
  return mappedError;
} 