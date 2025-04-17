// GENERATED CODE -- DO NOT EDIT!

"use strict";
var grpc = require("@grpc/grpc-js");
var models_pb = require("./models_pb.js");

function serialize_modelservice_ClassificationCriteria(arg) {
  if (!(arg instanceof models_pb.ClassificationCriteria)) {
    throw new Error("Expected argument of type modelservice.ClassificationCriteria");
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_modelservice_ClassificationCriteria(buffer_arg) {
  return models_pb.ClassificationCriteria.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_modelservice_ClassifiedModelResponse(arg) {
  if (!(arg instanceof models_pb.ClassifiedModelResponse)) {
    throw new Error("Expected argument of type modelservice.ClassifiedModelResponse");
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_modelservice_ClassifiedModelResponse(buffer_arg) {
  return models_pb.ClassifiedModelResponse.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_modelservice_LoadedModelList(arg) {
  if (!(arg instanceof models_pb.LoadedModelList)) {
    throw new Error("Expected argument of type modelservice.LoadedModelList");
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_modelservice_LoadedModelList(buffer_arg) {
  return models_pb.LoadedModelList.deserializeBinary(new Uint8Array(buffer_arg));
}


// The ModelClassificationService definition
var ModelClassificationServiceService = exports.ModelClassificationServiceService = {
  // Classify a list of models
  classifyModels: {
    path: "/modelservice.ModelClassificationService/ClassifyModels",
    requestStream: false,
    responseStream: false,
    requestType: models_pb.LoadedModelList,
    responseType: models_pb.ClassifiedModelResponse,
    requestSerialize: serialize_modelservice_LoadedModelList,
    requestDeserialize: deserialize_modelservice_LoadedModelList,
    responseSerialize: serialize_modelservice_ClassifiedModelResponse,
    responseDeserialize: deserialize_modelservice_ClassifiedModelResponse,
  },
  // Classify models with criteria
  // Use hierarchical=true in ClassificationCriteria to get hierarchical grouping
  classifyModelsWithCriteria: {
    path: "/modelservice.ModelClassificationService/ClassifyModelsWithCriteria",
    requestStream: false,
    responseStream: false,
    requestType: models_pb.ClassificationCriteria,
    responseType: models_pb.ClassifiedModelResponse,
    requestSerialize: serialize_modelservice_ClassificationCriteria,
    requestDeserialize: deserialize_modelservice_ClassificationCriteria,
    responseSerialize: serialize_modelservice_ClassifiedModelResponse,
    responseDeserialize: deserialize_modelservice_ClassifiedModelResponse,
  },
};

exports.ModelClassificationServiceClient = grpc.makeGenericClientConstructor(ModelClassificationServiceService, "ModelClassificationService");
