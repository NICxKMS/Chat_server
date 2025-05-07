/*
 * Chat JSON Schemas
 */
export const chatPayloadSchema = {
  body: {
    type: "object",
    required: ["model", "messages"],
    properties: {
      model: { type: "string" },
      messages: {
        type: "array",
        items: {
          type: "object",
          required: ["role", "content"],
          properties: {
            role: { type: "string", enum: ["system", "user", "assistant"] },
            content: {
              anyOf: [
                { type: "string" },
                { type: "array" },
                { type: "object" }
              ]
            }
          },
          additionalProperties: false
        },
        minItems: 1
      },
      temperature:       { type: "number", default: 0.7 },
      max_tokens:        { type: "integer", default: 1000 },
      top_p:             { type: "number" },
      frequency_penalty: { type: "number" },
      presence_penalty:  { type: "number" },
      requestId:         { type: "string" }
    },
    additionalProperties: false
  }
};

export const stopSchema = {
  body: {
    type: "object",
    required: ["requestId"],
    properties: {
      requestId: { type: "string" }
    },
    additionalProperties: false
  }
}; 