#!/bin/bash

# Exit on error
set -e

echo "Generating gRPC code for Node.js..."

# Path to the proto file
PROTO_DIR="./protos"
PROTO_FILE="$PROTO_DIR/models.proto"
OUTPUT_DIR="./types/proto/generated"

# Check if protoc is installed
if ! command -v protoc &> /dev/null; then
    echo "Error: protoc is not installed. Please install Protocol Buffers compiler."
    exit 1
fi

# Create output directory if it doesn't exist
mkdir -p $OUTPUT_DIR

# Clean previous generated files
rm -rf $OUTPUT_DIR/*

# Install required npm packages if not already installed
if ! npm list | grep -q "grpc-tools"; then
    echo "Installing grpc-tools..."
    npm install --save-dev grpc-tools
fi

if ! npm list | grep -q "google-protobuf"; then
    echo "Installing google-protobuf..."
    npm install --save google-protobuf
fi

# Generate JavaScript code
echo "Generating JavaScript code from $PROTO_FILE..."
npx grpc_tools_node_protoc \
    --js_out=import_style=commonjs,binary:$OUTPUT_DIR \
    --grpc_out=grpc_js:$OUTPUT_DIR \
    --proto_path=$PROTO_DIR \
    $PROTO_FILE

echo "Node.js gRPC code generation complete!" 