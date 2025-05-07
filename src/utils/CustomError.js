class BaseError extends Error {
  constructor(message, statusCode = 500, code = "INTERNAL_ERROR", details = null) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code; // Application-specific error code string
    this.details = details; // Arbitrary details object
    Error.captureStackTrace(this, this.constructor);
  }
}

class ProviderError extends BaseError {
  constructor(message, statusCode, code = "PROVIDER_ERROR", providerName = "unknown", details = null) {
    super(message, statusCode, code, details);
    this.providerName = providerName;
  }
}

class ProviderHttpError extends ProviderError {
  constructor(message, statusCode, code = "PROVIDER_HTTP_ERROR", providerName = "unknown", details = null) {
    super(message, statusCode, code, providerName, details);
  }
}

class ProviderRateLimitError extends ProviderHttpError {
  constructor(providerName = "unknown", details = null, message = "Rate limit exceeded with the provider.") {
    super(message, 429, "PROVIDER_RATE_LIMIT", providerName, details);
  }
}

class ProviderAuthenticationError extends ProviderHttpError {
  constructor(providerName = "unknown", details = null, message = "Authentication failed with the provider.") {
    super(message, 401, "PROVIDER_AUTH_ERROR", providerName, details);
  }
}

class ProviderSseError extends ProviderError {
  constructor(message, providerName = "unknown", code = "PROVIDER_SSE_ERROR", details = null, originalEvent = null) {
    // SSE errors don't typically have an HTTP status code directly associated with the event itself
    super(message, 502, code, providerName, details); // Default to 502 Bad Gateway if upstream SSE is malformed/errored
    this.originalEvent = originalEvent; // The raw SSE event that caused the error
  }
}

class StreamProcessingError extends BaseError {
  constructor(message, code = "STREAM_PROCESSING_ERROR", details = null) {
    super(message, 500, code, details);
  }
}

class StreamReadError extends StreamProcessingError {
  constructor(message, providerName = "unknown", details = null) {
    super(message, "STREAM_READ_ERROR", details);
    this.providerName = providerName; // Useful to know which provider's stream failed
  }
}

export {
  BaseError,
  ProviderError,
  ProviderHttpError,
  ProviderRateLimitError,
  ProviderAuthenticationError,
  ProviderSseError,
  StreamProcessingError,
  StreamReadError,
}; 