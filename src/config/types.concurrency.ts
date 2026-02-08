/**
 * Concurrency configuration types for OpenClaw
 */

import type {
  ConcurrencyConfig as CoreConcurrencyConfig,
  TaskPriority,
} from "../concurrency/types.js";

/**
 * Concurrency settings (extends core concurrency config)
 */
export type ConcurrencySettings = CoreConcurrencyConfig & {
  /** Enable concurrency system */
  enabled?: boolean;
  /** Worker thread script path */
  workerScriptPath?: string;
  /** Auto-scale workers based on load */
  autoScale?: {
    enabled: boolean;
    minWorkers: number;
    maxWorkers: number;
    targetQueueDepth: number;
    scaleUpThreshold: number;
    scaleDownThreshold: number;
  };
  /** Circuit breaker settings */
  circuitBreaker?: {
    enabled: boolean;
    failureThreshold: number;
    resetTimeoutMs: number;
  };
};

/**
 * Per-channel concurrency limits
 */
export type ChannelConcurrencyLimits = {
  /** Channel ID */
  channelId: string;
  /** Max concurrent tasks */
  maxConcurrent: number;
  /** Default priority for this channel */
  defaultPriority?: TaskPriority;
  /** Enable priority boosting for mentions */
  priorityBoostForMentions?: boolean;
};

/**
 * Agent-specific concurrency settings
 */
export type AgentConcurrencySettings = {
  /** Agent ID */
  agentId: string;
  /** Max concurrent runs */
  maxConcurrentRuns: number;
  /** Queue overflow policy */
  overflowPolicy?: "queue" | "drop" | "reject";
  /** Enable parallel tool execution */
  parallelTools?: boolean;
};

/**
 * Extend the main OpenClaw config types
 * Add this to types.openclaw.ts:
 *
 * concurrency?: ConcurrencySettings;
 * channelConcurrency?: ChannelConcurrencyLimits[];
 * agentConcurrency?: AgentConcurrencySettings[];
 */
