// SPDX-License-Identifier: Apache-2.0

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { env, pipeline } from '@huggingface/transformers';
import { Box, Text } from '@mariozechner/pi-tui';

import { getOpenFGAClient } from './openfga.ts';
import { buildDeniedCategoriesSet, buildSharingDeniedCategoriesSet, isSharingEnabled, getRecipientId, type AggregatedAnnotation } from './privacy-auth.ts';
import { logHealthCheckFailed, logAuthError } from './privacy-logger.ts';
import { recordPiiDetected, recordFailClosed, startMetrics } from './privacy-metrics.ts';

const DEFAULT_MODELS_PATH = "~/.cache/huggingface/hub/"
const LOCAL_MODEL_PATH = process.env.PRIVACY_FILTER_MODEL_PATH || DEFAULT_MODELS_PATH;

env.allowRemoteModels = false;
env.localModelPath = LOCAL_MODEL_PATH;

const PRIVACY_FILTER_WEBGPU = process.env.PRIVACY_FILTER_WEBGPU === "true";

type PIIAlertData = {
  piiTypes: string[];
  piiLines: string[];
}

export default function piiExtension(pi: ExtensionAPI) {

  let privacyPipeline: Awaited<ReturnType<typeof pipeline>> | null = null;

  // Register inline message renderer for PII alerts
  pi.registerMessageRenderer("pii-alert", (message, { expanded }, theme) => {
    const data = JSON.parse(message.content) as PIIAlertData;
    const box = new Box(1, 0, (t) => theme.bg("customMessageBg", t));

    // Header with severity indicator
    box.addChild(new Text(
      theme.fg("warning", theme.bold("⚠ PII DETECTED")) + " " +
      theme.fg("muted", data.piiTypes.join(", ")),
      0, 0
    ));

    // Each PII item (show more details when expanded)
    for (const line of data.piiLines) {
      box.addChild(new Text(theme.fg("dim", line), 0, 0));
    }

    // Add hint about sanitization when expanded
    if (expanded) {
      box.addChild(new Text(theme.fg("muted", "  → Content has been masked for the agent"), 0, 0));
    }

    return box;
  });

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

  // Detect and mask PII before sending to provider
  pi.on("before_agent_start", async (event, ctx) => {

    const text = event.prompt;
    if (!text || text.trim().length === 0) return;

    const classifier = await initPipeline();
    const results = await classifier(text, { aggregation_strategy: "simple" });

    if (results.length === 0) return;

    recordPiiDetected(results.length);

    // Use the model currently active in pi-mono as the authorization subject.
    // If no model is set, fail-closed (mask all PII).
    const modelSubject = ctx.model?.id;
    const deniedCategories = modelSubject
      ? await buildDeniedCategoriesSet(results, modelSubject)
      : new Set(results.map(r => r.entity_group));

    const piiToMask = results.filter(r => deniedCategories.has(r.entity_group));
    const piiToKeep = results.filter(r => !deniedCategories.has(r.entity_group));

    // Log detected PII types for transparency — send inline message
    // Distinguish between masked and allowed PII
    const piiLines: string[] = [];
    if (piiToMask.length > 0) {
      piiLines.push(...piiToMask.map(r =>
        `  [${r.entity_group.toUpperCase()}] "${r.word}" (${(r.score * 100).toFixed(1)}%) → MASKED`
      ));
    }
    if (piiToKeep.length > 0) {
      piiLines.push(...piiToKeep.map(r =>
        `  [${r.entity_group.toUpperCase()}] "${r.word}" (${(r.score * 100).toFixed(1)}%) → ALLOWED`
      ));
    }

    const allTypes = [...new Set(results.map(e => e.entity_group))];

    // Send inline message that appears in the chat flow
    pi.sendMessage({
      customType: "pii-alert",
      content: JSON.stringify({ piiTypes: allTypes, piiLines }),
      display: true,
      triggerTurn: false,
    });

    // Inject sanitization instructions
    const maskedText = maskPII(text, piiToMask);
    const injection =
      "\n\n[PRIVACY NOTICE] The user message may contain personally identifiable " +
      "information (PII). Be careful not to echo or log sensitive data like names, " +
      "emails, phone numbers, or addresses unless necessary for the task." +
      "\n\nIf the user shares credentials, API keys, or secrets, do not store or " +
      "repeat them. Treat such information as transient.";

    return {
      systemPrompt: event.systemPrompt + injection,
      prompt: maskedText,
    };
  });

  pi.on("context", async (event, ctx) => {
    const classifier = await initPipeline();

    // Filter out PII alert messages - they are UI-only, not sent to the model
    const filteredMessages = event.messages.filter(msg =>
      !(msg.role === "custom" && (msg as any).customType === "pii-alert")
    );

    const modelSubject = ctx.model?.id;

    for (const msg of filteredMessages) {
      if (msg.role === "user") {
        for (const content of msg.content) {
          if (content.type === "text") {
            const results = await classifier(content.text,
              { aggregation_strategy: "simple" });
            if (results.length > 0) {
              // Apply same OpenFGA authorization logic to context messages
              const deniedCategories = modelSubject
                ? await buildDeniedCategoriesSet(results, modelSubject)
                : new Set(results.map(r => r.entity_group));
              const piiToMask = results.filter(r => deniedCategories.has(r.entity_group));
              if (piiToMask.length > 0) {
                content.text = maskPII(content.text, piiToMask);
              }
            }
          }
        }
      }
    }
    return { messages: filteredMessages };
  });

  // Detect and mask PII in model output before sending to user (output direction)
  //
  // This handler implements the 4-way sharing authorization check:
  //   1. model --can_share--> pii_instance    (is model authorized to share this PII?)
  //   2. pii_instance --lineage--> model      (did this PII originate from this model?)
  //   3. pii_instance --can_view--> recipient  (is recipient allowed to view this PII?)
  //   4. recipient --can_receive_from--> model (does recipient trust this model?)
  //
  // If any check fails, the PII is masked before delivery.
  //
  // Environment variables:
  //   PRIVACY_FILTER_SHARING_ENABLED - Set to "true" to enable output direction checks
  //   PRIVACY_FILTER_RECIPIENT_ID    - The recipient ID (e.g., "user:alice")
  pi.on("message_end", async (event, ctx) => {
    // Guard: Only process assistant messages (not user, system, or tool)
    if (event.message.role !== "assistant") return;

    // Guard: Check if sharing authorization is enabled
    // When disabled, no output direction checks are performed (input direction still works)
    if (!isSharingEnabled()) return;

    // Get the current recipient context for sharing checks
    // This is set via PRIVACY_FILTER_RECIPIENT_ID environment variable
    const recipientId = getRecipientId();
    if (!recipientId) {
      console.log("[PRIVACY] PRIVACY_FILTER_RECIPIENT_ID not set — cannot perform sharing checks");
      return;
    }

    // Extract text content from the assistant message for PII detection
    const content = extractText(event.message.content);
    if (!content || content.trim().length === 0) return;

    // Detect PII entities in the model output using the Privacy Filter model
    const classifier = await initPipeline();
    const results = await classifier(content, { aggregation_strategy: "simple" });
    if (results.length === 0) return;

    // Get the model ID as the authorization subject
    // The model is the principal attempting to share PII to the recipient
    const modelSubject = ctx.model?.id;
    if (!modelSubject) {
      console.log("[PRIVACY] No model configured — cannot perform sharing checks");
      return;
    }

    // Perform the 4-way sharing authorization check via OpenFGA
    // buildSharingDeniedCategoriesSet returns categories that should be BLOCKED
    // (categories where ANY of the 4 checks failed)
    const deniedCategories = await buildSharingDeniedCategoriesSet(
      results,
      modelSubject,
      recipientId,
      { checkRecipientTrust: true }  // Also verify recipient --can_receive_from--> model
    );

    // Filter to only PII entities whose categories are denied
    const piiToMask = results.filter(r => deniedCategories.has(r.entity_group));
    if (piiToMask.length === 0) return;  // All PII is authorized — return unmodified

    // Mask denied PII and return modified message
    // The message is returned to pi-mono, which replaces the original with our masked version
    const maskedContent = maskPII(content, piiToMask);
    return {
      message: {
        ...event.message,
        content: [{ type: 'text', text: maskedContent }],
      },
    };
  });

  // Detect and mask PII in tool results before they are returned (output direction)
  //
  // This handler is for multi-agent scenarios where tool output may be displayed
  // to users or agents other than the calling model. It applies the same 4-way
  // sharing authorization check as message_end:
  //   1. model --can_share--> pii_instance    (is model authorized to share this PII?)
  //   2. pii_instance --lineage--> model      (did this PII originate from this model?)
  //   3. pii_instance --can_view--> recipient  (is recipient allowed to view this PII?)
  //   4. recipient --can_receive_from--> model (does recipient trust this model?)
  //
  // Note: If the tool result stays within the same conversation (LLM sees it in next turn),
  // the context handler will apply input direction checks instead. tool_result is only
  // needed when the output goes to a different recipient.
  //
  // Environment variables:
  //   PRIVACY_FILTER_SHARING_ENABLED - Set to "true" to enable sharing checks on tool results
  //   PRIVACY_FILTER_RECIPIENT_ID    - The recipient ID (e.g., "user:alice")
  pi.on("tool_result", async (event, ctx) => {
    // Guard: Check if sharing authorization is enabled
    if (!isSharingEnabled()) return;

    // Get the current recipient context for sharing checks
    const recipientId = getRecipientId();
    if (!recipientId) {
      console.log("[PRIVACY] PRIVACY_FILTER_RECIPIENT_ID not set — cannot perform sharing checks on tool result");
      return;
    }

    // Extract text content from tool result (handles both string and array formats)
    const content = extractToolResultText(event.content);
    if (!content || content.trim().length === 0) return;

    // Detect PII entities in the tool output
    const classifier = await initPipeline();
    const results = await classifier(content, { aggregation_strategy: "simple" });
    if (results.length === 0) return;

    // Get the model ID as the authorization subject
    const modelSubject = ctx.model?.id;
    if (!modelSubject) {
      console.log("[PRIVACY] No model configured — cannot perform sharing checks on tool result");
      return;
    }

    // Perform 4-way sharing authorization check
    const deniedCategories = await buildSharingDeniedCategoriesSet(
      results,
      modelSubject,
      recipientId,
      { checkRecipientTrust: true }
    );

    // Filter to only PII whose categories are denied
    const piiToMask = results.filter(r => deniedCategories.has(r.entity_group));
    if (piiToMask.length === 0) return;

    // Mask the denied PII
    const maskedContent = maskPII(content, piiToMask);

    // Return modified tool result, preserving the original structure
    // Tool results can be either string or array of content blocks
    if (typeof event.content === 'string') {
      return { content: maskedContent };
    } else {
      // Map through content blocks and mask text blocks
      const maskedBlocks = event.content.map(block => {
        if (block.type === 'text') {
          return { ...block, text: maskPII(block.text || '', piiToMask) };
        }
        return block;
      });
      return { content: maskedBlocks };
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
      const classifier = await initPipeline();
      const results = await classifier(args, { aggregation_strategy: "simple" });

      if (results.length === 0) {
        ctx.ui.notify("No PII detected", "info");
      } else {
        const piiTypes = [...new Set(results.map(e => e.entity_group))];
        const piiLines = results.map(r =>
          `  [${r.entity_group.toUpperCase()}] "${r.word}" (${(r.score * 100).toFixed(1)}%)`
        );

        // Send inline message for /check-pii command
        pi.sendMessage({
          customType: "pii-alert",
          content: JSON.stringify({ piiTypes, piiLines }),
          display: true,
        });
      }
    },
  });

  // Register command to inspect OpenFGA authorization state for detected PII
  pi.registerCommand("check-pii-auth", {
    description: "Inspect OpenFGA authorization state for PII in text",
    handler: async (args, ctx) => {
      if (!args) {
        ctx.ui.notify("Usage: /check-pii-auth <text>", "warning");
        return;
      }

      const modelSubject = ctx.model?.id;
      if (!modelSubject) {
        ctx.ui.notify("No model configured — all PII would be masked", "warning");
        return;
      }

      const classifier = await initPipeline();
      const results = await classifier(args, { aggregation_strategy: "simple" });

      if (results.length === 0) {
        ctx.ui.notify("No PII detected", "info");
        return;
      }

      const openfga = getOpenFGAClient();

      if (!(await openfga.healthCheck())) {
        logHealthCheckFailed('OpenFGA unreachable — /check-pii-auth cannot proceed');
        recordFailClosed('health_check_failed', ctx.model?.id ?? 'unknown');
        ctx.ui.notify('OpenFGA unreachable — cannot check authorization', 'error');
        return;
      }
      const piiLines: string[] = [];
      const categoryEntities = new Map<string, AggregatedAnnotation[]>();
      for (const entity of results) {
        if (!categoryEntities.has(entity.entity_group)) {
          categoryEntities.set(entity.entity_group, []);
        }
        categoryEntities.get(entity.entity_group)!.push(entity);
      }

      for (const [category, entities] of categoryEntities) {
        let categoryAllowed = false;

        // Category-level check first
        try {
          categoryAllowed = await openfga.check({
            subject: modelSubject,
            relation: "can_view",
            object: category,
          });
        } catch {
          // OpenFGA unavailable — fail closed for this category
          piiLines.push(`  [${category.toUpperCase()}] (category) → MASKED (OpenFGA unavailable)`);
          continue;
        }

        if (categoryAllowed) {
          piiLines.push(`  [${category.toUpperCase()}] (category) → ALLOWED`);
          for (const entity of entities) {
            piiLines.push(`    "${entity.word}" → ALLOWED (category-level)`);
          }
          continue;
        }

        // Category-level failed — check each literal individually
        piiLines.push(`  [${category.toUpperCase()}] (category) → MASKED`);
        for (const entity of entities) {
          let literalAllowed = false;
          try {
            literalAllowed = await openfga.check({
              subject: modelSubject,
              relation: "can_view",
              literal: entity.word,
            });
          } catch {
            // OpenFGA unavailable — fail closed for this literal
            piiLines.push(`    "${entity.word}" → MASKED (OpenFGA unavailable)`);
            continue;
          }
          if (literalAllowed) {
            piiLines.push(`    "${entity.word}" → ALLOWED (literal-level)`);
          } else {
            piiLines.push(`    "${entity.word}" → MASKED (literal-level)`);
          }
        }
      }

      const allTypes = [...new Set(results.map(e => e.entity_group))];
      pi.sendMessage({
        customType: "pii-alert",
        content: JSON.stringify({ piiTypes: allTypes, piiLines }),
        display: true,
      });
    },
  });

  // Register command to check a model's authorization to a category or literal
  pi.registerCommand("check-pii-access", {
    description: "Check if a model can view a PII category or specific literal",
    handler: async (args, ctx) => {
      if (!args) {
        ctx.ui.notify("Usage: /check-pii-access <model-id> <category|sha256-hash>", "warning");
        return;
      }
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui.notify("Usage: /check-pii-access <model-id> <category|sha256-hash>", "warning");
        return;
      }
      const [modelId, target] = parts;

      const openfga = getOpenFGAClient();

      if (!(await openfga.healthCheck())) {
        logHealthCheckFailed('OpenFGA unreachable — /check-pii-access cannot proceed');
        recordFailClosed('health_check_failed', ctx.model?.id ?? 'unknown');
        ctx.ui.notify('OpenFGA unreachable — cannot check access', 'error');
        return;
      }

      // Pass raw target — buildObjectId() in openfga.ts adds the privacy_category: prefix
      const objectId = target;

      let allowed: boolean;
      try {
        allowed = await openfga.check({
          subject: modelId,
          relation: 'can_view',
          object: objectId,
        });
      } catch (err) {
        logAuthError(modelId, target, undefined, (err as Error).message);
        ctx.ui.notify(`OpenFGA error: ${(err as Error).message}`, 'error');
        return;
      }

      if (allowed) {
        ctx.ui.notify(`✓ ALLOWED — ${modelId} can_view ${target}`, 'info');
      } else {
        ctx.ui.notify(`✗ DENIED — ${modelId} cannot view ${target}`, 'warning');
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Privacy Filter extension loaded", "info");
  });

  // Start metrics push to OTEL endpoint if configured
  startMetrics();

};

// Extract text content from a message content array
function extractText(content: any[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text || "")
    .join("\n");
}

// Extract text from tool result content (string or array)
function extractToolResultText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join('\n');
}

// Mask PII in text by replacing with [<entity_group>: REDACTED]
function maskPII(text: string, pii: AggregatedAnnotation[]): string {
  // Sort by start position descending to replace from end (preserve positions)
  for (const entity of pii) {
    const placeholder = `[${entity.entity_group.toUpperCase()} REDACTED]`;
    text = text.replaceAll(entity.word, placeholder);
  }
  return text;
}
