# Privacy Filter Extension for pi-mono

<!-- SPDX-License-Identifier: Apache-2.0 -->

A PII (Personally Identifiable Information) detection and masking extension for [pi-mono](https://github.com/combust-labs/pi-mono), powered by OpenAI's Privacy Filter model via HuggingFace Transformers.js.

## Overview

This extension intercepts user prompts and message history, scans for sensitive data using the OpenAI Privacy Filter model running locally via HuggingFace Transformers.js, and injects guidance into the system prompt to ensure the agent handles PII responsibly.

All PII detection capabilities are derived directly from the [OpenAI Privacy Filter](https://huggingface.co/openai/privacy-filter) model. The extension acts as a bridge between the model and the pi-mono agent, providing:

- Token-classification based PII detection
- Configurable local model loading
- Context-aware message sanitization
- On-demand scanning via chat command

## Features

- **8 PII categories** (from the Privacy Filter model): names, emails, phone numbers, addresses, URLs, dates, account numbers, secrets
- **Local inference**: Model runs entirely on-device via WebGPU (Q4 quantization) or CPU fallback
- **Configurable model path**: Set `PRIVACY_FILTER_MODEL_PATH` to use a local model
- **Configurable device**: Toggle WebGPU acceleration via `PRIVACY_FILTER_WEBGPU`
- **Message sanitization**: Masks PII in conversation history
- **On-demand scanning**: `/check-pii <text>` command

## Installation

```bash
pi install git:https://github.com/combust-labs/pi-mono-ext-openai-privacy-filter
```

> **Important**: This extension requires installation on the target operating system due to native dependencies (WebGPU/wasm compute). Installing via npm in a cross-platform environment (e.g., macOS with a volume mounted in a Linux container) will not work correctly.

## Model Download

Before first use, download the [OpenAI Privacy Filter](https://huggingface.co/openai/privacy-filter) model to a local directory:

**Option 1 — Git clone (recommended)**:
```bash
git lfs install
git clone https://huggingface.co/openai/privacy-filter /path/to/model
```

> **Note**: Git LFS is required to clone the model. On macOS: `brew install git-lfs`. On Ubuntu/Debian: `apt install git-lfs`. Then run `git lfs install`.

**Option 2 — huggingface-cli**:
```bash
huggingface-cli download openai/privacy-filter /path/to/model --local-dir
```

> **Note**: The `hf download` command will not work correctly with the Transformers.js library. Use `git clone` or `huggingface-cli download --local-dir` instead.

Set the model path before running pi-mono:
```bash
PRIVACY_FILTER_MODEL_PATH=/path/to/model pi -e ./index.ts
```

### Model Configuration for pi-mono-docker

When running inside the [pi-mono-docker](https://github.com/combust-labs/pi-mono-docker) container, mount the local model directory using `--ppi-host-add-path` and pass the model path via `--ppi-pass-env`:

```bash
function ppi {
  "${HOME}/.local/bin/ppi" \
    --ppi-host-attach-models-json \
    --ppi-host-attach-agents \
    --ppi-host-attach-prompts \
    --ppi-pass-env "PRIVACY_FILTER_MODEL_PATH=/.pi/hf/models" \
    --ppi-host-add-path "${HOME}/dev/models/privacy-filter:/.pi/hf/models/openai/privacy-filter:ro" \
    "$@"
}
```

This mounts `${HOME}/dev/models/privacy-filter` (containing the cloned model files) to `/.pi/hf/models/openai/privacy-filter` inside the container. The extension then looks for the model at `/.pi/hf/models/openai/privacy-filter/config.json`.

See the [pi-mono-docker README](https://github.com/combust-labs/pi-mono-docker#ppi-execution-modes) for details on `--ppi-host-add-path` and `--ppi-pass-env`.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PRIVACY_FILTER_MODEL_PATH` | `~/.cache/huggingface/hub/` | Base local path for model lookup |
| `PRIVACY_FILTER_WEBGPU` | `false` | Enable WebGPU acceleration (`true`/`false`) |
| `OPENFGA_API_URL` | `http://localhost:28080` | OpenFGA REST API URL |
| `OPENFGA_STORE_ID` | `privacy-policies` | OpenFGA store ID |
| `OPENFGA_MODEL_ID` | `privacy-model` | OpenFGA authorization model ID |
| `OPENFGA_API_TOKEN` | _(empty)_ | Bearer token for OpenFGA authentication |

### WebGPU Note

WebGPU is **not supported** in the `pi-mono-docker` container and is **disabled by default**. To enable WebGPU acceleration on a supported host:

```bash
PRIVACY_FILTER_WEBGPU=true pi -e ./index.ts
```

## PII Categories

| Category | Description |
|----------|-------------|
| `account_number` | Bank accounts, credit cards |
| `private_address` | Physical addresses |
| `private_email` | Email addresses |
| `private_person` | Person names |
| `private_phone` | Phone numbers |
| `private_url` | URLs |
| `private_date` | Dates (birthdays, etc.) |
| `secret` | Passwords, API keys, tokens |

## OpenFGA Authorization (Optional)

The extension supports fine-grained authorization via [OpenFGA](https://openfga.dev/) to control which PII categories specific models can access. When OpenFGA is configured, the extension queries it before masking PII — allowing some categories to pass through if the model is authorized.

### Quick Start

1. **Start OpenFGA** via Docker:
```bash
docker run \
  --name pi-mono-privacy-filter-openfga \
  --restart unless-stopped \
  -p 28080:8080 \
  -p 3000:3000 \
  -e OPENFGA_LOG_LEVEL=debug \
  openfga/openfga:latest \
  run
```

2. **Initialize the store and authorization model**:
```bash
./scripts/openfga-init.sh
```

   This creates a store named `privacy-policies` and the authorization model. Copy the exported environment variables:
```bash
source /tmp/openfga_env.sh
```

3. **Grant a model access to a PII category**:
```bash
# Grant category-level access (model can view all emails)
./scripts/openfga-tuple.sh grant "mlx-community/MiniMax-M2.7-8bit" email

# Grant specific literal access (model can view a specific email)
./scripts/openfga-tuple.sh grant "mlx-community/MiniMax-M2.7-8bit" "sha256-3f2e8d7c4b1a"
```

4. **Run pi-mono with the extension**:
```bash
OPENFGA_API_URL=http://localhost:28080 \
OPENFGA_STORE_ID=<your-store-id> \
OPENFGA_MODEL_ID=<your-model-id> \
PRIVACY_FILTER_MODEL_PATH=/path/to/model \
pi -e ./index.ts
```

### Authorization Model (DSL)

To manually recreate the OpenFGA authorization model, use this DSL:

```python
model
  schema 1.1

type model_instance
  relations
    define can_view: [privacy_category]

type privacy_category
  relations
    define can_view: [model_instance]
```

Or JSON (use the `/stores/{store_id}/authorization-models` endpoint):
```json
{
  "schema_version": "1.1",
  "type_definitions": [
    {
      "type": "model_instance",
      "relations": {
        "can_view": {
          "this": {}
        }
      },
      "metadata": {
        "relations": {
          "can_view": {
            "directly_related_user_types": [
              { "type": "model_instance" }
            ]
          }
        }
      }
    },
    {
      "type": "privacy_category",
      "relations": {
        "can_view": {
          "this": {}
        }
      },
      "metadata": {
        "relations": {
          "can_view": {
            "directly_related_user_types": [
              { "type": "model_instance" }
            ]
          }
        }
      }
    }
  ]
}
```

### Tuple Examples

| Tuple | Meaning |
|-------|---------|
| `model_instance:mlx-community/MiniMax-M2.7-8bit can_view privacy_category:email` | Model can view all emails (category-level) |
| `model_instance:mlx-community/MiniMax-M2.7-8bit can_view privacy_category:sha256-<hash>` | Model can view the specific PII whose SHA256 hash is `<hash>` |
| `model_instance:mlx-community/MiniMax-M2.7-8bit can_view privacy_category:secret` | Model can view secrets (generally discouraged) |

### Fail-Closed Behavior

If OpenFGA is unreachable or returns an error, the extension **fail-closes** — all detected PII is masked. This ensures no PII leaks when the authorization server is unavailable.

### Security Notes

- **Raw PII literals are never sent to OpenFGA**. Specific values (e.g., `user@company.com`) are hashed with SHA256 before being used as object IDs. Only the hash appears in authorization tuples.
- The SHA256 hash is truncated to 40 hex characters (20 bytes) for readability while maintaining collision resistance.

### Helper Scripts

| Script | Description |
|--------|-------------|
| `scripts/openfga-init.sh` | Create OpenFGA store and authorization model |
| `scripts/openfga-tuple.sh` | Grant/revoke model access to categories or specific literals |

Usage:
```bash
# Initialize (one-time)
./scripts/openfga-init.sh

# Grant category access
./scripts/openfga-tuple.sh grant "model-id" email

# Revoke access
./scripts/openfga-tuple.sh revoke "model-id" email

# Check if a model has access to a category or literal
./scripts/openfga-tuple.sh check "model-id" email

# List current tuples
./scripts/openfga-tuple.sh list
./scripts/openfga-tuple.sh list "model-id"  # filter by model
```

### Troubleshooting

**OpenFGA connection refused**
```
Error: OpenFGA check failed: fetch failed: Connection refused
```
- Ensure OpenFGA is running: `docker ps | grep openfga`
- Check the API URL matches: `OPENFGA_API_URL=http://localhost:28080`

**Store not found (404)**
```
Error: OpenFGA check failed (404):
```
- Run `./scripts/openfga-init.sh` to create the store and model
- Verify `OPENFGA_STORE_ID` is set correctly

**All PII is being masked despite authorization**
- Check tuples: `./scripts/openfga-tuple.sh list "model-id"`
- Verify the model ID matches exactly (including version suffix if present)
- Ensure the object format is correct: `privacy_category:<category>` or `privacy_category:sha256-<hash>`

**OpenFGA returns error on write**
- If using authentication, ensure `OPENFGA_API_TOKEN` is set
- Check store ID and model ID are correct

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE) for details.
