/**
 * Concurrency types for OpenClaw
 * Defines worker pool, task queue, and concurrency control abstractions
 */

import type { TransferListItem } from "node:worker_threads";

/** Task priority levels */
export type TaskPriority = "critical" | "high" | "normal" | "low" | "background";

/** Task status */
export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

/** Task definition */
export type Task<TInput = unknown, TOutput = unknown> = {
  /** Unique task identifier */
  id: string;
  /** Task type/category */
  type: string;
  /** Task input data */
  input: TInput;
  /** Task priority */
  priority: TaskPriority;
  /** When the task was created */
  createdAt: number;
  /** When the task should start (if scheduled) */
  scheduledAt?: number;
  /** Maximum execution time (ms) */
  timeoutMs?: number;
  /** Number of retry attempts allowed */
  maxRetries?: number;
  /** Current retry count */
  retryCount?: number;
  /** Associated user/channel for resource accounting */
  ownerId?: string;
  /** Resource tags for scheduling */
  resourceTags?: string[];
  /** Whether task can be batched with similar tasks */
  batchable?: boolean;
  /** Transfer list for worker_threads */
  transferList?: TransferListItem[];
};

/** Task result */
export type TaskResult<TOutput = unknown> = {
  taskId: string;
  status: TaskStatus;
  output?: TOutput;
  error?: Error;
  startedAt?: number;
  completedAt?: number;
  workerId?: string;
  retryCount: number;
  /** Execution metrics */
  metrics?: {
    cpuTimeMs?: number;
    memoryPeakMb?: number;
  };
};

/** Worker state */
export type WorkerState = "idle" | "busy" | "stopping" | "stopped" | "error";

/** Worker information */
export type WorkerInfo = {
  id: string;
  state: WorkerState;
  currentTask?: string;
  tasksCompleted: number;
  tasksFailed: number;
  startedAt: number;
  lastActivityAt: number;
  /** Current memory usage (if available) */
  memoryUsage?: NodeJS.MemoryUsage;
};

/** Worker pool configuration */
export type WorkerPoolConfig = {
  /** Minimum number of workers to maintain */
  minWorkers: number;
  /** Maximum number of workers allowed */
  maxWorkers: number;
  /** Maximum tasks per worker before recycling */
  maxTasksPerWorker: number;
  /** Idle timeout before worker termination (ms) */
  idleTimeoutMs: number;
  /** Task timeout default (ms) */
  taskTimeoutMs: number;
  /** Worker script path (for worker_threads) */
  workerScript?: string;
  /** Whether to use worker threads (default: true) */
  useWorkerThreads?: boolean;
  /** Resource limits per worker */
  resourceLimits?: {
    maxOldGenerationSizeMb?: number;
    maxYoungGenerationSizeMb?: number;
  };
  /** Backpressure threshold - pause accepting tasks when queue reaches this size */
  backpressureThreshold: number;
  /** Task priority weights for scheduling */
  priorityWeights?: Record<TaskPriority, number>;
  /** Enable task batching for batchable tasks */
  enableBatching?: boolean;
  /** Maximum batch size */
  maxBatchSize?: number;
  /** Batch window - time to collect tasks before processing (ms) */
  batchWindowMs?: number;
};

/** Queue configuration */
export type TaskQueueConfig = {
  /** Maximum queue size (0 = unlimited) */
  maxSize: number;
  /** Queue drop policy when full */
  fullPolicy: "reject" | "drop-oldest" | "drop-newest";
  /** Enable priority scheduling */
  priorityScheduling: boolean;
  /** Enable fair scheduling across owners */
  fairScheduling: boolean;
  /** Owner quota - max tasks per owner in queue */
  ownerQuota?: number;
  /** Task TTL - max time in queue before drop (ms) */
  taskTtlMs?: number;
};

/** Concurrency limiter configuration */
export type ConcurrencyLimiterConfig = {
  /** Global max concurrent tasks */
  globalLimit: number;
  /** Per-owner max concurrent tasks */
  perOwnerLimit: number;
  /** Per-task-type max concurrent tasks */
  perTypeLimits?: Record<string, number>;
  /** Resource-based limits (e.g., "memory", "cpu") */
  resourceLimits?: {
    maxMemoryMb?: number;
    maxCpuPercent?: number;
  };
};

/** Execution strategy for concurrent operations */
export type ExecutionStrategy =
  | "parallel" // Run all tasks in parallel
  | "sequential" // Run tasks one by one
  | "bounded" // Run with max concurrency
  | "priority" // Run by priority
  | "fair"; // Fair scheduling across owners

/** Batch task definition */
export type BatchTask<TInput = unknown, TOutput = unknown> = {
  tasks: Array<Task<TInput, TOutput>>;
  batchId: string;
  batchType: string;
  createdAt: number;
};

/** Concurrency manager configuration */
export type ConcurrencyConfig = {
  /** Worker pool settings */
  workerPool: Partial<WorkerPoolConfig>;
  /** Task queue settings */
  taskQueue: Partial<TaskQueueConfig>;
  /** Concurrency limiter settings */
  limiter?: Partial<ConcurrencyLimiterConfig>;
  /** Default execution strategy */
  defaultStrategy: ExecutionStrategy;
  /** Enable metrics collection */
  enableMetrics: boolean;
  /** Metrics collection interval (ms) */
  metricsIntervalMs?: number;
};

/** Default concurrency configuration */
export const DEFAULT_CONCURRENCY_CONFIG: ConcurrencyConfig = {
  workerPool: {
    minWorkers: 2,
    maxWorkers: 8,
    maxTasksPerWorker: 100,
    idleTimeoutMs: 300000, // 5 minutes
    taskTimeoutMs: 60000, // 1 minute
    backpressureThreshold: 1000,
    priorityWeights: {
      critical: 100,
      high: 50,
      normal: 10,
      low: 5,
      background: 1,
    },
    enableBatching: true,
    maxBatchSize: 10,
    batchWindowMs: 100,
  },
  taskQueue: {
    maxSize: 10000,
    fullPolicy: "reject",
    priorityScheduling: true,
    fairScheduling: true,
    ownerQuota: 100,
    taskTtlMs: 300000, // 5 minutes
  },
  limiter: {
    globalLimit: 100,
    perOwnerLimit: 10,
  },
  defaultStrategy: "bounded",
  enableMetrics: true,
  metricsIntervalMs: 60000,
};

/** Priority weights for scheduling */
export const PRIORITY_WEIGHTS: Record<TaskPriority, number> = {
  critical: 100,
  high: 50,
  normal: 10,
  low: 5,
  background: 1,
};

/** Metrics snapshot */
export type ConcurrencyMetrics = {
  timestamp: number;
  /** Worker pool metrics */
  workers: {
    total: number;
    idle: number;
    busy: number;
    stopping: number;
    tasksCompleted: number;
    tasksFailed: number;
    avgTaskDurationMs: number;
  };
  /** Queue metrics */
  queue: {
    size: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    avgWaitTimeMs: number;
  };
  /** Resource usage */
  resources: {
    memoryUsedMb: number;
    memoryAvailableMb: number;
    cpuUsagePercent?: number;
  };
  /** Task metrics by priority */
  byPriority: Record<TaskPriority, { submitted: number; completed: number }>;
};

/** Event types for concurrency monitoring */
export type ConcurrencyEvent =
  | { type: "task:submitted"; task: Task }
  | { type: "task:started"; taskId: string; workerId: string }
  | { type: "task:completed"; result: TaskResult }
  | { type: "task:failed"; result: TaskResult }
  | { type: "task:cancelled"; taskId: string }
  | { type: "worker:spawned"; workerId: string }
  | { type: "worker:stopped"; workerId: string }
  | { type: "worker:error"; workerId: string; error: Error }
  | { type: "queue:backpressure"; queueSize: number }
  | { type: "queue:drained" }
  | { type: "batch:formed"; batch: BatchTask }
  | { type: "metrics"; metrics: ConcurrencyMetrics };

/** Event handler type */
export type ConcurrencyEventHandler = (event: ConcurrencyEvent) => void;

/** Task handler function type */
export type TaskHandler<TInput = unknown, TOutput = unknown> = (
  task: Task<TInput, TOutput>,
) => Promise<TOutput> | TOutput;

/** Batch task handler function type */
export type BatchTaskHandler<TInput = unknown, TOutput = unknown> = (
  batch: BatchTask<TInput, TOutput>,
) => Promise<TaskResult<TOutput>[]>;
