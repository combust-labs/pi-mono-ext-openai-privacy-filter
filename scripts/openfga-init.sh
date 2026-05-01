#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
#
# OpenFGA Initialization Script
# Creates the store and authorization model for the Privacy Filter extension.
#
# Usage: ./scripts/openfga-init.sh [--reset]
#   --reset  Delete existing store and recreate from scratch
#

set -e

OPENFGA_API_URL="${OPENFGA_API_URL:-http://localhost:8080}"
STORE_NAME="privacy-policies"
STORE_ID="${OPENFGA_STORE_ID:-}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if OpenFGA is running
check_openfga() {
    log_info "Checking OpenFGA connection at ${OPENFGA_API_URL}..."
    if ! curl -sf "${OPENFGA_API_URL}/healthz" > /dev/null 2>&1; then
        log_error "OpenFGA is not reachable at ${OPENFGA_API_URL}"
        log_error "Make sure OpenFGA is running: docker-compose up -d"
        exit 1
    fi
    log_info "OpenFGA is healthy"
}

# Delete existing store if --reset flag is provided
reset_store() {
    if [ -n "${STORE_ID}" ]; then
        log_warn "Deleting existing store: ${STORE_ID}"
        curl -sf -X DELETE "${OPENFGA_API_URL}/stores/${STORE_ID}" \
            -H "Content-Type: application/json" > /dev/null
        log_info "Store deleted"
    fi
}

# Create the store and get the store ID
create_store() {
    log_info "Creating store: ${STORE_NAME}"
    local response
    response=$(curl -sf -X POST "${OPENFGA_API_URL}/stores" \
        -H "Content-Type: application/json" \
        -d "{\"name\": \"${STORE_NAME}\"}")

    STORE_ID=$(echo "${response}" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
    if [ -z "${STORE_ID}" ]; then
        log_error "Failed to create store"
        exit 1
    fi
    log_info "Store created with ID: ${STORE_ID}"
    echo "export OPENFGA_STORE_ID=${STORE_ID}" >> /tmp/openfga_env.sh
}

# Create the authorization model
create_model() {
    local model_id
    log_info "Creating authorization model..."
    local response
    response=$(curl -sf -X PUT "${OPENFGA_API_URL}/stores/${STORE_ID}/authorization-models" \
        -H "Content-Type: application/json" \
        -d '{
            "schema_version": "1.1",
            "type_definitions": [
                {
                    "type": "model",
                    "relations": {
                        "define": {
                            "can_view": ["privacy_category"]
                        }
                    }
                },
                {
                    "type": "privacy_category",
                    "relations": {
                        "define": {
                            "can_view": ["model"]
                        }
                    }
                }
            ]
        }')

    model_id=$(echo "${response}" | grep -o '"authorization_model_id":"[^"]*"' | cut -d'"' -f4)
    if [ -z "${model_id}" ]; then
        log_error "Failed to create authorization model"
        exit 1
    fi
    log_info "Authorization model created with ID: ${model_id}"
    echo "export OPENFGA_MODEL_ID=${model_id}" >> /tmp/openfga_env.sh
}

# Print environment variables for convenience
print_env() {
    echo ""
    echo "========================================"
    echo "OpenFGA Setup Complete!"
    echo "========================================"
    echo ""
    echo "Add these to your environment or .env file:"
    echo ""
    echo "  export OPENFGA_API_URL=${OPENFGA_API_URL}"
    echo "  export OPENFGA_STORE_ID=${STORE_ID}"
    echo "  export OPENFGA_MODEL_ID=<your-model-id>"
    echo ""
    echo "To write authorization tuples, use:"
    echo "  curl -X POST ${OPENFGA_API_URL}/stores/${STORE_ID}/write \\"
    echo "    -H 'Content-Type: application/json' \\"
    echo "    -d '{"
    echo "      \"writes\": {"
    echo "        \"tuple_keys\": ["
    echo "          {\"user\": \"model:mlx-community/MiniMax-M2.7-8bit\", \"relation\": \"can_view\", \"object\": \"privacy_category:email\"}"
    echo "        ]"
    echo "      }"
    echo "    }'"
    echo ""
}

# Main
main() {
    rm -f /tmp/openfga_env.sh

    check_openfga

    if [ "$1" == "--reset" ]; then
        reset_store
    fi

    # Check if store already exists
    if [ -z "${STORE_ID}" ]; then
        create_store
    else
        log_info "Using existing store ID: ${STORE_ID}"
    fi

    create_model
    print_env
}

main "$@"