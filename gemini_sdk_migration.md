
# Migration from `@google/generative-ai` to `@google/genai`

This document details the refactoring of the chat server to use the newer `@google/genai` SDK in place of the legacy `@google/generative-ai` package. The migration simplifies the `GeminiProvider`, reduces boilerplate, and leverages the more streamlined, centralized client offered by the new SDK.

## 1. Dependency Changes

The primary dependency in `package.json` was updated.

**Before:**
```json
{
  "dependencies": {
    "@google/generative-ai": "^0.24.1"
  }
}
```

**After:**
The `@google/generative-ai` package was removed, and `@google/genai` was already present (or would be added).

```json
{
  "dependencies": {
    "@google/genai": "^1.11.0"
  }
}
```
The `npm uninstall @google/generative-ai` command was run to remove the old package.

---

## 2. `GeminiProvider.js` Refactoring

The bulk of the changes occurred in `src/providers/GeminiProvider.js`. The refactor focused on replacing manual API calls and complex internal logic with direct, simpler calls to the new GenAI SDK.

### A. Client Instantiation

The provider's constructor was updated to use the new `GoogleGenAI` client.

**Before:**
```javascript
import { GoogleGenerativeAI } from "@google/generative-ai";

// ... inside constructor
this.genAI = new GoogleGenerativeAI(config.apiKey, {
  channelOptions: {
    "grpc.keepalive_time_ms": 30000,
    // ... other gRPC options
  }
});
```

**After:**
```javascript
import { GoogleGenAI } from "@google/genai";

// ... inside constructor
this.genAI = new GoogleGenAI({
  apiKey: config.apiKey,
  channelOptions: {
    "grpc.keepalive_time_ms": 30000,
    // ... other gRPC options
  }
});
```
The new SDK uses a configuration object for instantiation, which is a minor but important structural change.

### B. `getModels()` Method

This method was significantly simplified. It no longer relies on manual `axios` calls or complex fallback logic.

**Input:**
- No changes to the method signature. It still accepts no arguments.

**Output:**
- **Success:** Returns a `Promise<Array<Object>>` where each object represents a model with fields like `id`, `name`, `displayName`, `provider`, `tokenLimit`, etc. The structure is now directly mapped from the SDK's response.
- **Failure:** Falls back to a simple array of model objects derived from the static `config.models` list, e.g., `[{ id: 'gemini-1.5-flash', name: 'gemini-1.5-flash', provider: 'gemini' }]`.

**Before:**
The method involved a manual `axios.get` call to the `generativelanguage.googleapis.com` endpoint, custom filtering, and a separate, more complex fallback path that formatted names and looked up token limits.
```javascript
async getModels() {
  // Manual axios call with keep-alive agents
  const response = await axios.get(`${baseUrl}/models`, { /* ... */ });
  // Manual filtering and mapping of response
  return response.data.models
    .filter(/* ... */)
    .map(raw => ({
      id: raw.name.replace("models/", ""),
      name: raw.displayName,
      // ... and other fields
    }));
}
```

**After:**
The implementation now makes a single call to the SDK's `list()` method and maps the result. The fallback is a simple map of IDs from the config.
```javascript
async getModels() {
  try {
    const result = await this.genAI.models.list();
    const rawModels = result.models || [];
    return rawModels
      .filter(m => m.name.startsWith("models/gemini-"))
      .map(raw => {
        const id = raw.name.replace("models/", "");
        return { 
          id, 
          name: raw.displayName || id,
          displayName: raw.displayName, 
          provider: this.name, 
          tokenLimit: raw.outputTokenLimit, 
          contextSize: raw.inputTokenLimit, 
          description: raw.description || "" 
        };
      });
  } catch (error) {
    logger.error(`Gemini getModels error: ${error.message}`);
    // Fallback to simple config models list
    return (this.config.models || []).map(id => ({ id, name: id, provider: this.name }));
  }
}
```

### C. `chatCompletion()` Method

This method saw major simplification by removing the circuit breaker, the raw chat implementation (`_rawChatCompletion`), and the fallback logic.

**Input:**
- No changes to the `options` object structure. It still contains `{ model, messages, temperature, max_tokens, stop }`.

**Output:**
- No significant changes to the successful response format. It still returns a standardized chat completion object with `{ id, model, provider, content, usage, latency, finishReason }`. The error handling is now more direct, returning a simplified error object.

**Before:**
The method wrapped a `completionBreaker.fire()` call, which delegated to `_rawChatCompletion`. This involved manual payload construction for the `generateContent` call, complex response parsing, and error handling with a fallback to `_completionFallback`.
```javascript
async chatCompletion(options) {
  try {
    const response = await this.completionBreaker.fire(options);
    // ... record metrics
    return response;
  } catch (error) {
    // ... log error and execute fallback
    return await this._completionFallback(options, error);
  }
}

async _rawChatCompletion(options) {
  const generativeModel = this.genAI.getGenerativeModel({ model: modelName });
  const { contents, systemInstruction } = this._processMessages(options.messages);
  const requestPayload = { contents, /* ... */ };
  const result = await generativeModel.generateContent(requestPayload);
  // ... manually parse and map 'result.response' to our format
}
```

**After:**
The method now calls `this.genAI.chats.create()` directly, which is a higher-level abstraction that simplifies the interaction.
```javascript
async chatCompletion(options) {
  if (!this.hasValidApiKey) {
    return { /* ... auth error object ... */ };
  }
  try {
    const startTime = Date.now();
    const result = await this.genAI.chats.create({
      model: options.model,
      messages: options.messages,
      config: {
        temperature: options.temperature,
        maxOutputTokens: options.max_tokens,
        stopSequences: options.stop
      }
    });
    const latency = Date.now() - startTime;
    // Map result directly to standardized response
    return {
      id: result.id || `gemini-${Date.now()}`,
      content: result.choices?.[0]?.message?.content || result.text || "",
      // ... other fields
    };
  } catch (error) {
    logger.error(`Gemini chat error: ${error.message}`);
    return { /* ... return simplified error object ... */ };
  }
}
```

### E. `chatCompletionStream()` - Abort Signal Support

To properly cancel streaming when the client aborts (e.g., connection closed or user cancellation), include the `abortSignal` in the SDK call.

**Before:**
```javascript
const stream = await this.genAI.models.generateContentStream({
  model: modelName,
  contents,
  config: {
    temperature: opts.temperature,
    maxOutputTokens: opts.max_tokens,
    stopSequences: opts.stop,
    thinkingConfig: { thinkingBudget: -1 },
    stream: true
  }
});
```

**After:**
```javascript
const stream = await this.genAI.models.generateContentStream({
  model: modelName,
  contents,
  config: {
    temperature: opts.temperature,
    maxOutputTokens: opts.max_tokens,
    stopSequences: opts.stop,
    thinkingConfig: { thinkingBudget: -1 },
    stream: true
  },
  signal: opts.abortSignal  // ← Supports cancellation
});
```
This ensures that if `opts.abortSignal` is triggered, the SDK cancels the HTTP/gRPC request and terminates the stream gracefully.

---

### F. `chatCompletionStream()` Refactor

The streaming method was overhauled to use the GenAI SDK's built-in streaming API instead of manual SSE handling and circuit-breaker plumbing.

**Before:** (simplified)
```javascript
async *chatCompletionStream(options) {
  const startTime = process.hrtime();
  // validate API key, standardize options, select model...
  const streamResult = await generativeModel.generateContentStream(request, { signal: standardOptions.abortSignal });
  for await (const chunk of streamResult.stream) {
    // manual TTFB metrics, normalization, and yield
    yield this._normalizeStreamChunk(chunk, modelName, accumulatedLatency);
  }
  // record success metrics
}
```

**After:**
```javascript
async *chatCompletionStream(options) {
  if (!this.hasValidApiKey) {
    throw new Error("Gemini provider requires a valid API key for streaming.");
  }
  // Standardize + validate
  const opts = this.standardizeOptions(options);
  this.validateOptions(opts);

  const start = Date.now();
  const contents = opts.messages.map(m => ({ parts: [{ text: m.content }] }));

  const stream = await this.genAI.models.generateContentStream({
    model: opts.model,
    contents,
    config: {
      temperature: opts.temperature,
      maxOutputTokens: opts.max_tokens,
      stopSequences: opts.stop,
      thinkingConfig: { thinkingBudget: -1 },
      stream: true
    },
    signal: opts.abortSignal
  });

  for await (const chunk of stream) {
    const latency = Date.now() - start;
    yield this._normalizeStreamChunk(chunk, opts.model, latency);
  }
}
```

This change:
- Removes manual gRPC/SSE code and circuit-breaker calls.
- Leverages the `stream: true` flag and native async-iterator returned by GenAI SDK.
- Maintains interface compatibility via `_normalizeStreamChunk`.

---

### D. Removed Methods and Properties

To streamline the provider and remove code made redundant by the SDK, the following were removed entirely:

- **`formatModelName(modelId)`**: Was used for formatting names in the old fallback logic. No longer needed.
- **`getTokenLimit(modelId)`**: Was used for populating token limits in the old fallback logic. No longer needed.
- **`getProvidersInfo()` and `getInfo()`**: These were info-dump methods whose responsibilities are better handled by the `ProviderFactory` and direct consumers of `getModels()`.
- **`_rawChatCompletion()` and `_completionFallback()`**: These complex methods were made redundant by the direct, high-level `chats.create()` SDK call.
- **`completionBreaker`**: The `circuit-breaker-js` instance was removed to simplify the logic. The SDK handles some level of retry and error management, and further resilience can be added back at a higher level if needed.
- **`apiVersion` and `apiVersionInfo`**: This state was only used for the manual `axios` calls and is no longer necessary.

This migration resulted in a cleaner, more maintainable `GeminiProvider` that is easier to understand and more aligned with the intended usage of the modern `@google/genai` SDK. 