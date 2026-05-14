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
- **Authorization-based sharing control** (output direction) with lineage tracking

### Architecture

OpenFGA communication is handled by the upstream [@openfga/sdk](https://github.com/openfga/js-sdk) with a privacy-preserving wrapper (`src/openfga-sdk-wrapper.ts`) that:

- **Never sends raw PII literals to OpenFGA** — values are SHA256-hashed before use
- Applies project ID conventions (`model_instance:`, `pii_instance:`, `recipient:`, `category:`)
- Composes `checkShare()` with a 4-step authorization sequence
- Maps SDK errors to the project's custom error message format

The `openfga.ts` file at the project root is a re-export facade — all application code imports from it. Tests inject mocks via `setOpenFGAClient()`.

## Features

- **8 PII categories** (from the Privacy Filter model): names, emails, phone numbers, addresses, URLs, dates, account numbers, secrets
- **Local inference**: Model runs entirely on-device via WebGPU (Q4 quantization) or CPU fallback
- **Configurable model path**: Set `PRIVACY_FILTER_MODEL_PATH` to use a local model
- **Configurable device**: Toggle WebGPU acceleration via `PRIVACY_FILTER_WEBGPU`
- **Message sanitization**: Masks PII in conversation history
- **On-demand scanning**: `/check-pii <text>` — detect and list PII in text without masking
- **Authorization inspection**: `/check-pii-auth <text>` — detect PII and show per-entity ALLOWED/MASKED status based on OpenFGA policy
- **Access dry-run**: `/check-pii-access <model-id> <category|sha256-hash>` — query OpenFGA directly to check if a model can view a category or literal
- **Sharing authorization**: Control which models can share PII to which recipients with lineage verification
  - **Output direction**: `message_end` event handler intercepts model responses before delivery to user
  - **Tool output**: `tool_result` event handler applies sharing checks to tool execution results

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
| `OPENFGA_API_URL` | _(required)_ | OpenFGA REST API URL. In the harness: `http://agent-openfga:8080`. On host/CI: use testcontainers (auto-detected) or set explicitly. |
| `OPENFGA_STORE_ID` | _(required)_ | OpenFGA store ID (ULID). Created automatically if not provided. |
| `OPENFGA_MODEL_ID` | _(required)_ | OpenFGA authorization model ID (ULID). Created automatically if not provided. |
| `OPENFGA_API_TOKEN` | _(empty)_ | Bearer token for OpenFGA authentication |
| `OPENFGA_CONTAINER_IMAGE` | `docker.io/openfga/openfga:<latest-release>` | Docker image for testcontainers (integration tests only). Override to pin a specific version. |
| `PRIVACY_FILTER_RECIPIENT_ID` | _(empty)_ | Recipient ID for sharing checks (e.g., `user:alice`) |
| `PRIVACY_FILTER_SHARING_ENABLED` | `false` | Enable sharing authorization checks (`true`/`false`) |
| `METRICS_ENABLED` | _(empty)_ | Enable OTLP/Prometheus metrics push (`true`) — requires an endpoint to be set |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | _(empty)_ | OTLP HTTP endpoint for metrics (e.g. `http://collector:4318/v1/metrics`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | _(empty)_ | Fallback OTLP endpoint if `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` is not set |
| `PUSHGATEWAY_URL` | _(empty)_ | Prometheus Pushgateway URL (e.g. `http://pushgateway:9091`) — auto-detected by `/metrics` path |
| `METRICS_JOB` | `pii-extension` | Job name used when pushing to Pushgateway |
| `METRICS_PUSH_INTERVAL_MS` | `30000` | Interval between metric pushes in milliseconds |

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

### Chat Commands

| Command | Description |
|---------|-------------|
| `/check-pii <text>` | Scan text for PII — shows detected entities and categories (no masking, no auth check) |
| `/check-pii-auth <text>` | Scan text for PII and show per-entity authorization result (ALLOWED via category-level, ALLOWED via literal-level, or MASKED) — requires OpenFGA |
| `/check-pii-access <model-id> <category>` | Dry-run: query OpenFGA directly to check if `<model-id>` can view `<category>` (e.g. `private_email`) or a specific literal (sha256 hash) — requires OpenFGA |

### Metrics

When `METRICS_ENABLED=true` and an OTLP or Pushgateway endpoint is configured, the extension pushes metrics to an observability backend:

| Metric | Type | Description |
|--------|------|-------------|
| `pii_entities_detected` | counter | PII entities found per prompt |
| `auth_decisions_allowed` | counter | Category or literal checks that returned allowed (labeled by level, model, category) |
| `auth_decisions_denied` | counter | Category or literal checks that returned denied (labeled by level, model, category) |
| `auth_errors` | counter | OpenFGA check() calls that threw (labeled by model, category) |
| `fail_closed_events` | counter | Invocations where all categories were masked due to OpenFGA being unreachable (labeled by reason, model) |
| `openfga_check_duration_ms` | histogram | Latency of each OpenFGA check call |

Push to an **OTEL Collector** (e.g. Grafana, Datadog, Honeycomb):
```bash
METRICS_ENABLED=true \
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://collector:4318/v1/metrics \
pi -e ./index.ts
```

Push to a **Prometheus Pushgateway** (e.g. Prometheus + Grafana):
```bash
METRICS_ENABLED=true \
PUSHGATEWAY_URL=http://pushgateway:9091 \
METRICS_JOB=pii-extension \
pi -e ./index.ts
```

Metrics are pushed every 30 seconds by default (configurable via `METRICS_PUSH_INTERVAL_MS`).

### Tracing

When `OTEL_EXPORTER_OTLP_ENDPOINT` is configured, the extension sends distributed traces for PII authorization checks to an OpenTelemetry collector. This provides visibility into the authorization flow without exposing any PII data.

**Trace spans include**:
- `pii.input_check` — Input direction checks (model viewing PII)
- `pii.output_check` — Output direction checks (model sharing PII to recipients)

**Span attributes** (NO PII values ever exposed):
| Attribute | Description |
|-----------|-------------|
| `pii.direction` | `input` or `output` |
| `pii.model_id` | The model ID performing the check |
| `pii.entity_count` | Number of PII entities detected |
| `pii.categories` | Comma-separated category names (no values) |
| `pii.result` | `allowed` or `denied` |
| `pii.denied_count` | Number of entities that were denied |
| `pii.openfga_available` | Whether OpenFGA was reachable |
| `pii.check_duration_ms` | Duration of the check |
| `pii.recipient_id` | Recipient ID (output checks only) |
| `pii.lineage_valid` | Whether lineage check passed (output checks) |
| `pii.recipient_trust_valid` | Whether recipient trusts model (output checks) |

**Important**: No PII values (entity words, hashes, or content) are ever included in traces. Only authorization metadata is recorded.

Send traces to an **OTEL Collector**:
```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318/v1/traces \
OTEL_SERVICE_NAME=pi-privacy-filter \
pi -e ./index.ts
```

## OpenFGA Authorization

The extension supports fine-grained authorization via [OpenFGA](https://openfga.dev/) to control:

1. **Input direction**: Which PII categories/literals a model can **view** (input to the model)
2. **Output direction**: Which PII a model can **share** to which recipients (output from the model)

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

   This creates a store named `privacy-policies` and the authorization model (v2). Copy the exported environment variables:
```bash
source /tmp/openfga_env.sh
```

3. **Grant a model access to a PII category** (input direction):
```bash
# Grant category-level access (model can view all emails)
./scripts/openfga-tuple.sh grant-view "mlx-community/MiniMax-M2.7-8bit" private_email
```

4. **Set up sharing authorization** (output direction):
```bash
# Grant model sharing access to a specific PII instance
./scripts/openfga-tuple.sh grant-share "mlx-community/MiniMax-M2.7-8bit" "sha256-abc123"

# Set lineage (this PII originated from the model)
./scripts/openfga-tuple.sh set-lineage "sha256-abc123" "mlx-community/MiniMax-M2.7-8bit"

# Grant recipient access to view this PII
./scripts/openfga-tuple.sh grant-view-to-recipient "sha256-abc123" "user:alice"

# Establish trust (recipient trusts this model)
./scripts/openfga-tuple.sh grant-trust "user:alice" "mlx-community/MiniMax-M2.7-8bit"
```

5. **Run pi-mono with the extension**:
```bash
OPENFGA_API_URL=http://localhost:28080 \
OPENFGA_STORE_ID=<your-store-id> \
OPENFGA_MODEL_ID=<your-model-id> \
PRIVACY_FILTER_MODEL_PATH=/path/to/model \
pi -e ./index.ts
```

### Authorization Model Types

The v2 authorization model defines four types:

| Type | Description |
|------|-------------|
| `model_instance` | An AI model or agent |
| `pii_instance` | A specific PII occurrence (identified by SHA256 hash of the literal) |
| `category` | A PII category (e.g., `private_email`, `private_phone`) |
| `recipient` | A user, harness, or agent that can receive PII |

### Key Relations

**Input Direction (Viewing)**:
| Relation | From | To | Meaning |
|----------|------|-----|---------|
| `can_view` | `model_instance` | `pii_instance` or `category` | Model can view this PII |
| `can_view` | `recipient` | `pii_instance` | Recipient can view this PII |

**Output Direction (Sharing)**:
| Relation | From | To | Meaning |
|----------|------|-----|---------|
| `can_share` | `model_instance` | `pii_instance` | Model is authorized to share this PII |
| `lineage` | `pii_instance` | `model_instance` | This PII was created by/through this model |
| `can_receive_from` | `recipient` | `model_instance` | Recipient trusts this model |
| `defines` | `category` | `model_instance` | Category defines which models produce it |

### Sharing Authorization Flow

For a model to successfully share PII to a recipient, all four checks must pass:

```
1. model --can_share--> pii        (model is authorized to share this PII)
2. pii --lineage--> model          (PII originated from this model)
3. pii --can_view--> recipient     (recipient is allowed to view this PII)
4. recipient --can_receive_from--> model  (recipient trusts this model)
```

### Tuple Examples

**Input Direction (Viewing)**:
| Tuple | Meaning |
|-------|---------|
| `model_instance:mlx-community/MiniMax-M2.7-8bit can_view category:private_email` | Model can view all emails (category-level) |
| `model_instance:mlx-community/MiniMax-M2.7-8bit can_view pii_instance:sha256-<hash>` | Model can view the specific PII instance |
| `model_instance:mlx-community/MiniMax-M2.7-8bit can_view pii_instance:sha256-<hash>` | Model can view a specific literal by hash |

**Output Direction (Sharing)**:
| Tuple | Meaning |
|-------|---------|
| `model_instance:support-bot can_share pii_instance:sha256-<hash>` | Model is authorized to share this PII |
| `pii_instance:sha256-<hash> lineage model_instance:support-bot` | This PII originated from this model (lineage) |
| `recipient:alice can_view pii_instance:sha256-<hash>` | Recipient alice can view this PII |
| `recipient:alice can_receive_from model_instance:support-bot` | Alice trusts outputs from support-bot |

**Category Definitions**:
| Tuple | Meaning |
|-------|---------|
| `category:private_email defines model_instance:scanning-bot` | The email category is defined/produced by scanning-bot |

### Environment Variables for Sharing

| Variable | Description |
|----------|-------------|
| `PRIVACY_FILTER_RECIPIENT_ID` | Current recipient for sharing checks (e.g., `user:alice`) |
| `PRIVACY_FILTER_SHARING_ENABLED` | Set to `true` to enable output direction sharing checks |

When `PRIVACY_FILTER_SHARING_ENABLED=true`:
- The extension checks if PII can be **shared** to `PRIVACY_FILTER_RECIPIENT_ID`
- If not enabled, only **viewing** (input) checks are performed

### Fail-Closed Behavior

If OpenFGA is unreachable or returns an error, the extension **fail-closes** — all detected PII is masked. This ensures no PII leaks when the authorization server is unavailable.

### Security Notes

- **Raw PII literals are never sent to OpenFGA**. Specific values (e.g., `user@company.com`) are hashed with SHA256 before being used as object IDs. Only the hash appears in authorization tuples.
- The SHA256 hash is truncated to 40 hex characters (20 bytes) for readability while maintaining collision resistance.

### Helper Scripts

| Script | Description |
|--------|-------------|
| `scripts/openfga-init.sh` | Create OpenFGA store and authorization model (v2) |
| `scripts/openfga-tuple.sh` | Grant/revoke access to categories, literals, or manage sharing tuples |

**Viewing commands**:
```bash
./scripts/openfga-tuple.sh grant-view <model-id> <category>
./scripts/openfga-tuple.sh revoke-view <model-id> <category>
```

**Sharing commands**:
```bash
./scripts/openfga-tuple.sh grant-share <model-id> <pii-hash>
./scripts/openfga-tuple.sh revoke-share <model-id> <pii-hash>
./scripts/openfga-tuple.sh set-lineage <pii-hash> <model-id>
./scripts/openfga-tuple.sh remove-lineage <pii-hash> <model-id>
```

**Recipient commands**:
```bash
./scripts/openfga-tuple.sh grant-view-to-recipient <pii-hash> <recipient-id>
./scripts/openfga-tuple.sh revoke-view-from-recipient <pii-hash> <recipient-id>
```

**Trust commands**:
```bash
./scripts/openfga-tuple.sh grant-trust <recipient-id> <model-id>
./scripts/openfga-tuple.sh revoke-trust <recipient-id> <model-id>
```

**Category commands**:
```bash
./scripts/openfga-tuple.sh define-category <category> <model-id>
./scripts/openfga-tuple.sh undefine-category <category> <model-id>
```

**Check and list**:
```bash
./scripts/openfga-tuple.sh check <subject> <relation> <object>
./scripts/openfga-tuple.sh list [filter-type] [filter-value]
```

### Troubleshooting

**OpenFGA connection refused**
```
Error: OpenFGA check failed: fetch failed: Connection refused
```
- Ensure OpenFGA is running: `docker ps | grep openfga`
- Check that `OPENFGA_API_URL` is set correctly

**Store not found (404)**
```
Error: OpenFGA check failed (404):
```
- Run `./scripts/openfga-init.sh` to create the store and model
- Verify `OPENFGA_STORE_ID` is set correctly and is a valid ULID

**All PII is being masked despite authorization**
- Use `/check-pii-access <model-id> <category>` from the chat to verify directly
- Or check tuples: `./scripts/openfga-tuple.sh list`
- Verify the model ID matches exactly (including version suffix if present)
- Ensure the object format is correct: `category:<category>` or `pii_instance:sha256-<hash>`

**Sharing authorization failing**
- Verify all four checks pass (model_can_share, lineage_valid, recipient_can_view, recipient_trusts)
- Use `./scripts/openfga-tuple.sh check <subject> <relation> <object>` to debug individual tuples
- Ensure `PRIVACY_FILTER_SHARING_ENABLED=true` is set
- Ensure `PRIVACY_FILTER_RECIPIENT_ID` is set to the correct recipient

**OpenFGA returns error on write**
- If using authentication, ensure `OPENFGA_API_TOKEN` is set
- Check store ID and model ID are correct

**Tests fail with `OPENFGA_API_URL env var is required for tests`**
- Unit tests require `OPENFGA_API_URL` to be set at load time — they throw if absent
- The test harness provides it automatically at `http://agent-openfga:8080`
- On the host or in CI: run integration tests separately with `OPENFGA_INTEGRATION_TEST=true npm test` — testcontainers handles the URL automatically

## Testing

### Unit Tests

Unit tests use [nock](https://github.com/nock/nock) to mock HTTP responses — no real OpenFGA server is needed. They are run with:

```bash
npm test
```

### Integration Tests

`OPENFGA_INTEGRATION_TEST=true npm test` — runs all 207 tests (unit + integration) with no manual configuration needed. Testcontainers auto-detects Docker and spins up a temporary OpenFGA container on a random port. The harness path uses `OPENFGA_API_URL` from the environment automatically.

Two environments are supported:

| Environment | How |
|---|---|
| Inside the harness container | Uses `agent-openfga` Docker DNS name. `OPENFGA_API_URL` is provided by the harness. |
| On the host / GitHub CI | Uses [testcontainers](https://node.testcontainers.org/) to spin up `openfga/openfga` on a random host port. Docker is pre-installed on ubuntu-latest GitHub Actions runners. |

In both cases the `OPENFGA_API_URL`, `OPENFGA_STORE_ID`, and `OPENFGA_MODEL_ID` env vars are set from the live server so the SDK wrapper picks them up automatically.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE) for details.
