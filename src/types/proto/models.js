/**
 * @fileoverview Type definitions for the Protocol Buffer models used in gRPC communication
 * JavaScript version of models.d.ts with JSDoc annotations
 */

/**
 * @typedef {Object} ModelObject
 * @property {string} id - Model identifier
 * @property {string} [name] - Display name of the model
 * @property {number} [context_size] - Maximum context size in tokens
 * @property {number} [max_tokens] - Maximum output tokens
 * @property {string} provider - Provider identifier (e.g. 'openai', 'anthropic')
 * @property {string} [display_name] - Human-readable display name
 * @property {string} [description] - Description of the model
 * @property {number} [cost_per_token] - Cost per token
 * @property {string[]} [capabilities] - Array of model capabilities
 * 
 * @property {string} [family] - Classification family (e.g. 'GPT-4', 'Claude')
 * @property {string} [type] - Classification type (e.g. 'Vision', 'Turbo')
 * @property {string} [series] - Classification series
 * @property {string} [variant] - Classification variant
 * @property {boolean} [is_default] - Whether this is a default model
 * @property {boolean} [is_multimodal] - Whether this is a multimodal model
 * @property {boolean} [is_experimental] - Whether this is an experimental model
 * @property {string} [version] - Version string
 * 
 * @property {Object<string, string>} [metadata] - Additional metadata key-value pairs
 */

/**
 * @typedef {Object} LoadedModelListObject
 * @property {ModelObject[]} models - List of available models
 * @property {string} [default_provider] - Default provider ID
 * @property {string} [default_model] - Default model ID
 */

/**
 * @typedef {Object} ClassificationPropertyObject
 * @property {string} name - Property name
 * @property {string} [display_name] - Human-readable display name
 * @property {string} [description] - Description of the property
 * @property {string[]} [possible_values] - Possible values for this property
 */

/**
 * @typedef {Object} ClassifiedModelGroupObject
 * @property {string} property_name - Name of the classification property
 * @property {string} property_value - Value of the classification property
 * @property {ModelObject[]} models - Models in this classification group
 */

/**
 * @typedef {Object} ClassificationCriteriaObject
 * @property {string[]} [properties] - Properties to use for classification
 * @property {boolean} [include_experimental] - Whether to include experimental models
 * @property {boolean} [include_deprecated] - Whether to include deprecated models
 * @property {number} [min_context_size] - Minimum context size in tokens
 */

/**
 * @typedef {Object} ClassifiedModelResponseObject
 * @property {ClassifiedModelGroupObject[]} classified_groups - Classified model groups
 * @property {ClassificationPropertyObject[]} [available_properties] - Available classification properties
 * @property {string} [error_message] - Error message if classification failed
 */

/**
 * @typedef {Object} ProtoGrpcType
 * @property {Object} modelservice
 * @property {Function} modelservice.ClassificationCriteria - Message type constructor
 * @property {Function} modelservice.ClassificationProperty - Message type constructor
 * @property {Function} modelservice.ClassifiedModelGroup - Message type constructor
 * @property {Function} modelservice.ClassifiedModelResponse - Message type constructor
 * @property {Function} modelservice.LoadedModelList - Message type constructor
 * @property {Function} modelservice.Model - Message type constructor
 * @property {Function} modelservice.ModelClassificationService - Service constructor
 */

/**
 * Type definitions for Model Classification Proto
 * This file provides typed interfaces for the protobuf generated objects
 */

/**
 * @typedef {Object} ProtoModel
 * @property {string} id - Unique identifier for the model
 * @property {string} name - Model name
 * @property {number} context_size - Maximum context window size
 * @property {number} max_tokens - Maximum tokens the model can generate
 * @property {string} provider - Provider of the model (e.g., OpenAI, Anthropic)
 * @property {string} display_name - Human-readable display name
 * @property {string} description - Model description
 * @property {number} cost_per_token - Cost per token for the model
 * @property {string[]} capabilities - List of model capabilities
 * @property {string} family - Model family (e.g., GPT-4, Claude 3)
 * @property {string} type - Model type (e.g., Vision, Standard)
 * @property {string} series - Model series
 * @property {string} variant - Model variant
 * @property {boolean} is_default - Whether this is a default model
 * @property {boolean} is_multimodal - Whether this is a multimodal model
 * @property {boolean} is_experimental - Whether this is an experimental model
 * @property {string} version - Model version
 * @property {Object.<string, string>} metadata - Additional metadata
 */

/**
 * @typedef {Object} ProtoLoadedModelList
 * @property {ProtoModel[]} models - List of models
 * @property {string} default_provider - Default provider
 * @property {string} default_model - Default model ID
 */

/**
 * @typedef {Object} ProtoClassificationProperty
 * @property {string} name - Property name
 * @property {string} display_name - Human-readable display name
 * @property {string} description - Property description
 * @property {string[]} possible_values - List of possible values
 */

/**
 * @typedef {Object} ProtoClassifiedModelGroup
 * @property {string} property_name - Property name
 * @property {string} property_value - Property value
 * @property {ProtoModel[]} models - List of models in this group
 */

/**
 * @typedef {Object} ProtoClassificationCriteria
 * @property {string[]} properties - Properties to filter by
 * @property {boolean} include_experimental - Whether to include experimental models
 * @property {boolean} include_deprecated - Whether to include deprecated models
 * @property {number} min_context_size - Minimum context size
 */

/**
 * @typedef {Object} ProtoClassifiedModelResponse
 * @property {ProtoClassifiedModelGroup[]} classified_groups - Classified model groups
 * @property {ProtoClassificationProperty[]} available_properties - Available classification properties
 * @property {string} error_message - Error message, if any
 */

/**
 * @typedef {Object} ModelClassificationClient
 * @property {function(ProtoLoadedModelList, function(Error, ProtoClassifiedModelResponse))} ClassifyModels - Classify models
 * @property {function(ProtoClassificationCriteria, function(Error, ProtoClassifiedModelResponse))} ClassifyModelsWithCriteria - Classify models with criteria
 */

export default {
  /**
   * @type {Object}
   * @property {function(string, Object, Object): ModelClassificationClient} ModelClassificationService - Creates a new ModelClassificationService client
   */
  modelservice: {}
}; 