import { z } from "zod";

export const WorkerPoolConfigSchema = z
  .object({
    minWorkers: z.number().int().positive(),
    maxWorkers: z.number().int().positive(),
    maxTasksPerWorker: z.number().int().positive(),
    idleTimeoutMs: z.number().int().nonnegative(),
    taskTimeoutMs: z.number().int().nonnegative(),
    workerScript: z.string().optional(),
    useWorkerThreads: z.boolean().optional(),
    resourceLimits: z
      .object({
        maxOldGenerationSizeMb: z.number().optional(),
        maxYoungGenerationSizeMb: z.number().optional(),
      })
      .optional(),
    backpressureThreshold: z.number().int().positive(),
    priorityWeights: z.record(z.string(), z.number()).optional(),
    enableBatching: z.boolean().optional(),
    maxBatchSize: z.number().int().positive().optional(),
    batchWindowMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export const TaskQueueConfigSchema = z
  .object({
    maxSize: z.number().int().nonnegative(),
    fullPolicy: z.enum(["reject", "drop-oldest", "drop-newest"]),
    priorityScheduling: z.boolean(),
    fairScheduling: z.boolean(),
    ownerQuota: z.number().int().positive().optional(),
    taskTtlMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export const ConcurrencyLimiterConfigSchema = z
  .object({
    globalLimit: z.number().int().positive(),
    perOwnerLimit: z.number().int().positive(),
    perTypeLimits: z.record(z.string(), z.number()).optional(),
    resourceLimits: z
      .object({
        maxMemoryMb: z.number().optional(),
        maxCpuPercent: z.number().optional(),
      })
      .optional(),
  })
  .strict();

export const ConcurrencySettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    workerPool: WorkerPoolConfigSchema.partial().optional(),
    taskQueue: TaskQueueConfigSchema.partial().optional(),
    limiter: ConcurrencyLimiterConfigSchema.partial().optional(),
    defaultStrategy: z.enum(["parallel", "sequential", "bounded", "priority", "fair"]).optional(),
    enableMetrics: z.boolean().optional(),
    metricsIntervalMs: z.number().optional(),
    workerScriptPath: z.string().optional(),
    autoScale: z
      .object({
        enabled: z.boolean(),
        minWorkers: z.number(),
        maxWorkers: z.number(),
        targetQueueDepth: z.number(),
        scaleUpThreshold: z.number(),
        scaleDownThreshold: z.number(),
      })
      .optional(),
    circuitBreaker: z
      .object({
        enabled: z.boolean(),
        failureThreshold: z.number(),
        resetTimeoutMs: z.number(),
      })
      .optional(),
  })
  .strict();

export const ChannelConcurrencyLimitsSchema = z
  .object({
    channelId: z.string(),
    maxConcurrent: z.number().int().positive(),
    defaultPriority: z.enum(["critical", "high", "normal", "low", "background"]).optional(),
    priorityBoostForMentions: z.boolean().optional(),
  })
  .strict();

export const AgentConcurrencySettingsSchema = z
  .object({
    agentId: z.string(),
    maxConcurrentRuns: z.number().int().positive(),
    overflowPolicy: z.enum(["queue", "drop", "reject"]).optional(),
    parallelTools: z.boolean().optional(),
  })
  .strict();
