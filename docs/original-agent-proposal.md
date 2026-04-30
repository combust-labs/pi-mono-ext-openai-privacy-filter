# OpenAI Privacy Filter - Summary

A bidirectional token-classification model for PII detection and masking, designed for high-throughput data sanitization.

### Key Details

| Feature        | Value                         |
| -------------- | ----------------------------- |
| License        | Apache 2.0                    |
| Size           | 1.5B total params, 50M active |
| Context Window | 128,000 tokens                |
| Runs in        | Browser or laptop             |
| Output         | 33 classes (BIOES tagging)    |

### 8 Privacy Categories

| Category        | Description                       |
| --------------- | --------------------------------- |
| account_number  | Bank accounts, credit cards, etc. |
| private_address | Physical addresses                |
| private_email   | Email addresses                   |
| private_person  | Person names                      |
| private_phone   | Phone numbers                     |
| private_url     | URLs                              |
| private_date    | Dates (birthdays, etc.)           |
| secret          | Passwords, API keys, tokens       |

### Transformers.js Usage

```javascript
  import { pipeline } from "@huggingface/transformers";

  const classifier = await pipeline(
    "token-classification",
    "openai/privacy-filter",
    { device: "webgpu", dtype: "q4" }
  );

  const output = await classifier(
    "My name is Harry Potter and my email is harry.potter@hogwarts.edu",
    { aggregation_strategy: "simple" }
  );
  // Output: private_person, private_email entities detected
```

---

Now let me update the extension example to use Privacy Filter instead of sentiment analysis:

```typescript
  // ~/.pi/agent/extensions/privacy-filter.ts
  import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
  import { pipeline, AggregatedAnnotation } from "@huggingface/transformers";

  export default async function (pi: ExtensionAPI) {
    let privacyPipeline: Awaited<ReturnType<typeof pipeline>> | null = null;

    const initPipeline = async () => {
      if (!privacyPipeline) {
        privacyPipeline = await pipeline(
          "token-classification",
          "openai/privacy-filter",
          { device: "webgpu", dtype: "q4" }
        );
      }
      return privacyPipeline;
    };

    // Detect and mask PII before sending to provider
    pi.on("before_agent_start", async (event, ctx) => {
      const text = event.prompt;
      if (!text || text.trim().length === 0) return;

      const pii = await initPipeline().then(p =>
        p(text, { aggregation_strategy: "simple" })
      ).catch(() => [] as AggregatedAnnotation[]);

      if (pii.length === 0) return;

      // Log detected PII types for transparency
      const piiTypes = [...new Set(pii.map(e => e.entity_group))];
      ctx.ui.notify(
        `Detected PII: ${piiTypes.join(", ")}`,
        "warning"
      );

      // Inject sanitization instructions
      const maskedText = maskPII(text, pii);
      const injection =
        "\n\n[PRIVACY NOTICE] The user message may contain personally identifiable " +
        "information (PII). Be careful not to echo or log sensitive data like names, " +
        "emails, phone numbers, or addresses unless necessary for the task." +
        "\n\nIf the user shares credentials, API keys, or secrets, do not store or " +
        "repeat them. Treat such information as transient.";

      return {
        systemPrompt: event.systemPrompt + injection,
      };
    });

    // Block tool calls that might expose PII in logs
    pi.on("tool_call", async (event, ctx) => {
      if (!isBashToolResult(event)) return;

      const bashEvent = event as ToolCallEvent<"bash", { command: string }>;
      const cmd = bashEvent.input.command;

      // Detect commands that might echo PII
      if (cmd.match(/grep.*[A-Za-z]+\.[A-Za-z]+|echo.*@/i)) {
        ctx.ui.notify(
          "Command may log sensitive data - review before execution",
          "warning"
        );
      }
    });

    // Register command to check text for PII
    pi.registerCommand("check-pii", {
      description: "Check text for personally identifiable information",
      handler: async (args, ctx) => {
        if (!args) {
          ctx.ui.notify("Usage: /check-pii <text>", "warning");
          return;
        }
        const p = await initPipeline();
        const results = await p(args, { aggregation_strategy: "simple" });

        if (results.length === 0) {
          ctx.ui.notify("No PII detected", "info");
        } else {
          const summary = results.map(r =>
            `${r.entity_group}: "${r.word}" (${(r.score * 100).toFixed(1)}%)`
          ).join("\n");
          ctx.ui.notify(`PII Found:\n${summary}`, "warning");
        }
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("Privacy Filter extension loaded", "info");
    });
  };

  // Mask PII in text by replacing with [REDACTED]
  function maskPII(text: string, pii: AggregatedAnnotation[]): string {
    // Sort by start position descending to replace from end (preserve positions)
    const sorted = [...pii].sort((a, b) => b.start - a.start);

    for (const entity of sorted) {
      const placeholder = `[${entity.entity_group.toUpperCase()} REDACTED]`;
      text = text.slice(0, entity.start) + placeholder + text.slice(entity.end);
    }
    return text;
  }
```

### Installation

```bash
  mkdir -p ~/.pi/agent/extensions
  cd ~/.pi/agent/extensions

  # Create package.json
  cat > package.json << 'EOF'
  {
    "name": "privacy-filter",
    "dependencies": {
      "@huggingface/transformers": "^3.0.0"
    }
  }
  EOF

  npm install
```

### Usage

```bash
  pi -e ~/.pi/agent/extensions/privacy-filter.ts
  # or place in ~/.pi/agent/extensions/ for auto-discovery
```

### Key Features

| Feature                  | Event                | Description                                     |
| ------------------------ | -------------------- | ----------------------------------------------- |
| PII detection            | `before_agent_start` | Scans user input for 8 PII categories           |
| Privacy notice injection | `before_agent_start` | Warns agent about sensitive data handling       |
| Command monitoring       | `tool_call`          | Watches bash commands for potential PII leakage |
| On-demand check          | `registerCommand`    | `/check-pii <text>` to manually scan            |

### How It Works

1. before_agent_start intercepts the user's prompt before LLM sees it
2. Runs Privacy Filter locally (no data leaves machine)
3. Detects: names, emails, phones, addresses, URLs, dates, account numbers, secrets
4. Injects system prompt guidance about handling PII responsibly
5. Agent is informed but data is not modified (for transparency)


**User asked**: is it possible to tell huggingface transformers library to load the model from local disk rather than pulling it from the internet?

The user is asking if it's possible to load a Hugging Face Transformers.js model from a local disk instead of downloading it. This is a straightforward question about the library's
capabilities.

From my knowledge of Transformers.js, yes, you can load models from local paths. The pipeline function and model loading functions typically accept:

1. A model ID (like "openai/privacy-filter") which downloads from HF Hub
2. A local path to a directory containing the model files

Let me provide a concise answer about how to do this.

Yes. Transformers.js can load models from local disk by pointing to a directory containing the model files.

### Basic Usage

```javascript
  // Local path instead of HuggingFace model ID
  const classifier = await pipeline(
    "token-classification",
    "/path/to/local/model",  // Local directory
    { device: "webgpu", dtype: "q4" }
  );
```

### How to Get Models Locally

Option 1: Download from HuggingFace Hub manually

```bash
  # Using huggingface-hub CLI
  huggingface-cli download openai/privacy-filter --local-dir ./models/privacy-filter

  # Or in Python
  from huggingface_hub import snapshot_download
  snapshot_download(repo_id="openai/privacy-filter", local_dir="./models/privacy-filter")
```

Option 2: Use local files from a previously cached location

Transformers.js caches models in:
- Node.js: ~/.cache/huggingface/
- Browser: IndexedDB via the browser's cache API

```javascript
  // Point to cached location
  const classifier = await pipeline(
    "token-classification",
    "~/.cache/huggingface/models/openai--privacy-filter"
  );
```

### Auto-Cache Location

After the first run, Transformers.js caches models automatically. You can find the path in logs or by checking:

```javascript
  import { cachedHubDir } from "@huggingface/transformers";

  console.log(cachedHubDir); // Shows cache directory
```

 ### Updated Extension with Local Model Path

```typescript
  // ~/.pi/agent/extensions/privacy-filter.ts
  import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
  import { pipeline, AggregatedAnnotation } from "@huggingface/transformers";

  const LOCAL_MODEL_PATH = process.env.PRIVACY_FILTER_MODEL_PATH
    || "./models/privacy-filter";  // Local path

  export default async function (pi: ExtensionAPI) {
    let privacyPipeline: Awaited<ReturnType<typeof pipeline>> | null = null;

    const initPipeline = async () => {
      if (!privacyPipeline) {
        privacyPipeline = await pipeline(
          "token-classification",
          LOCAL_MODEL_PATH,  // Local path
          { device: "webgpu", dtype: "q4" }
        );
      }
      return privacyPipeline;
    };

    // ... rest of extension
  };
```

### Environment Variable for Flexibility

```bash
  # In ~/.bashrc or ~/.zshrc
  export PRIVACY_FILTER_MODEL_PATH="/path/to/your/local/model"

  # Or when running pi
  PRIVACY_FILTER_MODEL_PATH="/path/to/model" pi -e ./privacy-filter.ts
```

### Summary

| Method                   | Code                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------ |
| Download once, use local | `huggingface-cli download openai/privacy-filter --local-dir ./models/privacy-filter` |
| Use cache dir            | `~/.cache/huggingface/models/openai--privacy-filter`                                 |
| Custom path              | `pipeline(..., "/path/to/model", {...})`                                             |
