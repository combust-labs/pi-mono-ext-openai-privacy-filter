#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
#
# OpenFGA Tuple Management Script (v2 - with lineage and sharing)
# Grant or revoke model access to PII categories or specific literals.
#
# Usage:
#   # Viewing permissions (input direction)
#   ./scripts/openfga-tuple.sh grant-view <model-id> <pii-hash|category>
#   ./scripts/openfga-tuple.sh revoke-view <model-id> <pii-hash|category>
#   
#   # Sharing permissions (output direction)
#   ./scripts/openfga-tuple.sh grant-share <model-id> <pii-hash>
#   ./scripts/openfga-tuple.sh revoke-share <model-id> <pii-hash>
#   
#   # Lineage (PII originates from model)
#   ./scripts/openfga-tuple.sh set-lineage <pii-hash> <model-id>
#   ./scripts/openfga-tuple.sh remove-lineage <pii-hash> <model-id>
#   
#   # Recipient permissions
#   ./scripts/openfga-tuple.sh grant-view-to-recipient <pii-hash> <recipient-id>
#   ./scripts/openfga-tuple.sh revoke-view-from-recipient <pii-hash> <recipient-id>
#   
#   # Trust relationship
#   ./scripts/openfga-tuple.sh grant-trust <recipient-id> <model-id>
#   ./scripts/openfga-tuple.sh revoke-trust <recipient-id> <model-id>
#   
#   # Category definitions
#   ./scripts/openfga-tuple.sh define-category <category> <model-id>
#   ./scripts/openfga-tuple.sh undefine-category <category> <model-id>
#   
#   # Check commands
#   ./scripts/openfga-tuple.sh check <subject> <relation> <object>
#   ./scripts/openfga-tuple.sh list [filter-type] [filter-value]
#
# Examples:
#   # Grant model access to a specific PII (by hash)
#   ./scripts/openfga-tuple.sh grant-view "mlx-community/MiniMax-M2.7-8bit" "sha256-3f2e8d7c4b1a"
#
#   # Grant model sharing access to a PII instance
#   ./scripts/openfga-tuple.sh grant-share "mlx-community/MiniMax-M2.7-8bit" "sha256-3f2e8d7c4b1a"
#
#   # Set lineage: this PII originated from scanning-bot
#   ./scripts/openfga-tuple.sh set-lineage "sha256-3f2e8d7c4b1a" "scanning-bot"
#
#   # Allow alice to view this PII
#   ./scripts/openfga-tuple.sh grant-view-to-recipient "sha256-3f2e8d7c4b1a" "user:alice"
#
#   # Alice trusts outputs from scanning-bot
#   ./scripts/openfga-tuple.sh grant-trust "user:alice" "scanning-bot"
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
    echo "Usage: $0 <command> [args]"
    echo ""
    echo "Viewing permissions (input direction):"
    echo "  grant-view <model-id> <pii-hash|category>"
    echo "  revoke-view <model-id> <pii-hash|category>"
    echo ""
    echo "Sharing permissions (output direction):"
    echo "  grant-share <model-id> <pii-hash>"
    echo "  revoke-share <model-id> <pii-hash>"
    echo ""
    echo "Lineage (PII originates from model):"
    echo "  set-lineage <pii-hash> <model-id>"
    echo "  remove-lineage <pii-hash> <model-id>"
    echo ""
    echo "Recipient permissions:"
    echo "  grant-view-to-recipient <pii-hash> <recipient-id>"
    echo "  revoke-view-from-recipient <pii-hash> <recipient-id>"
    echo ""
    echo "Trust relationship:"
    echo "  grant-trust <recipient-id> <model-id>"
    echo "  revoke-trust <recipient-id> <model-id>"
    echo ""
    echo "Category definitions:"
    echo "  define-category <category> <model-id>"
    echo "  undefine-category <category> <model-id>"
    echo ""
    echo "Check and list:"
    echo "  check <subject> <relation> <object>"
    echo "  list [filter-type] [filter-value]"
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

# Build object ID based on input type
build_object_id() {
    local input="$1"
    local type="${2:-auto}"  # auto, pii_instance, category, recipient, model_instance
    
    case "${type}" in
        pii_instance)
            if [[ "${input}" == pii_instance:* ]]; then
                echo "${input}"
            else
                echo "pii_instance:${input}"
            fi
            ;;
        category)
            if [[ "${input}" == category:* ]]; then
                echo "${input}"
            else
                echo "category:${input}"
            fi
            ;;
        recipient)
            if [[ "${input}" == recipient:* ]]; then
                echo "${input}"
            else
                echo "recipient:${input}"
            fi
            ;;
        model_instance)
            if [[ "${input}" == model_instance:* ]]; then
                echo "${input}"
            else
                echo "model_instance:${input}"
            fi
            ;;
        auto|*)
            # Auto-detect from prefix
            if [[ "${input}" == pii_instance:* ]]; then
                echo "${input}"
            elif [[ "${input}" == category:* ]]; then
                echo "${input}"
            elif [[ "${input}" == recipient:* ]]; then
                echo "${input}"
            elif [[ "${input}" == model_instance:* ]]; then
                echo "${input}"
            elif [[ "${input}" == sha256-* ]]; then
                echo "pii_instance:${input}"
            else
                echo "category:${input}"
            fi
            ;;
    esac
}

# Build subject ID
build_subject_id() {
    local input="$1"
    local type="${2:-auto}"
    
    build_object_id "${input}" "${type}"
}

# Generic write tuple
write_tuple() {
    local subject="$1"
    local subject_type="$2"
    local relation="$3"
    local object="$4"
    local object_type="$5"
    
    local subject_id
    local object_id
    
    subject_id=$(build_subject_id "${subject}" "${subject_type}")
    object_id=$(build_object_id "${object}" "${object_type}")
    
    log_action "Writing: ${subject_id} --${relation}--> ${object_id}"
    
    local body="{\"writes\":{\"tuple_keys\":[{\"user\":\"${subject_id}\",\"relation\":\"${relation}\",\"object\":\"${object_id}\"}]}}"
    
    local response
    if response=$(curl -sf -X POST "${OPENFGA_API_URL}/stores/${STORE_ID}/write" \
        -H "Content-Type: application/json" \
        ${MODEL_ID:+-H "Authorization: Bearer ${OPENFGA_API_TOKEN:-}"} \
        -d "${body}"); then
        log_info "Tuple written successfully"
    else
        log_error "Failed to write tuple: ${response}"
        exit 1
    fi
}

# Generic delete tuple
delete_tuple() {
    local subject="$1"
    local subject_type="$2"
    local relation="$3"
    local object="$4"
    local object_type="$5"
    
    local subject_id
    local object_id
    
    subject_id=$(build_subject_id "${subject}" "${subject_type}")
    object_id=$(build_object_id "${object}" "${object_type}")
    
    log_action "Deleting: ${subject_id} --${relation}--> ${object_id}"
    
    local body="{\"deletes\":{\"tuple_keys\":[{\"user\":\"${subject_id}\",\"relation\":\"${relation}\",\"object\":\"${object_id}\"}]}}"
    
    local response
    if response=$(curl -sf -X POST "${OPENFGA_API_URL}/stores/${STORE_ID}/write" \
        -H "Content-Type: application/json" \
        ${MODEL_ID:+-H "Authorization: Bearer ${OPENFGA_API_TOKEN:-}"} \
        -d "${body}"); then
        log_info "Tuple deleted successfully"
    else
        log_error "Failed to delete tuple: ${response}"
        exit 1
    fi
}

# Grant viewing permission (model --can_view--> pii_instance or category)
grant_view() {
    local model_id="$1"
    local target="$2"
    
    write_tuple "${model_id}" "model_instance" "can_view" "${target}" "auto"
}

# Revoke viewing permission
revoke_view() {
    local model_id="$1"
    local target="$2"
    
    delete_tuple "${model_id}" "model_instance" "can_view" "${target}" "auto"
}

# Grant sharing permission (model --can_share--> pii_instance)
grant_share() {
    local model_id="$1"
    local pii_hash="$2"
    
    write_tuple "${model_id}" "model_instance" "can_share" "${pii_hash}" "pii_instance"
}

# Revoke sharing permission
revoke_share() {
    local model_id="$1"
    local pii_hash="$2"
    
    delete_tuple "${model_id}" "model_instance" "can_share" "${pii_hash}" "pii_instance"
}

# Set lineage (pii_instance --originates_from--> model_instance)
set_lineage() {
    local pii_hash="$1"
    local model_id="$2"
    
    write_tuple "${pii_hash}" "pii_instance" "originates_from" "${model_id}" "model_instance"
}

# Remove lineage
remove_lineage() {
    local pii_hash="$1"
    local model_id="$2"
    
    delete_tuple "${pii_hash}" "pii_instance" "originates_from" "${model_id}" "model_instance"
}

# Grant recipient view permission (pii_instance --can_view--> recipient)
grant_view_to_recipient() {
    local pii_hash="$1"
    local recipient_id="$2"
    
    write_tuple "${pii_hash}" "pii_instance" "can_view" "${recipient_id}" "recipient"
}

# Revoke recipient view permission
revoke_view_from_recipient() {
    local pii_hash="$1"
    local recipient_id="$2"
    
    delete_tuple "${pii_hash}" "pii_instance" "can_view" "${recipient_id}" "recipient"
}

# Grant trust (recipient --can_receive_from--> model_instance)
grant_trust() {
    local recipient_id="$1"
    local model_id="$2"
    
    write_tuple "${recipient_id}" "recipient" "can_receive_from" "${model_id}" "model_instance"
}

# Revoke trust
revoke_trust() {
    local recipient_id="$1"
    local model_id="$2"
    
    delete_tuple "${recipient_id}" "recipient" "can_receive_from" "${model_id}" "model_instance"
}

# Define category (category --defines--> model_instance)
define_category() {
    local category="$1"
    local model_id="$2"
    
    write_tuple "${category}" "category" "defines" "${model_id}" "model_instance"
}

# Undefine category
undefine_category() {
    local category="$1"
    local model_id="$2"
    
    delete_tuple "${category}" "category" "defines" "${model_id}" "model_instance"
}

# Check a tuple
check_tuple() {
    local subject="$1"
    local subject_type="$2"
    local relation="$3"
    local object="$4"
    local object_type="$5"
    
    local subject_id
    local object_id
    
    subject_id=$(build_subject_id "${subject}" "${subject_type}")
    object_id=$(build_object_id "${object}" "${object_type}")
    
    log_action "Checking: ${subject_id} --${relation}--> ${object_id}"
    
    local body="{\"tuple_key\":{\"user\":\"${subject_id}\",\"relation\":\"${relation}\",\"object\":\"${object_id}\"}}"
    
    local response
    if response=$(curl -sf -X POST "${OPENFGA_API_URL}/stores/${STORE_ID}/check" \
        -H "Content-Type: application/json" \
        ${MODEL_ID:+-H "Authorization: Bearer ${OPENFGA_API_TOKEN:-}"} \
        -d "${body}"); then
        local allowed
        allowed=$(echo "${response}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('allowed', False))" 2>/dev/null || echo "false")
        if [ "${allowed}" = "True" ] || [ "${allowed}" = "true" ]; then
            log_info "ALLOWED"
            return 0
        else
            log_warn "DENIED"
            return 1
        fi
    else
        log_error "Failed to check tuple: ${response}"
        return 1
    fi
}

# List tuples
list_tuples() {
    local filter_type="$1"  # all, model, pii, recipient, category
    local filter_value="$2"
    
    local url="${OPENFGA_API_URL}/stores/${STORE_ID}/read"
    
    case "${filter_type}" in
        model)
            url="${url}?user=model_instance:${filter_value}"
            ;;
        pii)
            url="${url}?object=pii_instance:${filter_value}"
            ;;
        recipient)
            url="${url}?object=recipient:${filter_value}"
            ;;
        category)
            url="${url}?object=category:${filter_value}"
            ;;
        *)
            # List all
            ;;
    esac
    
    log_action "Fetching tuples from ${url}"
    
    local response
    response=$(curl -sf -X GET "${url}" \
        -H "Content-Type: application/json" \
        ${MODEL_ID:+-H "Authorization: Bearer ${OPENFGA_API_TOKEN:-}"} \
        -H "Accept: application/json")
    
    if [ -z "${response}" ]; then
        log_warn "No tuples found or error fetching tuples"
        return
    fi
    
    echo "${response}" | python3 -m json.tool 2>/dev/null || echo "${response}"
}

main() {
    if [ $# -lt 1 ]; then
        usage
    fi
    
    check_openfga
    
    local command="$1"
    shift
    
    case "${command}" in
        # Viewing commands
        grant-view)
            if [ $# -lt 2 ]; then
                log_error "grant-view requires <model-id> and <pii-hash|category>"
                usage
            fi
            check_config
            grant_view "$1" "$2"
            ;;
        revoke-view)
            if [ $# -lt 2 ]; then
                log_error "revoke-view requires <model-id> and <pii-hash|category>"
                usage
            fi
            check_config
            revoke_view "$1" "$2"
            ;;
        
        # Sharing commands
        grant-share)
            if [ $# -lt 2 ]; then
                log_error "grant-share requires <model-id> and <pii-hash>"
                usage
            fi
            check_config
            grant_share "$1" "$2"
            ;;
        revoke-share)
            if [ $# -lt 2 ]; then
                log_error "revoke-share requires <model-id> and <pii-hash>"
                usage
            fi
            check_config
            revoke_share "$1" "$2"
            ;;
        
        # Lineage commands
        set-lineage)
            if [ $# -lt 2 ]; then
                log_error "set-lineage requires <pii-hash> and <model-id>"
                usage
            fi
            check_config
            set_lineage "$1" "$2"
            ;;
        remove-lineage)
            if [ $# -lt 2 ]; then
                log_error "remove-lineage requires <pii-hash> and <model-id>"
                usage
            fi
            check_config
            remove_lineage "$1" "$2"
            ;;
        
        # Recipient commands
        grant-view-to-recipient)
            if [ $# -lt 2 ]; then
                log_error "grant-view-to-recipient requires <pii-hash> and <recipient-id>"
                usage
            fi
            check_config
            grant_view_to_recipient "$1" "$2"
            ;;
        revoke-view-from-recipient)
            if [ $# -lt 2 ]; then
                log_error "revoke-view-from-recipient requires <pii-hash> and <recipient-id>"
                usage
            fi
            check_config
            revoke_view_from_recipient "$1" "$2"
            ;;
        
        # Trust commands
        grant-trust)
            if [ $# -lt 2 ]; then
                log_error "grant-trust requires <recipient-id> and <model-id>"
                usage
            fi
            check_config
            grant_trust "$1" "$2"
            ;;
        revoke-trust)
            if [ $# -lt 2 ]; then
                log_error "revoke-trust requires <recipient-id> and <model-id>"
                usage
            fi
            check_config
            revoke_trust "$1" "$2"
            ;;
        
        # Category commands
        define-category)
            if [ $# -lt 2 ]; then
                log_error "define-category requires <category> and <model-id>"
                usage
            fi
            check_config
            define_category "$1" "$2"
            ;;
        undefine-category)
            if [ $# -lt 2 ]; then
                log_error "undefine-category requires <category> and <model-id>"
                usage
            fi
            check_config
            undefine_category "$1" "$2"
            ;;
        
        # Check command
        check)
            if [ $# -lt 3 ]; then
                log_error "check requires <subject>, <relation>, and <object>"
                usage
            fi
            check_config
            check_tuple "$1" "auto" "$2" "$3" "auto"
            ;;
        
        # List command
        list)
            check_config
            list_tuples "$1" "$2"
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