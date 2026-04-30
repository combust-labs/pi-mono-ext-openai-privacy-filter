// SPDX-License-Identifier: Apache-2.0

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { env, pipeline } from '@huggingface/transformers';

const DEFAULT_MODELS_PATH = "~/.cache/huggingface/hub/"
const LOCAL_MODEL_PATH = process.env.PRIVACY_FILTER_MODEL_PATH || DEFAULT_MODELS_PATH;

env.allowRemoteModels = false;
env.localModelPath = LOCAL_MODEL_PATH;

const PRIVACY_FILTER_WEBGPU = process.env.PRIVACY_FILTER_WEBGPU === "true";

type AggregatedAnnotation = {
  entity_group: string,
  score: number,
  word: string,
}

export default function piiExtension(pi: ExtensionAPI) {

  let privacyPipeline: Awaited<ReturnType<typeof pipeline>> | null = null;

  const initPipeline = async () => {
    if (!privacyPipeline) {
      privacyPipeline = await pipeline(
        "token-classification",
        "openai/privacy-filter",
        PRIVACY_FILTER_WEBGPU
          ? { device: "webgpu", dtype: "q4" }
          : { dtype: "q4" }
      );
    }
    return privacyPipeline;
  };

  // // Detect and mask PII before sending to provider
  pi.on("before_agent_start", async (event, ctx) => {

    const text = event.prompt;
    if (!text || text.trim().length === 0) return;

    const classifier = await initPipeline();
    const results = await classifier(text, { aggregation_strategy: "simple" });

    if (results.length === 0) return;

    // Log detected PII types for transparency
    const piiTypes = [...new Set(results.map(e => e.entity_group))];
    ctx.ui.notify(
      `Detected PII: ${piiTypes.join(", ")} :: ${JSON.stringify(results)}`,
      "warning"
    );

    // Inject sanitization instructions
    const maskedText = maskPII(text, results);
    const injection =
      "\n\n[PRIVACY NOTICE] The user message may contain personally identifiable " +
      "information (PII). Be careful not to echo or log sensitive data like names, " +
      "emails, phone numbers, or addresses unless necessary for the task." +
      "\n\nIf the user shares credentials, API keys, or secrets, do not store or " +
      "repeat them. Treat such information as transient.";

    return {
      systemPrompt: event.systemPrompt + injection,
      prompt: injection,
    };
  });

  pi.on("context", async (event, ctx) => {
    const classifier = await initPipeline();
    for (let i=0; i<event.messages.length; i++) {
      if (event.messages[i].role === "user") {
        for (let j=0; j<event.messages[i].content.length; j++) {
          if (event.messages[i].content[j].type === "text")  {
            const results = await classifier(event.messages[i].content[j].text,
              { aggregation_strategy: "simple" });
            if (results.length > 0) {
              event.messages[i].content[j].text = maskPII(event.messages[i].content[j].text, results);
            }
          }
        }
      }
    }
    return { messages: event.messages };
  })

  // Block tool calls that might expose PII in logs
  // pi.on("tool_call", async (event, ctx) => {
  //   if (!isBashToolResult(event)) return;

  //   const bashEvent = event as ToolCallEvent<"bash", { command: string }>;
  //   const cmd = bashEvent.input.command;

  //   // Detect commands that might echo PII
  //   if (cmd.match(/grep.*[A-Za-z]+\.[A-Za-z]+|echo.*@/i)) {
  //     ctx.ui.notify(
  //       "Command may log sensitive data - review before execution",
  //       "warning"
  //     );
  //   }
  // });

  // Register command to check text for PII
  pi.registerCommand("check-pii", {
    description: "Check text for personally identifiable information",
    handler: async (args, ctx) => {
      if (!args) {
        ctx.ui.notify("Usage: /check-pii <text>", "warning");
        return;
      }
      const classifier = await initPipeline();
      const results = await classifier(args, { aggregation_strategy: "simple" });

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

// Mask PII in text by replacing with [<entity_group>: REDACTED]
function maskPII(text: string, pii: AggregatedAnnotation[]): string {
  // Sort by start position descending to replace from end (preserve positions)
  for (const entity of pii) {
    const placeholder = `[${entity.entity_group.toUpperCase()} REDACTED]`;
    text = text.replaceAll(entity.word, placeholder);
  }
  return text;
}
