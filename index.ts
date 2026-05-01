// SPDX-License-Identifier: Apache-2.0

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { env, pipeline } from '@huggingface/transformers';
import { Box, Text } from '@mariozechner/pi-tui';
import { getOpenFGAClient } from './openfga';

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

/**
 * Build the set of PII categories that should be masked.
 * A category is denied (masked) when BOTH the literal-level check
 * and the category-level check return false or throw.
 *
 * If OpenFGA is unreachable, ALL categories are denied (fail-closed).
 *
 * @param results - PII entities detected by the classifier
 * @param modelSubject - The model ID from pi-mono's current context (e.g. "mlx-community/MiniMax-M2.7-8bit")
 */
async function buildDeniedCategoriesSet(
  results: AggregatedAnnotation[],
  modelSubject: string,
): Promise<Set<string>> {
  const deniedCategories = new Set<string>();

  // Group by category to avoid redundant OpenFGA calls for same category
  const categoryEntities = new Map<string, AggregatedAnnotation[]>();
  for (const entity of results) {
    if (!categoryEntities.has(entity.entity_group)) {
      categoryEntities.set(entity.entity_group, []);
    }
    categoryEntities.get(entity.entity_group)!.push(entity);
  }

  const openfga = getOpenFGAClient();
  let openfgaAvailable = true;

  for (const [category, entities] of categoryEntities) {
    let categoryAllowed = false;

    // Try category-level check first (more efficient — one check covers all literals)
    try {
      const canViewCategory = await openfga.check({
        subject: modelSubject,
        relation: "can_view",
        object: category,
      });
      if (canViewCategory) {
        categoryAllowed = true;
      }
    } catch {
      // OpenFGA unavailable — fail closed
      openfgaAvailable = false;
      break;
    }

    if (categoryAllowed) continue;

    // Check each literal under this category individually
    for (const entity of entities) {
      try {
        const canViewLiteral = await openfga.check({
          subject: modelSubject,
          relation: "can_view",
          literal: entity.word,
        });
        if (canViewLiteral) {
          categoryAllowed = true;
          break;
        }
      } catch {
        // OpenFGA unavailable — fail closed
        openfgaAvailable = false;
        break;
      }
    }

    if (!categoryAllowed) {
      deniedCategories.add(category);
    }

    if (!openfgaAvailable) break;
  }

  // Fail-closed: if OpenFGA was unreachable, mask everything
  if (!openfgaAvailable) {
    for (const category of categoryEntities.keys()) {
      deniedCategories.add(category);
    }
  }

  return deniedCategories;
}