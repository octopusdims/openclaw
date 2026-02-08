/**
 * Task Scheduler for OpenClaw
 * Advanced scheduling with priority, fairness, and resource awareness
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  Task,
  TaskResult,
  TaskPriority,
  TaskQueueConfig,
  ConcurrencyLimiterConfig,
  ConcurrencyEvent,
  ExecutionStrategy,
} from "./types.js";
import { DEFAULT_CONCURRENCY_CONFIG, PRIORITY_WEIGHTS } from "./types.js";

/** Scheduled task with metadata */
type ScheduledTask<TInput = unknown, TOutput = unknown> = Task<TInput, TOutput> & {
  resolve: (result: TOutput) => void;
  reject: (error: Error) => void;
  submitTime: number;
  startTime?: number;
  ownerQuotaUsed?: boolean;
};

/** Owner statistics for fair scheduling */
type OwnerStats = {
  id: string;
  queuedTasks: number;
  runningTasks: number;
  totalSubmitted: number;
  lastScheduledAt: number;
};

export class TaskScheduler extends EventEmitter {
  private queue: ScheduledTask[] = [];
  private running = new Map<string, ScheduledTask>();
  private ownerStats = new Map<string, OwnerStats>();
  private queueConfig: Required<TaskQueueConfig>;
  private limiterConfig: Required<ConcurrencyLimiterConfig>;
  private strategy: ExecutionStrategy;
  private metrics = {
    submitted: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    totalWaitTime: 0,
    byPriority: {
      critical: { submitted: 0, completed: 0 },
      high: { submitted: 0, completed: 0 },
      normal: { submitted: 0, completed: 0 },
      low: { submitted: 0, completed: 0 },
      background: { submitted: 0, completed: 0 },
    },
  };

  constructor(
    queueConfig: Partial<TaskQueueConfig> = {},
    limiterConfig: Partial<ConcurrencyLimiterConfig> = {},
    strategy: ExecutionStrategy = "bounded",
  ) {
    super();
    this.queueConfig = {
      ...DEFAULT_CONCURRENCY_CONFIG.taskQueue,
      ...queueConfig,
    } as Required<TaskQueueConfig>;
    this.limiterConfig = {
      ...DEFAULT_CONCURRENCY_CONFIG.limiter,
      ...limiterConfig,
    } as Required<ConcurrencyLimiterConfig>;
    this.strategy = strategy;
  }

  /**
   * Submit a task for scheduling
   */
  schedule<TInput, TOutput>(task: Omit<Task<TInput, TOutput>, "id">): Promise<TOutput> {
    return new Promise((resolve, reject) => {
      // Check queue size limit
      if (this.queueConfig.maxSize > 0 && this.queue.length >= this.queueConfig.maxSize) {
        switch (this.queueConfig.fullPolicy) {
          case "reject":
            reject(new Error("Task queue is full"));
            return;
          case "drop-oldest":
            this.dropOldest();
            break;
          case "drop-newest":
            reject(new Error("Task queue is full (drop-newest policy)"));
            return;
        }
      }

      // Check owner quota
      const ownerId = task.ownerId ?? "default";
      if (this.queueConfig.ownerQuota) {
        const ownerQueued = this.queue.filter((t) => t.ownerId === ownerId).length;
        if (ownerQueued >= this.queueConfig.ownerQuota) {
          reject(new Error(`Owner quota exceeded: ${ownerId}`));
          return;
        }
      }

      const scheduledTask: ScheduledTask<TInput, TOutput> = {
        ...task,
        id: randomUUID(),
        submitTime: Date.now(),
        priority: task.priority ?? "normal",
        resolve,
        reject,
      };

      this.queue.push(scheduledTask);
      this.updateOwnerStats(ownerId, "queued");
      this.metrics.submitted++;
      this.metrics.byPriority[scheduledTask.priority].submitted++;

      this.emitEvent({ type: "task:submitted", task: scheduledTask });

      // Trigger processing
      this.processQueue();
    });
  }

  /**
   * Schedule multiple tasks with batch handling
   */
  async scheduleAll<TInput, TOutput>(
    tasks: Array<Omit<Task<TInput, TOutput>, "id">>,
    options?: {
      continueOnError?: boolean;
      batchSize?: number;
    },
  ): Promise<TaskResult<TOutput>[]> {
    const { continueOnError = true, batchSize = 10 } = options ?? {};
    const results: TaskResult<TOutput>[] = [];

    // Process in batches
    for (let i = 0; i < tasks.length; i += batchSize) {
      const batch = tasks.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(batch.map((task) => this.schedule(task)));

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        results.push({
          taskId: `batch-${i + j}`,
          status: result.status === "fulfilled" ? "completed" : "failed",
          output: result.status === "fulfilled" ? result.value : undefined,
          error: result.status === "rejected" ? (result.reason as Error) : undefined,
          retryCount: 0,
        });
      }

      // Stop on first error if not continuing
      if (!continueOnError && results.some((r) => r.status === "failed")) {
        break;
      }
    }

    return results;
  }

  /**
   * Cancel a scheduled or running task
   */
  cancel(taskId: string): boolean {
    // Check queue
    const queueIndex = this.queue.findIndex((t) => t.id === taskId);
    if (queueIndex !== -1) {
      const task = this.queue.splice(queueIndex, 1)[0];
      this.updateOwnerStats(task.ownerId ?? "default", "cancelled");
      task.reject(new Error("Task cancelled"));
      this.metrics.cancelled++;
      this.emitEvent({ type: "task:cancelled", taskId });
      return true;
    }

    // Check running tasks
    const runningTask = this.running.get(taskId);
    if (runningTask) {
      // Note: Actual cancellation of running tasks depends on the executor
      this.running.delete(taskId);
      this.updateOwnerStats(runningTask.ownerId ?? "default", "completed");
      runningTask.reject(new Error("Task cancelled"));
      this.metrics.cancelled++;
      this.emitEvent({ type: "task:cancelled", taskId });
      return true;
    }

    return false;
  }

  /**
   * Cancel all tasks for an owner
   */
  cancelByOwner(ownerId: string): number {
    let cancelled = 0;

    // Cancel queued tasks
    const toCancel = this.queue.filter((t) => t.ownerId === ownerId);
    for (const task of toCancel) {
      const index = this.queue.indexOf(task);
      if (index !== -1) {
        this.queue.splice(index, 1);
        task.reject(new Error("Cancelled by owner"));
        cancelled++;
      }
    }

    // Cancel running tasks
    for (const [id, task] of this.running.entries()) {
      if (task.ownerId === ownerId) {
        this.running.delete(id);
        task.reject(new Error("Cancelled by owner"));
        cancelled++;
      }
    }

    this.metrics.cancelled += cancelled;
    return cancelled;
  }

  /**
   * Mark a task as started (called by executor)
   */
  markStarted(taskId: string): boolean {
    const task = this.queue.find((t) => t.id === taskId);
    if (!task) return false;

    const index = this.queue.indexOf(task);
    this.queue.splice(index, 1);

    task.startTime = Date.now();
    this.running.set(taskId, task);
    this.updateOwnerStats(task.ownerId ?? "default", "started");

    return true;
  }

  /**
   * Mark a task as completed (called by executor)
   */
  markCompleted<TOutput>(taskId: string, output: TOutput): void {
    const task = this.running.get(taskId);
    if (!task) return;

    this.running.delete(taskId);
    this.updateOwnerStats(task.ownerId ?? "default", "completed");

    const waitTime = (task.startTime ?? Date.now()) - task.submitTime;
    this.metrics.totalWaitTime += waitTime;
    this.metrics.completed++;
    this.metrics.byPriority[task.priority].completed++;

    this.emitEvent({
      type: "task:completed",
      result: {
        taskId,
        status: "completed",
        output,
        retryCount: task.retryCount ?? 0,
      },
    });

    task.resolve(output);
    this.processQueue();
  }

  /**
   * Mark a task as failed (called by executor)
   */
  markFailed(taskId: string, error: Error): void {
    const task = this.running.get(taskId);
    if (!task) return;

    this.running.delete(taskId);
    this.updateOwnerStats(task.ownerId ?? "default", "completed");

    this.metrics.failed++;

    this.emitEvent({
      type: "task:failed",
      result: {
        taskId,
        status: "failed",
        error,
        retryCount: task.retryCount ?? 0,
      },
    });

    task.reject(error);
    this.processQueue();
  }

  /**
   * Get next task for execution (called by executor)
   */
  next(): Task | undefined {
    if (this.queue.length === 0) return undefined;

    // Check concurrency limits
    if (this.running.size >= this.limiterConfig.globalLimit) {
      return undefined;
    }

    // Sort queue based on strategy
    this.sortQueue();

    // Find task that respects per-owner limits
    for (const task of this.queue) {
      const ownerId = task.ownerId ?? "default";
      const ownerRunning = Array.from(this.running.values()).filter(
        (t) => t.ownerId === ownerId,
      ).length;

      if (ownerRunning < this.limiterConfig.perOwnerLimit) {
        return task;
      }
    }

    return undefined;
  }

  /**
   * Get scheduler statistics
   */
  getStats() {
    const avgWaitTime =
      this.metrics.completed > 0 ? this.metrics.totalWaitTime / this.metrics.completed : 0;

    return {
      queue: {
        size: this.queue.length,
        byPriority: {
          critical: this.queue.filter((t) => t.priority === "critical").length,
          high: this.queue.filter((t) => t.priority === "high").length,
          normal: this.queue.filter((t) => t.priority === "normal").length,
          low: this.queue.filter((t) => t.priority === "low").length,
          background: this.queue.filter((t) => t.priority === "background").length,
        },
      },
      running: this.running.size,
      metrics: { ...this.metrics, avgWaitTimeMs: avgWaitTime },
      owners: Array.from(this.ownerStats.values()),
    };
  }

  /**
   * Change execution strategy
   */
  setStrategy(strategy: ExecutionStrategy): void {
    this.strategy = strategy;
  }

  /**
   * Pause scheduling (stop dispatching new tasks)
   */
  pause(): void {
    this.paused = true;
  }

  /**
   * Resume scheduling
   */
  resume(): void {
    this.paused = false;
    this.processQueue();
  }

  private paused = false;

  /**
   * Clear all queued tasks
   */
  clear(cancelTasks = true): number {
    const count = this.queue.length;

    if (cancelTasks) {
      for (const task of this.queue) {
        task.reject(new Error("Queue cleared"));
      }
    }

    this.queue = [];
    return count;
  }

  private processQueue(): void {
    if (this.paused) return;

    // Sort queue
    this.sortQueue();

    // Emit backpressure if needed
    if (this.queue.length > this.queueConfig.maxSize * 0.9) {
      this.emitEvent({
        type: "queue:backpressure",
        queueSize: this.queue.length,
      });
    }
  }

  private sortQueue(): void {
    switch (this.strategy) {
      case "priority":
        this.sortByPriority();
        break;
      case "fair":
        this.sortByFairness();
        break;
      case "sequential":
        // Keep FIFO order
        break;
      case "parallel":
      case "bounded":
      default:
        this.sortByPriority();
        break;
    }
  }

  private sortByPriority(): void {
    this.queue.sort((a, b) => {
      const weightA = PRIORITY_WEIGHTS[a.priority] ?? 10;
      const weightB = PRIORITY_WEIGHTS[b.priority] ?? 10;
      if (weightA !== weightB) {
        return weightB - weightA;
      }
      return a.submitTime - b.submitTime;
    });
  }

  private sortByFairness(): void {
    this.queue.sort((a, b) => {
      // First by priority
      const weightA = PRIORITY_WEIGHTS[a.priority] ?? 10;
      const weightB = PRIORITY_WEIGHTS[b.priority] ?? 10;
      if (weightA !== weightB) {
        return weightB - weightA;
      }

      // Then by owner's recent activity (fairness)
      const statsA = this.ownerStats.get(a.ownerId ?? "default");
      const statsB = this.ownerStats.get(b.ownerId ?? "default");
      const lastScheduledA = statsA?.lastScheduledAt ?? 0;
      const lastScheduledB = statsB?.lastScheduledAt ?? 0;

      if (lastScheduledA !== lastScheduledB) {
        return lastScheduledA - lastScheduledB;
      }

      // Finally FIFO
      return a.submitTime - b.submitTime;
    });
  }

  private dropOldest(): void {
    // Find lowest priority oldest task
    const toDrop = this.queue
      .filter((t) => t.priority !== "critical")
      .sort((a, b) => a.submitTime - b.submitTime)[0];

    if (toDrop) {
      const index = this.queue.indexOf(toDrop);
      this.queue.splice(index, 1);
      toDrop.reject(new Error("Dropped due to queue pressure"));
      this.updateOwnerStats(toDrop.ownerId ?? "default", "cancelled");
    }
  }

  private updateOwnerStats(
    ownerId: string,
    action: "queued" | "started" | "completed" | "cancelled",
  ): void {
    let stats = this.ownerStats.get(ownerId);
    if (!stats) {
      stats = {
        id: ownerId,
        queuedTasks: 0,
        runningTasks: 0,
        totalSubmitted: 0,
        lastScheduledAt: 0,
      };
      this.ownerStats.set(ownerId, stats);
    }

    switch (action) {
      case "queued":
        stats.queuedTasks++;
        stats.totalSubmitted++;
        break;
      case "started":
        stats.queuedTasks--;
        stats.runningTasks++;
        stats.lastScheduledAt = Date.now();
        break;
      case "completed":
        stats.runningTasks = Math.max(0, stats.runningTasks - 1);
        break;
      case "cancelled":
        stats.queuedTasks = Math.max(0, stats.queuedTasks - 1);
        break;
    }
  }

  private emitEvent(event: ConcurrencyEvent): void {
    this.emit("event", event);
  }
}
