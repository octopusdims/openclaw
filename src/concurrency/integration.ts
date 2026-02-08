/**
 * Concurrency System Integration for OpenClaw
 * Integrates concurrent processing with message and agent handling
 */

import type { FollowupRun } from "../auto-reply/reply/queue/types.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { GetReplyOptions } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  ConcurrencyManager,
  type Task,
  type TaskPriority,
  type TaskResult,
  type ExecutionStrategy,
} from "./index.js";

export type ConcurrencyIntegrationOptions = {
  config: OpenClawConfig;
  concurrencyManager: ConcurrencyManager;
};

/** Message processing task input */
export type MessageProcessingInput = {
  msgCtx: MsgContext;
  options: GetReplyOptions;
  sessionKey: string;
};

/** Message processing task output */
export type MessageProcessingOutput = {
  sessionKey: string;
  reply?: string;
  error?: Error;
  processingTimeMs: number;
};

/** Agent run task input */
export type AgentRunInput = {
  run: FollowupRun["run"];
  prompt: string;
  sessionKey: string;
};

/** Agent run task output */
export type AgentRunOutput = {
  sessionKey: string;
  response?: string;
  error?: Error;
  usage?: {
    tokensIn: number;
    tokensOut: number;
  };
};

/**
 * Extract concurrency config from OpenClaw config
 */
export function extractConcurrencyConfig(config: OpenClawConfig): {
  enabled: boolean;
  strategy: ExecutionStrategy;
  maxConcurrency: number;
} {
  const messages = config.messages;
  const broadcast = config.broadcast;

  return {
    enabled: true,
    strategy: (broadcast?.strategy === "parallel" ? "parallel" : "bounded") as ExecutionStrategy,
    maxConcurrency: 8, // Default max concurrent agent runs
  };
}

/**
 * Determine task priority based on message context
 */
export function determinePriority(msgCtx: MsgContext): TaskPriority {
  // Critical: Direct commands from owners
  if (msgCtx.IsDM && msgCtx.OwnerAllowFrom?.includes(msgCtx.SenderId ?? "")) {
    return "critical";
  }

  // High: Direct messages
  if (msgCtx.IsDM) {
    return "high";
  }

  // Normal: Group mentions
  if (msgCtx.IsGroup && msgCtx.IsMentioned) {
    return "normal";
  }

  // Low: Group messages without mention
  if (msgCtx.IsGroup) {
    return "low";
  }

  return "normal";
}

/**
 * Process message with concurrency control
 */
export async function processMessageConcurrent(
  options: ConcurrencyIntegrationOptions,
  input: MessageProcessingInput,
  processor: (input: MessageProcessingInput) => Promise<MessageProcessingOutput>,
): Promise<MessageProcessingOutput> {
  const cm = options.concurrencyManager;
  const priority = determinePriority(input.msgCtx);

  // Register handler if not already registered
  if (!cm.getStats().handlers.includes("process-message")) {
    cm.registerHandler("process-message", processor);
  }

  return cm.execute("process-message", input, {
    priority,
    ownerId: input.msgCtx.SenderId ?? undefined,
    timeoutMs: input.options.timeoutMs ?? 120000,
  });
}

/**
 * Process multiple messages in parallel
 */
export async function processMessagesBatch(
  options: ConcurrencyIntegrationOptions,
  inputs: MessageProcessingInput[],
  processor: (input: MessageProcessingInput) => Promise<MessageProcessingOutput>,
): Promise<TaskResult<MessageProcessingOutput>[]> {
  const cm = options.concurrencyManager;

  // Register handler
  if (!cm.getStats().handlers.includes("process-message")) {
    cm.registerHandler("process-message", processor);
  }

  // Execute with bounded concurrency
  return cm.executeAll("process-message", inputs, {
    continueOnError: true,
    batchSize: 10,
  });
}

/**
 * Execute agent run with concurrency control
 */
export async function executeAgentRunConcurrent(
  options: ConcurrencyIntegrationOptions,
  input: AgentRunInput,
  executor: (input: AgentRunInput) => Promise<AgentRunOutput>,
): Promise<AgentRunOutput> {
  const cm = options.concurrencyManager;

  // Register handler if not already registered
  if (!cm.getStats().handlers.includes("agent-run")) {
    cm.registerHandler("agent-run", executor);
  }

  return cm.execute("agent-run", input, {
    priority: "high",
    ownerId: input.run.senderId,
    timeoutMs: input.run.timeoutMs,
    resourceTags: [input.run.agentId, input.run.provider],
  });
}

/**
 * Process followup queue with concurrent draining
 */
export function createConcurrentQueueDrainer(
  options: ConcurrencyIntegrationOptions,
  runFollowup: (run: FollowupRun) => Promise<void>,
) {
  const cm = options.concurrencyManager;
  const runningDrains = new Map<string, Promise<void>>();

  return {
    /**
     * Start draining a queue concurrently
     */
    async drain(key: string, runs: FollowupRun[]): Promise<void> {
      // Cancel existing drain for this key
      const existing = runningDrains.get(key);
      if (existing) {
        await existing;
      }

      const drainPromise = this.performDrain(key, runs);
      runningDrains.set(key, drainPromise);

      try {
        await drainPromise;
      } finally {
        runningDrains.delete(key);
      }
    },

    async performDrain(key: string, runs: FollowupRun[]): Promise<void> {
      const cm = options.concurrencyManager;

      // Process runs with bounded concurrency
      const results = await cm.bounded(
        runs.map((run) => ({
          type: "followup-run",
          input: { run, key },
          priority: "normal" as TaskPriority,
        })),
        3, // Max 3 concurrent followups per queue
      );

      // Log failures
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === "failed") {
          console.error(`Followup ${i} failed:`, result.error);
        }
      }
    },

    /**
     * Check if a queue is currently being drained
     */
    isDraining(key: string): boolean {
      return runningDrains.has(key);
    },

    /**
     * Cancel all active drains
     */
    async cancelAll(): Promise<void> {
      await Promise.all(runningDrains.values());
      runningDrains.clear();
    },
  };
}

/**
 * Create concurrent broadcast sender
 */
export function createConcurrentBroadcast(
  options: ConcurrencyIntegrationOptions,
  sender: (target: string, message: string) => Promise<void>,
) {
  const cm = options.concurrencyManager;

  // Register sender handler
  cm.registerHandler("broadcast-send", sender);

  return {
    /**
     * Send to multiple targets concurrently
     */
    async send(
      targets: string[],
      message: string,
      strategy: "parallel" | "sequential" | "bounded" = "bounded",
    ): Promise<TaskResult<void>[]> {
      const inputs = targets.map((target) => ({ target, message }));

      switch (strategy) {
        case "parallel":
          return cm.parallel(
            inputs.map((input) => ({
              type: "broadcast-send",
              input,
              priority: "normal" as TaskPriority,
            })),
          );

        case "sequential":
          return cm.sequential(
            inputs.map((input) => ({
              type: "broadcast-send",
              input,
              priority: "normal" as TaskPriority,
            })),
          );

        case "bounded":
        default:
          return cm.bounded(
            inputs.map((input) => ({
              type: "broadcast-send",
              input,
              priority: "normal" as TaskPriority,
            })),
            5, // Max 5 concurrent sends
          );
      }
    },
  };
}

/**
 * Resource-aware task scheduler
 */
export function createResourceAwareScheduler(options: ConcurrencyIntegrationOptions) {
  const cm = options.concurrencyManager;
  let paused = false;

  return {
    /**
     * Check if system has capacity for more tasks
     */
    hasCapacity(): boolean {
      const metrics = cm.getMetrics();
      if (!metrics) return true;

      // Pause if queue is backing up
      if (metrics.queue.size > 500) {
        return false;
      }

      // Pause if memory is high
      const memoryUsage = metrics.resources.memoryUsedMb / metrics.resources.memoryAvailableMb;
      if (memoryUsage > 0.9) {
        return false;
      }

      return true;
    },

    /**
     * Pause processing when overloaded
     */
    pause(): void {
      if (!paused) {
        cm.pause();
        paused = true;
      }
    },

    /**
     * Resume processing
     */
    resume(): void {
      if (paused) {
        cm.resume();
        paused = false;
      }
    },

    /**
     * Auto-adjust based on system load
     */
    autoAdjust(): void {
      if (!this.hasCapacity()) {
        this.pause();
      } else {
        this.resume();
      }
    },
  };
}

/**
 * Metrics collector for monitoring
 */
export function createConcurrencyMetrics(options: ConcurrencyIntegrationOptions) {
  const cm = options.concurrencyManager;
  const history: Array<{
    timestamp: number;
    stats: ReturnType<ConcurrencyManager["getStats"]>;
  }> = [];

  return {
    /**
     * Record current stats
     */
    record(): void {
      history.push({
        timestamp: Date.now(),
        stats: cm.getStats(),
      });

      // Keep last 100 records
      if (history.length > 100) {
        history.shift();
      }
    },

    /**
     * Get history
     */
    getHistory(): typeof history {
      return [...history];
    },

    /**
     * Get average queue depth over time
     */
    getAverageQueueDepth(timeWindowMs = 60000): number {
      const cutoff = Date.now() - timeWindowMs;
      const relevant = history.filter((h) => h.timestamp > cutoff);

      if (relevant.length === 0) return 0;

      const sum = relevant.reduce((acc, h) => acc + h.stats.scheduler.queue.size, 0);
      return sum / relevant.length;
    },

    /**
     * Get throughput (tasks per minute)
     */
    getThroughput(): number {
      const cutoff = Date.now() - 60000;
      const relevant = history.filter((h) => h.timestamp > cutoff);

      if (relevant.length < 2) return 0;

      const first = relevant[0];
      const last = relevant[relevant.length - 1];

      const completed =
        last.stats.scheduler.metrics.completed - first.stats.scheduler.metrics.completed;

      const minutes = (last.timestamp - first.timestamp) / 60000;
      return minutes > 0 ? completed / minutes : 0;
    },
  };
}
