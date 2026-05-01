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

Before first use, download the OpenAI Privacy Filter model to a local directory:

**Option 1 — Git clone (recommended)**:
```bash
git clone https://huggingface.co/openai/privacy-filter /path/to/model
```

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

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE) for details.
