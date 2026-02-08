/**
 * Worker Pool for OpenClaw
 * Manages a pool of workers for concurrent task execution
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import type {
  Task,
  TaskResult,
  WorkerInfo,
  WorkerPoolConfig,
  TaskPriority,
  ConcurrencyEvent,
  BatchTask,
} from "./types.js";
import { DEFAULT_CONCURRENCY_CONFIG, PRIORITY_WEIGHTS } from "./types.js";

/** Task with internal tracking */
type InternalTask<TInput = unknown, TOutput = unknown> = Task<TInput, TOutput> & {
  resolve: (result: TOutput) => void;
  reject: (error: Error) => void;
  submitTime: number;
  startTime?: number;
};

/** Worker wrapper with state management */
class WorkerWrapper {
  public info: WorkerInfo;
  public worker?: Worker;
  public currentTask?: string;
  private messageHandler?: (result: TaskResult) => void;
  private errorHandler?: (error: Error) => void;

  constructor(
    id: string,
    private pool: WorkerPool,
  ) {
    this.info = {
      id,
      state: "idle",
      tasksCompleted: 0,
      tasksFailed: 0,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
    };
  }

  async spawn(
    scriptPath: string,
    resourceLimits?: WorkerPoolConfig["resourceLimits"],
  ): Promise<void> {
    this.worker = new Worker(scriptPath, {
      resourceLimits: resourceLimits
        ? {
            maxOldGenerationSizeMb: resourceLimits.maxOldGenerationSizeMb,
            maxYoungGenerationSizeMb: resourceLimits.maxYoungGenerationSizeMb,
          }
        : undefined,
    });

    this.worker.on("message", (result: TaskResult) => {
      if (this.messageHandler) {
        this.messageHandler(result);
      }
    });

    this.worker.on("error", (error) => {
      if (this.errorHandler) {
        this.errorHandler(error);
      }
    });

    this.worker.on("exit", (code) => {
      if (code !== 0) {
        this.pool.emitEvent({
          type: "worker:error",
          workerId: this.info.id,
          error: new Error(`Worker exited with code ${code}`),
        });
      }
      this.info.state = "stopped";
    });
  }

  assignTask<TInput, TOutput>(
    task: InternalTask<TInput, TOutput>,
    timeoutMs: number,
  ): Promise<TaskResult<TOutput>> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error("Worker not spawned"));
        return;
      }

      this.currentTask = task.id;
      this.info.state = "busy";
      this.info.currentTask = task.id;
      this.info.lastActivityAt = Date.now();

      const timeout = setTimeout(() => {
        this.cleanup();
        resolve({
          taskId: task.id,
          status: "timeout",
          error: new Error(`Task timeout after ${timeoutMs}ms`),
          retryCount: task.retryCount ?? 0,
        });
      }, timeoutMs);

      this.messageHandler = (result: TaskResult) => {
        clearTimeout(timeout);
        this.cleanup();
        resolve(result as TaskResult<TOutput>);
      };

      this.errorHandler = (error: Error) => {
        clearTimeout(timeout);
        this.cleanup();
        resolve({
          taskId: task.id,
          status: "failed",
          error,
          retryCount: task.retryCount ?? 0,
        });
      };

      this.worker.postMessage({ type: "task", task }, task.transferList ?? []);
    });
  }

  private cleanup(): void {
    this.currentTask = undefined;
    this.info.state = "idle";
    this.info.currentTask = undefined;
    this.info.lastActivityAt = Date.now();
    this.messageHandler = undefined;
    this.errorHandler = undefined;
  }

  async stop(): Promise<void> {
    this.info.state = "stopping";
    if (this.worker) {
      await this.worker.terminate();
    }
    this.info.state = "stopped";
  }

  updateMemoryUsage(): void {
    if (this.worker) {
      this.info.memoryUsage = process.memoryUsage();
    }
  }
}

export class WorkerPool extends EventEmitter {
  private workers: Map<string, WorkerWrapper> = new Map();
  private taskQueue: InternalTask[] = [];
  private batchQueue: Map<string, InternalTask[]> = new Map();
  private runningTasks: Map<string, { workerId: string; task: InternalTask }> = new Map();
  private config: Required<WorkerPoolConfig>;
  private idleTimers: Map<string, NodeJS.Timeout> = new Map();
  private batchTimer?: NodeJS.Timeout;
  private metrics = {
    tasksCompleted: 0,
    tasksFailed: 0,
    totalTaskDuration: 0,
    byPriority: {
      critical: { submitted: 0, completed: 0 },
      high: { submitted: 0, completed: 0 },
      normal: { submitted: 0, completed: 0 },
      low: { submitted: 0, completed: 0 },
      background: { submitted: 0, completed: 0 },
    },
  };

  constructor(config: Partial<WorkerPoolConfig> = {}) {
    super();
    this.config = {
      ...DEFAULT_CONCURRENCY_CONFIG.workerPool,
      ...config,
    } as Required<WorkerPoolConfig>;

    this.startBatchTimer();
  }

  /**
   * Submit a task to the worker pool
   */
  async submit<TInput, TOutput>(task: Omit<Task<TInput, TOutput>, "id">): Promise<TOutput> {
    const fullTask: InternalTask<TInput, TOutput> = {
      ...task,
      id: randomUUID(),
      submitTime: Date.now(),
      priority: task.priority ?? "normal",
      resolve: () => {},
      reject: () => {},
    };

    this.metrics.byPriority[fullTask.priority].submitted++;

    return new Promise<TOutput>((resolve, reject) => {
      fullTask.resolve = resolve;
      fullTask.reject = reject;

      if (task.batchable && this.config.enableBatching) {
        this.addToBatch(fullTask);
      } else {
        this.taskQueue.push(fullTask);
        this.processQueue();
      }

      this.emitEvent({ type: "task:submitted", task: fullTask });
    });
  }

  /**
   * Submit multiple tasks
   */
  async submitAll<TInput, TOutput>(
    tasks: Array<Omit<Task<TInput, TOutput>, "id">>,
  ): Promise<TaskResult<TOutput>[]> {
    const results = await Promise.allSettled(tasks.map((task) => this.submit(task)));

    return results.map((result, index) => ({
      taskId: `batch-${index}`,
      status: result.status === "fulfilled" ? "completed" : "failed",
      output: result.status === "fulfilled" ? result.value : undefined,
      error: result.status === "rejected" ? (result.reason as Error) : undefined,
      retryCount: 0,
    }));
  }

  /**
   * Cancel a pending task
   */
  cancel(taskId: string): boolean {
    const index = this.taskQueue.findIndex((t) => t.id === taskId);
    if (index !== -1) {
      const task = this.taskQueue.splice(index, 1)[0];
      task.reject(new Error("Task cancelled"));
      this.emitEvent({ type: "task:cancelled", taskId });
      return true;
    }
    return false;
  }

  /**
   * Get current pool statistics
   */
  getStats() {
    return {
      workers: {
        total: this.workers.size,
        idle: Array.from(this.workers.values()).filter((w) => w.info.state === "idle").length,
        busy: Array.from(this.workers.values()).filter((w) => w.info.state === "busy").length,
      },
      queue: {
        size: this.taskQueue.length,
        pending: this.taskQueue.filter((t) => t.startTime === undefined).length,
      },
      running: this.runningTasks.size,
      metrics: { ...this.metrics },
    };
  }

  /**
   * Gracefully shutdown the pool
   */
  async shutdown(timeoutMs = 30000): Promise<void> {
    // Stop accepting new tasks
    this.removeAllListeners();

    // Clear batch timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    // Wait for running tasks or timeout
    const startTime = Date.now();
    while (this.runningTasks.size > 0 && Date.now() - startTime < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // Cancel remaining queued tasks
    for (const task of this.taskQueue) {
      task.reject(new Error("Pool shutting down"));
    }
    this.taskQueue = [];

    // Stop all workers
    await Promise.all(Array.from(this.workers.values()).map((w) => w.stop()));
    this.workers.clear();

    // Clear idle timers
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
  }

  private addToBatch(task: InternalTask): void {
    const batchKey = task.type;
    if (!this.batchQueue.has(batchKey)) {
      this.batchQueue.set(batchKey, []);
    }
    this.batchQueue.get(batchKey)!.push(task);

    // Process batch immediately if it reaches max size
    const batch = this.batchQueue.get(batchKey)!;
    if (batch.length >= this.config.maxBatchSize!) {
      this.processBatch(batchKey);
    }
  }

  private startBatchTimer(): void {
    if (!this.config.enableBatching) return;

    this.batchTimer = setInterval(() => {
      for (const [key, batch] of this.batchQueue.entries()) {
        if (batch.length > 0) {
          this.processBatch(key);
        }
      }
    }, this.config.batchWindowMs);
  }

  private processBatch(batchKey: string): void {
    const batch = this.batchQueue.get(batchKey);
    if (!batch || batch.length === 0) return;

    this.batchQueue.set(batchKey, []);

    const batchTask: BatchTask = {
      tasks: batch,
      batchId: randomUUID(),
      batchType: batchKey,
      createdAt: Date.now(),
    };

    this.emitEvent({ type: "batch:formed", batch: batchTask });

    // For now, process batch items individually through workers
    // In a real implementation, you might have specialized batch workers
    for (const task of batch) {
      this.taskQueue.push(task);
    }
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    // Check backpressure
    if (this.taskQueue.length > this.config.backpressureThreshold) {
      this.emitEvent({
        type: "queue:backpressure",
        queueSize: this.taskQueue.length,
      });
    }

    // Sort queue by priority (higher weight = earlier)
    this.taskQueue.sort((a, b) => {
      const weightA = this.config.priorityWeights![a.priority] ?? 10;
      const weightB = this.config.priorityWeights![b.priority] ?? 10;
      if (weightA !== weightB) {
        return weightB - weightA;
      }
      // FIFO for same priority
      return a.submitTime - b.submitTime;
    });

    // Try to assign tasks to workers
    while (this.taskQueue.length > 0) {
      const task = this.taskQueue[0];
      const worker = await this.acquireWorker();

      if (!worker) {
        // No worker available, wait
        break;
      }

      this.taskQueue.shift();
      this.executeTask(worker, task);
    }

    if (this.taskQueue.length === 0) {
      this.emitEvent({ type: "queue:drained" });
    }
  }

  private async acquireWorker(): Promise<WorkerWrapper | undefined> {
    // Find idle worker
    for (const worker of this.workers.values()) {
      if (worker.info.state === "idle") {
        // Clear idle timer if exists
        const timer = this.idleTimers.get(worker.info.id);
        if (timer) {
          clearTimeout(timer);
          this.idleTimers.delete(worker.info.id);
        }
        return worker;
      }
    }

    // Create new worker if under max
    if (this.workers.size < this.config.maxWorkers) {
      const worker = await this.spawnWorker();
      return worker;
    }

    return undefined;
  }

  private async spawnWorker(): Promise<WorkerWrapper> {
    const id = randomUUID();
    const worker = new WorkerWrapper(id, this);

    if (this.config.workerScript) {
      await worker.spawn(this.config.workerScript, this.config.resourceLimits);
    }

    this.workers.set(id, worker);
    this.emitEvent({ type: "worker:spawned", workerId: id });

    return worker;
  }

  private async executeTask(worker: WorkerWrapper, task: InternalTask): Promise<void> {
    task.startTime = Date.now();
    this.runningTasks.set(task.id, { workerId: worker.info.id, task });

    this.emitEvent({
      type: "task:started",
      taskId: task.id,
      workerId: worker.info.id,
    });

    try {
      const timeoutMs = task.timeoutMs ?? this.config.taskTimeoutMs;
      const result = await worker.assignTask(task, timeoutMs);

      this.runningTasks.delete(task.id);

      // Update metrics
      if (result.status === "completed") {
        this.metrics.tasksCompleted++;
        this.metrics.byPriority[task.priority].completed++;
        worker.info.tasksCompleted++;
        if (task.startTime) {
          this.metrics.totalTaskDuration += Date.now() - task.startTime;
        }
        this.emitEvent({ type: "task:completed", result });
        task.resolve(result.output as unknown as undefined);
      } else {
        this.metrics.tasksFailed++;
        worker.info.tasksFailed++;
        this.emitEvent({ type: "task:failed", result });
        task.reject(result.error ?? new Error("Task failed"));
      }

      // Check if worker needs recycling
      if (worker.info.tasksCompleted >= this.config.maxTasksPerWorker) {
        await this.recycleWorker(worker);
      } else {
        this.scheduleIdleTimer(worker);
      }

      // Process more tasks
      this.processQueue();
    } catch (error) {
      this.runningTasks.delete(task.id);
      task.reject(error as Error);
      this.recycleWorker(worker);
    }
  }

  private scheduleIdleTimer(worker: WorkerWrapper): void {
    // Only schedule if we have more than min workers
    if (this.workers.size <= this.config.minWorkers) {
      return;
    }

    const timer = setTimeout(async () => {
      if (worker.info.state === "idle") {
        await worker.stop();
        this.workers.delete(worker.info.id);
        this.idleTimers.delete(worker.info.id);
        this.emitEvent({
          type: "worker:stopped",
          workerId: worker.info.id,
        });
      }
    }, this.config.idleTimeoutMs);

    this.idleTimers.set(worker.info.id, timer);
  }

  private async recycleWorker(worker: WorkerWrapper): Promise<void> {
    await worker.stop();
    this.workers.delete(worker.info.id);
    this.idleTimers.delete(worker.info.id);
    this.emitEvent({ type: "worker:stopped", workerId: worker.info.id });
  }

  private emitEvent(event: ConcurrencyEvent): void {
    this.emit("event", event);
  }
}
