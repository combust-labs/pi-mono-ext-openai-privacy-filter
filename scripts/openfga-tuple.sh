#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
#
# OpenFGA Tuple Management Script
# Grant or revoke model access to PII categories or specific literals.
#
# Usage:
#   ./scripts/openfga-tuple.sh grant <model-id> <category|sha256-hash> [relation]
#   ./scripts/openfga-tuple.sh revoke <model-id> <category|sha256-hash> [relation]
#   ./scripts/openfga-tuple.sh list [model-id]
#
# Examples:
#   # Grant model access to all emails (category-level)
#   ./scripts/openfga-tuple.sh grant "mlx-community/MiniMax-M2.7-8bit" email
#
#   # Grant model access to a specific email (literal-level, hash provided)
#   ./scripts/openfga-tuple.sh grant "mlx-community/MiniMax-M2.7-8bit" "sha256-3f2e8d7c4b1a"
#
#   # Revoke model access to secrets
#   ./scripts/openfga-tuple.sh revoke "mlx-community/MiniMax-M2.7-8bit" secret
#
#   # List all tuples (or filter by model)
#   ./scripts/openfga-tuple.sh list
#   ./scripts/openfga-tuple.sh list "mlx-community/MiniMax-M2.7-8bit"
#

set -e

OPENFGA_API_URL="${OPENFGA_API_URL:-http://localhost:28080}"
STORE_ID="${OPENFGA_STORE_ID:-}"
MODEL_ID="${OPENFGA_MODEL_ID:-}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_action() { echo -e "${CYAN}[ACTION]${NC} $1"; }

usage() {
    echo "Usage: $0 <grant|revoke|list> [args]"
    echo ""
    echo "Commands:"
    echo "  grant <model-id> <category|sha256-hash> [relation]"
    echo "          Grant a model permission to view a PII category or specific literal"
    echo "  revoke <model-id> <category|sha256-hash> [relation]"
    echo "          Revoke a model's permission to view a PII category or specific literal"
    echo "  check <model-id> <category|sha256-hash> [relation]"
    echo "          Check if a model has a specific relation to a PII category or literal"
    echo "  list [model-id]"
    echo "          List all tuples (optionally filtered by model)"
    echo ""
    echo "Environment Variables:"
    echo "  OPENFGA_API_URL  (default: http://localhost:28080)"
    echo "  OPENFGA_STORE_ID (required)"
    echo "  OPENFGA_MODEL_ID (optional, for some deployments)"
    exit 1
}

check_config() {
    if [ -z "${STORE_ID}" ]; then
        log_error "OPENFGA_STORE_ID is not set"
        echo "  export OPENFGA_STORE_ID=<your-store-id>"
        exit 1
    fi
}

check_openfga() {
    if ! curl -sf "${OPENFGA_API_URL}/healthz" > /dev/null 2>&1; then
        log_error "OpenFGA is not reachable at ${OPENFGA_API_URL}"
        exit 1
    fi
}

# Build the object ID from the input
# If input starts with "sha256-", use it directly
# Otherwise, prefix with "privacy_category:"
build_object_id() {
    local input="$1"
    if [[ "${input}" == sha256-* ]]; then
        echo "privacy_category:${input}"
    else
        echo "privacy_category:${input}"
    fi
}

# Grant access
grant() {
    local model_id="$1"
    local target="$2"
    local relation="${3:-can_view}"
    local object_id
    object_id=$(build_object_id "${target}")

    log_action "Granting ${model_id} ${relation} on ${object_id}"

    local body="{\"writes\":{\"tuple_keys\":[{\"user\":\"model_instance:${model_id}\",\"relation\":\"${relation}\",\"object\":\"${object_id}\"}]}}"

    local response
    if response=$(curl -sf -X POST "${OPENFGA_API_URL}/stores/${STORE_ID}/write" \
        -H "Content-Type: application/json" \
        ${MODEL_ID:+-H "Authorization: Bearer ${OPENFGA_API_TOKEN:-}"} \
        -d "${body}"); then
        log_info "Access granted successfully"
    else
        log_error "Failed to grant access: ${response}"
        exit 1
    fi
}

# Revoke access
revoke() {
    local model_id="$1"
    local target="$2"
    local relation="${3:-can_view}"
    local object_id
    object_id=$(build_object_id "${target}")

    log_action "Revoking ${model_id} ${relation} on ${object_id}"

    local body="{\"deletes\":{\"tuple_keys\":[{\"user\":\"model_instance:${model_id}\",\"relation\":\"${relation}\",\"object\":\"${object_id}\"}]}}"

    local response
    if response=$(curl -sf -X POST "${OPENFGA_API_URL}/stores/${STORE_ID}/write" \
        -H "Content-Type: application/json" \
        ${MODEL_ID:+-H "Authorization: Bearer ${OPENFGA_API_TOKEN:-}"} \
        -d "${body}"); then
        log_info "Access revoked successfully"
    else
        log_error "Failed to revoke access: ${response}"
        exit 1
    fi
}

# List tuples
list_tuples() {
    local model_filter="$1"
    local url="${OPENFGA_API_URL}/stores/${STORE_ID}/read"

    if [ -n "${model_filter}" ]; then
        url="${url}?user=model_instance:${model_filter}"
    fi

    log_action "Fetching tuples from ${url}"

    local response
    response=$(curl -sf -X POST "${url}" \
        -H "Content-Type: application/json" \
        ${MODEL_ID:+-H "Authorization: Bearer ${OPENFGA_API_TOKEN:-}"})

    if [ -z "${response}" ]; then
        log_warn "No tuples found or error fetching tuples"
        return
    fi

    echo "${response}" | python3 -m json.tool 2>/dev/null || echo "${response}"
}

# Check if a tuple exists
check_tuple() {
    local model_id="$1"
    local target="$2"
    local relation="${3:-can_view}"
    local object_id
    object_id=$(build_object_id "${target}")

    log_action "Checking ${model_id} ${relation} on ${object_id}"

    local body="{\"tuple_key\":{\"user\":\"model_instance:${model_id}\",\"relation\":\"${relation}\",\"object\":\"${object_id}\"}}"

    local response
    if response=$(curl -sf -X POST "${OPENFGA_API_URL}/stores/${STORE_ID}/check" \
        -H "Content-Type: application/json" \
        ${MODEL_ID:+-H "Authorization: Bearer ${OPENFGA_API_TOKEN:-}"} \
        -d "${body}"); then
        local allowed
        allowed=$(echo "${response}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('allowed', False))" 2>/dev/null || echo "false")
        if [ "${allowed}" = "True" ] || [ "${allowed}" = "true" ]; then
            log_info "Tuple exists: ALLOWED"
            return 0
        else
            log_warn "Tuple does not exist: DENIED"
            return 1
        fi
    else
        log_error "Failed to check tuple: ${response}"
        return 1
    fi
}

main() {
    if [ $# -lt 1 ]; then
        usage
    fi

    check_openfga

    local command="$1"
    shift

    case "${command}" in
        grant)
            if [ $# -lt 2 ]; then
                log_error "grant requires <model-id> and <category|sha256-hash>"
                usage
            fi
            check_config
            grant "$1" "$2" "${3:-can_view}"
            ;;
        revoke)
            if [ $# -lt 2 ]; then
                log_error "revoke requires <model-id> and <category|sha256-hash>"
                usage
            fi
            check_config
            revoke "$1" "$2" "${3:-can_view}"
            ;;
        check)
            if [ $# -lt 2 ]; then
                log_error "check requires <model-id> and <category|sha256-hash>"
                usage
            fi
            check_config
            check_tuple "$1" "$2" "${3:-can_view}"
            ;;
        list)
            check_config
            list_tuples "$1"
            ;;
        help|--help|-h)
            usage
            ;;
        *)
            log_error "Unknown command: ${command}"
            usage
            ;;
    esac
}

main "$@"
