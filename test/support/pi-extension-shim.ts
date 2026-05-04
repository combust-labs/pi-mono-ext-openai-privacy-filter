// SPDX-License-Identifier: Apache-2.0
/**
 * Shim ExtensionAPI for testing piiExtension registration and handlers.
 *
 * Records:
 * - registered message renderers
 * - registered commands
 * - event handlers (before_agent_start, context, session_start)
 * - sent messages via sendMessage()
 *
 * Also provides a mock `ctx` object with configurable `model?.id`
 * and a `ui.notify()` spy.
 *
 * Usage:
 *   const shim = createShimExtensionAPI();
 *   piiExtension(shim.api);           // register handlers
 *   shim.trigger('before_agent_start', event, ctx);
 *   assert(shim.sentMessages.length === 1);
 */

export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string };

export type AgentMessage = {
  role: 'user' | 'assistant' | 'system' | 'custom';
  content: MessageContent[];
  /** Present for custom messages */
  customType?: string;
};

export type BeforeAgentStartEvent = {
  prompt: string;
  systemPrompt: string;
};

export type ContextEvent = {
  messages: AgentMessage[];
};

export type SessionStartEvent = void;

export type RegisteredRenderer = {
  id: string;
  fn: (message: { content: string }, context: { expanded: boolean }, theme: Record<string, (s: string, t: unknown) => string>) => unknown;
};

export type RegisteredCommand = {
  name: string;
  description: string;
  handler: (args: string, ctx: ShimContext) => Promise<void>;
};

export type EventHandlers = {
  before_agent_start: (event: BeforeAgentStartEvent, ctx: ShimContext) => Promise<{ prompt?: string; systemPrompt?: string } | void>;
  context: (event: ContextEvent, ctx: ShimContext) => Promise<{ messages: AgentMessage[] } | void>;
  session_start: (event: SessionStartEvent, ctx: ShimContext) => Promise<void>;
};

export type ShimContext = {
  model: { id: string } | null;
  ui: {
    notify: (message: string, type: 'info' | 'warning' | 'error') => void;
  };
};

export type ShimExtensionAPI = {
  api: {
    registerMessageRenderer: (id: string, fn: RegisteredRenderer['fn']) => void;
    registerCommand: (name: string, config: { description: string }, handler: RegisteredCommand['handler']) => void;
    on: <K extends keyof EventHandlers>(event: K, handler: EventHandlers[K]) => void;
    sendMessage: (msg: { customType?: string; content: string; display?: boolean; triggerTurn?: boolean }) => void;
  };
  ctx: ShimContext;
  /** All messages sent via sendMessage() since last reset. */
  sentMessages: Array<{ customType?: string; content: string; display?: boolean; triggerTurn?: boolean }>;
  /** All registered message renderers. */
  registeredRenderers: RegisteredRenderer[];
  /** All registered commands. */
  registeredCommands: RegisteredCommand[];
  /** All registered event handlers. */
  eventHandlers: { [K in keyof EventHandlers]?: EventHandlers[K][] };
  /** Reset all recorded state. */
  reset(): void;
  /**
   * Trigger a registered event handler by name.
   * Returns the handler's return value, or undefined if no handler registered.
   */
  trigger<K extends keyof EventHandlers>(event: K, arg: Parameters<EventHandlers[K]>[0]): Promise<ReturnType<EventHandlers[K]> | undefined>;
  /**
   * Directly invoke a registered command by name.
   * Returns after the command handler completes.
   */
  invokeCommand(name: string, args: string): Promise<void>;
};

export function createShimExtensionAPI(): ShimExtensionAPI {
  const sentMessages: ShimExtensionAPI['sentMessages'] = [];
  const registeredRenderers: RegisteredRenderer[] = [];
  const registeredCommands: RegisteredCommand[] = [];
  const eventHandlers: ShimExtensionAPI['eventHandlers'] = {
    before_agent_start: [],
    context: [],
    session_start: [],
  };

  const ctx: ShimContext = {
    model: { id: 'test-model/1.0' },
    ui: {
      notify: () => {},
    },
  };

  const api: ShimExtensionAPI['api'] = {
    registerMessageRenderer(id, fn) {
      registeredRenderers.push({ id, fn });
    },

    registerCommand(name, config, handler) {
      // Support both calling conventions:
      // 1. pi.registerCommand('name', { description, handler }) — config has handler inside
      // 2. pi.registerCommand('name', { description }, handler) — handler is separate arg
      const cmdDesc = config.description ?? (config as { description?: string }).description;
      const cmdHandler = handler ?? (config as { handler?: Function }).handler;
      registeredCommands.push({ name, description: cmdDesc, handler: cmdHandler });
    },

    on(event, handler) {
      const handlers = eventHandlers[event as keyof EventHandlers];
      if (handlers) {
        handlers.push(handler as EventHandlers[keyof EventHandlers]);
      }
    },

    sendMessage(msg) {
      sentMessages.push({ ...msg });
    },
  };

  async function trigger<K extends keyof EventHandlers>(
    event: K,
    arg: Parameters<EventHandlers[K]>[0],
  ): Promise<ReturnType<EventHandlers[K]> | undefined> {
    const handlers = eventHandlers[event] as Array<EventHandlers[K]> | undefined;
    if (!handlers || handlers.length === 0) return undefined;
    // Only one handler per event in this extension
    return handlers[0](arg as Parameters<EventHandlers[K]>[0], ctx as Parameters<EventHandlers[K]>[1]);
  }

  async function invokeCommand(name: string, args: string): Promise<void> {
    const cmd = registeredCommands.find(c => c.name === name);
    if (!cmd) throw new Error(`Command not found: ${name}`);
    await cmd.handler(args, ctx);
  }

  function reset() {
    sentMessages.length = 0;
    registeredRenderers.length = 0;
    registeredCommands.length = 0;
    for (const key of Object.keys(eventHandlers) as (keyof EventHandlers)[]) {
      const handlers = eventHandlers[key];
      if (Array.isArray(handlers)) handlers.length = 0;
    }
    ctx.model = { id: 'test-model/1.0' };
  }

  return { api, ctx, sentMessages, registeredRenderers, registeredCommands, eventHandlers, reset, trigger, invokeCommand };
}
