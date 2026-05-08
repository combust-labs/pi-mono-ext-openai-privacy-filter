#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
#
# OpenFGA Initialization Script (v2 - with lineage and sharing)
# Creates the store and authorization model for the Privacy Filter extension.
#
# Authorization Model:
#   model_instance:M --can_view--> pii_instance:P
#   model_instance:M --can_share--> pii_instance:P
#   model_instance:M --can_receive--> pii_instance:P
#   pii_instance:P --originates_from--> model_instance:M
#   pii_instance:P --can_view--> recipient:R
#   pii_instance:P --category--> category:C
#   category:C --defines--> model_instance:M
#   recipient:R --can_receive_from--> model_instance:M
#
# Usage: ./scripts/openfga-init.sh [--reset]
#   --reset  Delete existing store and recreate from scratch
#

set -e

OPENFGA_API_URL="${OPENFGA_API_URL:-http://localhost:28080}"
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

# Create the authorization model (v2 with lineage and sharing)
create_model() {
    local model_id
    log_info "Creating authorization model (v2 - with lineage and sharing)..."
    local response
    response=$(curl -sf -X POST "${OPENFGA_API_URL}/stores/${STORE_ID}/authorization-models" \
        -H "Content-Type: application/json" \
        -d '{
            "schema_version": "1.1",
            "type_definitions": [
                {
                    "type": "model_instance",
                    "relations": {
                        "can_view": {
                            "this": {}
                        },
                        "can_share": {
                            "this": {}
                        },
                        "can_receive": {
                            "this": {}
                        }
                    },
                    "metadata": {
                        "relations": {
                            "can_view": {
                                "directly_related_user_types": [
                                    { "type": "model_instance" }
                                ]
                            },
                            "can_share": {
                                "directly_related_user_types": [
                                    { "type": "pii_instance" }
                                ]
                            },
                            "can_receive": {
                                "directly_related_user_types": [
                                    { "type": "pii_instance" }
                                ]
                            }
                        }
                    }
                },
                {
                    "type": "pii_instance",
                    "relations": {
                        "can_view": {
                            "this": {}
                        },
                        "originates_from": {
                            "this": {}
                        },
                        "category": {
                            "this": {}
                        }
                    },
                    "metadata": {
                        "relations": {
                            "can_view": {
                                "directly_related_user_types": [
                                    { "type": "recipient" }
                                ]
                            },
                            "originates_from": {
                                "directly_related_user_types": [
                                    { "type": "model_instance" }
                                ]
                            },
                            "category": {
                                "directly_related_user_types": [
                                    { "type": "category" }
                                ]
                            }
                        }
                    }
                },
                {
                    "type": "category",
                    "relations": {
                        "defines": {
                            "this": {}
                        }
                    },
                    "metadata": {
                        "relations": {
                            "defines": {
                                "directly_related_user_types": [
                                    { "type": "model_instance" }
                                ]
                            }
                        }
                    }
                },
                {
                    "type": "recipient",
                    "relations": {
                        "can_receive": {
                            "this": {}
                        },
                        "can_receive_from": {
                            "this": {}
                        }
                    },
                    "metadata": {
                        "relations": {
                            "can_receive": {
                                "directly_related_user_types": [
                                    { "type": "pii_instance" }
                                ]
                            },
                            "can_receive_from": {
                                "directly_related_user_types": [
                                    { "type": "model_instance" }
                                ]
                            }
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
    echo "  export OPENFGA_MODEL_ID=${model_id}"
    echo ""
    echo "========================================"
    echo "Authorization Model v2"
    echo "========================================"
    echo ""
    echo "Types:"
    echo "  - model_instance: AI model or agent"
    echo "  - pii_instance: A specific PII occurrence (identified by SHA256 hash)"
    echo "  - category: A category of PII (email, phone, etc.)"
    echo "  - recipient: A user, harness, or agent that can receive PII"
    echo ""
    echo "Key Relations:"
    echo "  - model_instance --can_view--> pii_instance      (input direction)"
    echo "  - model_instance --can_share--> pii_instance     (model can share this PII)"
    echo "  - pii_instance --originates_from--> model_instance (lineage)"
    echo "  - pii_instance --can_view--> recipient           (who can view this PII)"
    echo "  - recipient --can_receive_from--> model_instance (trust relationship)"
    echo ""
    echo "Example Tuple Commands (new syntax):"
    echo "  # Grant model access to view PII instance"
    echo "  ./scripts/openfga-tuple.sh grant-view \"mlx-community/MiniMax-M2.7-8bit\" \"sha256-abc123\""
    echo ""
    echo "  # Grant model sharing access to a PII instance"
    echo "  ./scripts/openfga-tuple.sh grant-share \"mlx-community/MiniMax-M2.7-8bit\" \"sha256-abc123\""
    echo ""
    echo "  # Set PII lineage (this PII came from model M)"
    echo "  ./scripts/openfga-tuple.sh set-lineage \"sha256-abc123\" \"mlx-community/MiniMax-M2.7-8bit\""
    echo ""
    echo "  # Grant recipient access to view PII instance"
    echo "  ./scripts/openfga-tuple.sh grant-view-to-recipient \"sha256-abc123\" \"user:alice\""
    echo ""
    echo "  # Establish trust: recipient trusts model"
    echo "  ./scripts/openfga-tuple.sh grant-trust \"user:alice\" \"mlx-community/MiniMax-M2.7-8bit\""
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