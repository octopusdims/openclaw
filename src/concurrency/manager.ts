/**
 * Concurrency Manager for OpenClaw
 * Main entry point for concurrent task processing
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  Task,
  TaskResult,
  TaskHandler,
  BatchTaskHandler,
  ConcurrencyConfig,
  ConcurrencyEvent,
  ConcurrencyMetrics,
  ExecutionStrategy,
  TaskPriority,
} from "./types.js";
import { TaskScheduler } from "./scheduler.js";
import { DEFAULT_CONCURRENCY_CONFIG } from "./types.js";
import { WorkerPool } from "./worker-pool.js";

export type ConcurrencyManagerOptions = {
  config?: Partial<ConcurrencyConfig>;
  /** Custom task handlers by type */
  handlers?: Map<string, TaskHandler>;
  /** Enable auto-scaling based on load */
  autoScale?: boolean;
};

export class ConcurrencyManager extends EventEmitter {
  private config: ConcurrencyConfig;
  private workerPool?: WorkerPool;
  private scheduler: TaskScheduler;
  private handlers = new Map<string, TaskHandler>();
  private batchHandlers = new Map<string, BatchTaskHandler>();
  private metricsInterval?: NodeJS.Timeout;
  private lastMetrics?: ConcurrencyMetrics;
  private running = false;

  constructor(options: ConcurrencyManagerOptions = {}) {
    super();

    this.config = {
      ...DEFAULT_CONCURRENCY_CONFIG,
      ...options.config,
      workerPool: {
        ...DEFAULT_CONCURRENCY_CONFIG.workerPool,
        ...options.config?.workerPool,
      },
      taskQueue: {
        ...DEFAULT_CONCURRENCY_CONFIG.taskQueue,
        ...options.config?.taskQueue,
      },
    };

    // Initialize scheduler
    this.scheduler = new TaskScheduler(
      this.config.taskQueue,
      this.config.limiter,
      this.config.defaultStrategy,
    );

    // Initialize worker pool if using worker threads
    if (this.config.workerPool.useWorkerThreads && this.config.workerPool.workerScript) {
      this.workerPool = new WorkerPool(this.config.workerPool);
    }

    // Register custom handlers
    if (options.handlers) {
      for (const [type, handler] of options.handlers.entries()) {
        this.registerHandler(type, handler);
      }
    }

    // Setup event forwarding
    this.setupEventForwarding();

    // Start metrics collection
    if (this.config.enableMetrics) {
      this.startMetricsCollection();
    }

    this.running = true;

    // Start background task processor if not using worker pool
    if (!this.workerPool) {
      this.startTaskProcessor();
    }
  }

  private taskProcessorInterval?: NodeJS.Timeout;
  private activeExecutions = new Set<string>();

  /**
   * Start background task processor
   */
  private startTaskProcessor(): void {
    const processTasks = async () => {
      if (!this.running || this.scheduler.isPaused()) return;

      // Try to start new tasks up to the global limit
      while (this.activeExecutions.size < this.scheduler.getGlobalLimit()) {
        const task = this.scheduler.next();
        if (!task) break;

        const handler = this.handlers.get(task.type);
        if (!handler) {
          this.scheduler.markFailed(task.id, new Error(`No handler for type: ${task.type}`));
          continue;
        }

        const taskId = task.id;
        this.scheduler.markStarted(taskId);
        this.activeExecutions.add(taskId);

        // Execute task asynchronously
        (async () => {
          try {
            const result = await handler(task);
            this.scheduler.markCompleted(taskId, result);
          } catch (error) {
            this.scheduler.markFailed(taskId, error as Error);
          } finally {
            this.activeExecutions.delete(taskId);
          }
        })();
      }
    };

    // Process tasks immediately and then periodically
    processTasks();
    this.taskProcessorInterval = setInterval(processTasks, 5);
  }

  /**
   * Register a task handler
   */
  registerHandler<TInput, TOutput>(type: string, handler: TaskHandler<TInput, TOutput>): void {
    this.handlers.set(type, handler as TaskHandler);
  }

  /**
   * Register a batch task handler
   */
  registerBatchHandler<TInput, TOutput>(
    type: string,
    handler: BatchTaskHandler<TInput, TOutput>,
  ): void {
    this.batchHandlers.set(type, handler as BatchTaskHandler);
  }

  /**
   * Execute a task with automatic scheduling
   */
  async execute<TInput, TOutput>(
    type: string,
    input: TInput,
    options?: {
      priority?: TaskPriority;
      timeoutMs?: number;
      ownerId?: string;
      maxRetries?: number;
      resourceTags?: string[];
    },
  ): Promise<TOutput> {
    const handler = this.handlers.get(type);
    if (!handler) {
      throw new Error(`No handler registered for task type: ${type}`);
    }

    const task: Omit<Task<TInput, TOutput>, "id"> = {
      type,
      input,
      priority: options?.priority ?? "normal",
      timeoutMs: options?.timeoutMs ?? this.config.workerPool.taskTimeoutMs,
      maxRetries: options?.maxRetries ?? 0,
      ownerId: options?.ownerId,
      resourceTags: options?.resourceTags,
      createdAt: Date.now(),
    };

    // Use worker pool if available and configured
    if (this.workerPool) {
      return this.workerPool.submit(task);
    }

    // Otherwise use scheduler - background processor will execute it
    return this.scheduler.schedule(task);
  }

  /**
   * Execute multiple tasks
   */
  async executeAll<TInput, TOutput>(
    type: string,
    inputs: TInput[],
    options?: {
      priority?: TaskPriority;
      timeoutMs?: number;
      ownerId?: string;
      continueOnError?: boolean;
      batchSize?: number;
    },
  ): Promise<TaskResult<TOutput>[]> {
    const tasks = inputs.map((input) => ({
      type,
      input,
      priority: options?.priority ?? "normal",
      timeoutMs: options?.timeoutMs ?? this.config.workerPool.taskTimeoutMs,
      ownerId: options?.ownerId,
      createdAt: Date.now(),
    }));

    if (this.workerPool) {
      return this.workerPool.submitAll(tasks);
    }

    return this.scheduler.scheduleAll(tasks, {
      continueOnError: options?.continueOnError,
      batchSize: options?.batchSize,
    });
  }

  /**
   * Execute a task in parallel with other tasks
   */
  async parallel<TInput, TOutput>(
    tasks: Array<{
      type: string;
      input: TInput;
      priority?: TaskPriority;
      ownerId?: string;
    }>,
  ): Promise<TaskResult<TOutput>[]> {
    const results = await Promise.allSettled(
      tasks.map((t) =>
        this.execute(t.type, t.input, {
          priority: t.priority,
          ownerId: t.ownerId,
        }),
      ),
    );

    return results.map((result, index) => ({
      taskId: `parallel-${index}`,
      status: result.status === "fulfilled" ? "completed" : "failed",
      output: result.status === "fulfilled" ? result.value : undefined,
      error: result.status === "rejected" ? (result.reason as Error) : undefined,
      retryCount: 0,
    }));
  }

  /**
   * Execute tasks sequentially
   */
  async sequential<TInput, TOutput>(
    tasks: Array<{
      type: string;
      input: TInput;
      priority?: TaskPriority;
      ownerId?: string;
    }>,
  ): Promise<TaskResult<TOutput>[]> {
    const results: TaskResult<TOutput>[] = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      try {
        const output = await this.execute(task.type, task.input, {
          priority: task.priority,
          ownerId: task.ownerId,
        });
        results.push({
          taskId: `sequential-${i}`,
          status: "completed",
          output,
          retryCount: 0,
        });
      } catch (error) {
        results.push({
          taskId: `sequential-${i}`,
          status: "failed",
          error: error as Error,
          retryCount: 0,
        });
      }
    }

    return results;
  }

  /**
   * Execute with bounded concurrency
   */
  async bounded<TInput, TOutput>(
    tasks: Array<{
      type: string;
      input: TInput;
      priority?: TaskPriority;
      ownerId?: string;
    }>,
    maxConcurrency: number,
  ): Promise<TaskResult<TOutput>[]> {
    const results: TaskResult<TOutput>[] = [];
    const executing: Promise<void>[] = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const promise = this.execute(task.type, task.input, {
        priority: task.priority,
        ownerId: task.ownerId,
      })
        .then((output) => {
          results[i] = {
            taskId: `bounded-${i}`,
            status: "completed",
            output,
            retryCount: 0,
          };
        })
        .catch((error) => {
          results[i] = {
            taskId: `bounded-${i}`,
            status: "failed",
            error: error as Error,
            retryCount: 0,
          };
        });

      executing.push(promise);

      // Wait for slot when at concurrency limit
      if (executing.length >= maxConcurrency) {
        // Wait for any promise to complete, then remove completed ones
        const completedPromise = await Promise.race(executing.map((p, idx) => p.then(() => idx)));
        executing.splice(completedPromise, 1);
      }
    }

    await Promise.all(executing);
    return results;
  }

  /**
   * Cancel a task
   */
  cancel(taskId: string): boolean {
    if (this.workerPool) {
      return this.workerPool.cancel(taskId);
    }
    return this.scheduler.cancel(taskId);
  }

  /**
   * Cancel all tasks for an owner
   */
  cancelByOwner(ownerId: string): number {
    return this.scheduler.cancelByOwner(ownerId);
  }

  /**
   * Change execution strategy
   */
  setStrategy(strategy: ExecutionStrategy): void {
    this.scheduler.setStrategy(strategy);
  }

  /**
   * Get current metrics
   */
  getMetrics(): ConcurrencyMetrics | undefined {
    return this.lastMetrics;
  }

  /**
   * Get detailed statistics
   */
  getStats() {
    return {
      scheduler: this.scheduler.getStats(),
      workerPool: this.workerPool?.getStats(),
      handlers: Array.from(this.handlers.keys()),
      running: this.running,
    };
  }

  /**
   * Pause processing
   */
  pause(): void {
    this.scheduler.pause();
  }

  /**
   * Resume processing
   */
  resume(): void {
    this.scheduler.resume();
  }

  /**
   * Gracefully shutdown
   */
  async shutdown(timeoutMs = 30000): Promise<void> {
    this.running = false;

    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }

    if (this.taskProcessorInterval) {
      clearInterval(this.taskProcessorInterval);
    }

    await this.scheduler.clear(true);

    if (this.workerPool) {
      await this.workerPool.shutdown(timeoutMs);
    }

    this.removeAllListeners();
  }

  private setupEventForwarding(): void {
    // Forward scheduler events
    this.scheduler.on("event", (event: ConcurrencyEvent) => {
      this.emit("event", event);
    });

    // Forward worker pool events
    if (this.workerPool) {
      this.workerPool.on("event", (event: ConcurrencyEvent) => {
        this.emit("event", event);
      });
    }
  }

  private startMetricsCollection(): void {
    const intervalMs = this.config.metricsIntervalMs ?? 60000;

    this.metricsInterval = setInterval(() => {
      const schedulerStats = this.scheduler.getStats();
      const workerPoolStats = this.workerPool?.getStats();

      const metrics: ConcurrencyMetrics = {
        timestamp: Date.now(),
        workers: {
          total: workerPoolStats?.workers.total ?? 0,
          idle: workerPoolStats?.workers.idle ?? 0,
          busy: workerPoolStats?.workers.busy ?? 0,
          stopping: 0,
          tasksCompleted:
            workerPoolStats?.metrics.tasksCompleted ?? schedulerStats.metrics.completed,
          tasksFailed: workerPoolStats?.metrics.tasksFailed ?? schedulerStats.metrics.failed,
          avgTaskDurationMs: workerPoolStats?.metrics.tasksCompleted
            ? 0 // Calculated from pool metrics
            : 0,
        },
        queue: {
          size: schedulerStats.queue.size,
          pending: schedulerStats.queue.size,
          running: schedulerStats.running,
          completed: schedulerStats.metrics.completed,
          failed: schedulerStats.metrics.failed,
          avgWaitTimeMs: schedulerStats.metrics.avgWaitTimeMs,
        },
        resources: {
          memoryUsedMb: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024),
          memoryAvailableMb: Math.floor(process.memoryUsage().heapTotal / 1024 / 1024),
        },
        byPriority: schedulerStats.metrics.byPriority,
      };

      this.lastMetrics = metrics;
      this.emit("event", { type: "metrics", metrics });
    }, intervalMs);
  }
}

/** Singleton instance */
let defaultManager: ConcurrencyManager | undefined;

export function getConcurrencyManager(options?: ConcurrencyManagerOptions): ConcurrencyManager {
  if (!defaultManager) {
    defaultManager = new ConcurrencyManager(options);
  }
  return defaultManager;
}

export function resetConcurrencyManager(): void {
  defaultManager = undefined;
}
