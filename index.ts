// SPDX-License-Identifier: Apache-2.0

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { env, pipeline } from '@huggingface/transformers';
import { Box, Text } from '@mariozechner/pi-tui';

import { getOpenFGAClient } from './openfga.ts';
import { buildDeniedCategoriesSet, type AggregatedAnnotation } from './privacy-auth.ts';

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
  })

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
        ctx.ui.notify('OpenFGA unreachable — cannot check authorization', 'error');
        return;
      }

      const piiLines: string[] = [];

      // Group entities by category
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
        ctx.ui.notify('OpenFGA unreachable — cannot check access', 'error');
        return;
      }

      const objectId = target.startsWith('sha256-')
        ? `privacy_category:${target}`
        : `privacy_category:${target}`;

      let allowed: boolean;
      try {
        allowed = await openfga.check({
          subject: modelId,
          relation: 'can_view',
          object: objectId,
        });
      } catch (err) {
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
