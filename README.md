# Privacy Filter Extension for pi

A PII (Personally Identifiable Information) detection and masking extension for the [pi coding agent](https://github.com/mariozechner/pi-coding-agent).

## Overview

This extension intercepts user prompts and message history, scans for sensitive data using OpenAI's Privacy Filter model running locally via HuggingFace Transformers.js, and injects guidance into the system prompt to ensure the agent handles PII responsibly.

## Features

- **8 PII categories**: names, emails, phone numbers, addresses, URLs, dates, account numbers, secrets
- **Local inference**: Model runs entirely on-device via WebGPU (Q4 quantization)
- **Configurable model path**: Set `PRIVACY_FILTER_MODEL_PATH` to use a local model
- **Message sanitization**: Masks PII in conversation history
- **On-demand scanning**: `/check-pii <text>` command

## Installation

```bash
npm install
```

## Usage

```bash
pi -e ./index.ts
```

Or with a custom model path:

```bash
PRIVACY_FILTER_MODEL_PATH=/path/to/local/model pi -e ./index.ts
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PRIVACY_FILTER_MODEL_PATH` | `~/.cache/huggingface/hub/models--openai--privacy-filter` | Local path to model |

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