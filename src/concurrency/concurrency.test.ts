import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ConcurrencyManager,
  TaskScheduler,
  type ConcurrencyConfig,
  type Task,
} from "./index.js";

describe("TaskScheduler", () => {
  let scheduler: TaskScheduler;

  beforeEach(() => {
    scheduler = new TaskScheduler(
      { maxSize: 100, fullPolicy: "reject", priorityScheduling: true, fairScheduling: false },
      { globalLimit: 5, perOwnerLimit: 2 },
      "bounded",
    );
  });

  afterEach(() => {
    scheduler.clear(false);
  });

  describe("Task Scheduling", () => {
    it("should schedule and execute tasks", async () => {
      const task: Omit<Task<string, string>, "id"> = {
        type: "test",
        input: "hello",
        priority: "normal",
        createdAt: Date.now(),
      };

      const promise = scheduler.schedule(task);

      // Mark as started and completed
      const next = scheduler.next();
      expect(next).toBeDefined();

      scheduler.markStarted(next!.id);
      scheduler.markCompleted(next!.id, "result");

      const result = await promise;
      expect(result).toBe("result");
    });

    it("should handle task failures", async () => {
      const task: Omit.Task<string, string>, "id"> = {
        type: "test",
        input: "hello",
        priority: "normal",
        createdAt: Date.now(),
      };

      const promise = scheduler.schedule(task);

      const next = scheduler.next();
      scheduler.markStarted(next!.id);
      scheduler.markFailed(next!.id, new Error("Test error"));

      await expect(promise).rejects.toThrow("Test error");
    });

    it("should respect priority ordering", async () => {
      const results: string[] = [];

      // Schedule low priority first
      scheduler
        .schedule({ type: "test", input: "low", priority: "low", createdAt: Date.now() })
        .then(() => results.push("low"));

      // Then high priority
      scheduler
        .schedule({ type: "test", input: "high", priority: "high", createdAt: Date.now() })
        .then(() => results.push("high"));

      // Process both
      const high = scheduler.next();
      expect(high?.priority).toBe("high");
      scheduler.markStarted(high!.id);
      scheduler.markCompleted(high!.id, "done");

      const low = scheduler.next();
      expect(low?.priority).toBe("low");
      scheduler.markStarted(low!.id);
      scheduler.markCompleted(low!.id, "done");

      // Wait for promises
      await new Promise((r) => setTimeout(r, 10));
      expect(results).toEqual(["high", "low"]);
    });
  });

  describe("Queue Management", () => {
    it("should limit queue size", async () => {
      const smallScheduler = new TaskScheduler(
        { maxSize: 2, fullPolicy: "reject", priorityScheduling: true, fairScheduling: false },
        { globalLimit: 10, perOwnerLimit: 10 },
      );

      // Fill queue
      smallScheduler.schedule({ type: "test", input: "1", priority: "normal", createdAt: Date.now() });
      smallScheduler.schedule({ type: "test", input: "2", priority: "normal", createdAt: Date.now() });

      // Third should reject
      await expect(
        smallScheduler.schedule({ type: "test", input: "3", priority: "normal", createdAt: Date.now() }),
      ).rejects.toThrow("full");
    });

    it("should cancel tasks", async () => {
      const promise = scheduler.schedule({
        type: "test",
        input: "test",
        priority: "normal",
        createdAt: Date.now(),
      });

      const stats = scheduler.getStats();
      expect(stats.queue.size).toBe(1);

      const cancelled = scheduler.cancel("unknown-id");
      expect(cancelled).toBe(false);

      await expect(promise).rejects.toThrow("cancelled");
    });

    it("should cancel by owner", async () => {
      scheduler.schedule({
        type: "test",
        input: "1",
        priority: "normal",
        ownerId: "owner1",
        createdAt: Date.now(),
      });
      scheduler.schedule({
        type: "test",
        input: "2",
        priority: "normal",
        ownerId: "owner1",
        createdAt: Date.now(),
      });
      scheduler.schedule({
        type: "test",
        input: "3",
        priority: "normal",
        ownerId: "owner2",
        createdAt: Date.now(),
      });

      const cancelled = scheduler.cancelByOwner("owner1");
      expect(cancelled).toBe(2);

      const stats = scheduler.getStats();
      expect(stats.queue.size).toBe(1);
    });
  });

  describe("Concurrency Limits", () => {
    it("should respect global limit", () => {
      // Fill to global limit
      for (let i = 0; i < 5; i++) {
        scheduler.schedule({
          type: "test",
          input: i,
          priority: "normal",
          createdAt: Date.now(),
        });
      }

      // Start all
      for (let i = 0; i < 5; i++) {
        const next = scheduler.next();
        if (next) scheduler.markStarted(next.id);
      }

      // Should not return more (global limit = 5)
      const next = scheduler.next();
      expect(next).toBeUndefined();
    });

    it("should respect per-owner limit", () => {
      // Schedule tasks for same owner
      for (let i = 0; i < 3; i++) {
        scheduler.schedule({
          type: "test",
          input: i,
          priority: "normal",
          ownerId: "owner1",
          createdAt: Date.now(),
        });
      }

      // Start two for owner1
      const t1 = scheduler.next();
      if (t1) scheduler.markStarted(t1.id);
      const t2 = scheduler.next();
      if (t2) scheduler.markStarted(t2.id);

      // Third should not be returned (perOwnerLimit = 2)
      const t3 = scheduler.next();
      expect(t3?.ownerId).not.toBe("owner1");
    });
  });

  describe("Batch Operations", () => {
    it("should schedule multiple tasks", async () => {
      const tasks = [1, 2, 3].map((i) => ({
        type: "test",
        input: i,
        priority: "normal" as const,
        createdAt: Date.now(),
      }));

      const promise = scheduler.scheduleAll(tasks);

      // Complete all tasks
      for (let i = 0; i < 3; i++) {
        const next = scheduler.next();
        if (next) {
          scheduler.markStarted(next.id);
          scheduler.markCompleted(next.id, next.input);
        }
      }

      const results = await promise;
      expect(results.length).toBe(3);
      expect(results.every((r) => r.status === "completed")).toBe(true);
    });
  });

  describe("Pause/Resume", () => {
    it("should pause and resume", () => {
      scheduler.pause();

      scheduler.schedule({
        type: "test",
        input: "test",
        priority: "normal",
        createdAt: Date.now(),
      });

      // Should not process while paused
      expect(scheduler.next()).toBeUndefined();

      scheduler.resume();
      expect(scheduler.next()).toBeDefined();
    });
  });

  describe("Statistics", () => {
    it("should track metrics", async () => {
      const promise = scheduler.schedule({
        type: "test",
        input: "test",
        priority: "high",
        createdAt: Date.now(),
      });

      const next = scheduler.next();
      scheduler.markStarted(next!.id);
      scheduler.markCompleted(next!.id, "done");

      await promise;

      const stats = scheduler.getStats();
      expect(stats.metrics.submitted).toBe(1);
      expect(stats.metrics.completed).toBe(1);
      expect(stats.metrics.byPriority.high.submitted).toBe(1);
      expect(stats.metrics.byPriority.high.completed).toBe(1);
    });
  });
});

describe("ConcurrencyManager", () => {
  let cm: ConcurrencyManager;

  beforeEach(() => {
    cm = new ConcurrencyManager({
      config: {
        defaultStrategy: "bounded",
        enableMetrics: true,
        workerPool: {
          useWorkerThreads: false, // Disable for tests
          minWorkers: 1,
          maxWorkers: 2,
        },
      },
    });
  });

  afterEach(async () => {
    await cm.shutdown();
  });

  describe("Task Execution", () => {
    it("should register and execute handlers", async () => {
      cm.registerHandler("double", (task) => {
        const num = task.input as number;
        return num * 2;
      });

      const result = await cm.execute("double", 21);
      expect(result).toBe(42);
    });

    it("should throw for unregistered handlers", async () => {
      await expect(cm.execute("unknown", {})).rejects.toThrow("No handler registered");
    });

    it("should execute multiple tasks", async () => {
      cm.registerHandler("echo", (task) => task.input);

      const results = await cm.executeAll("echo", ["a", "b", "c"]);
      expect(results.length).toBe(3);
      expect(results.map((r) => r.output)).toEqual(["a", "b", "c"]);
    });
  });

  describe("Execution Strategies", () => {
    beforeEach(() => {
      cm.registerHandler("async-task", async (task) => {
        await new Promise((r) => setTimeout(r, 10));
        return task.input;
      });
    });

    it("should execute in parallel", async () => {
      const start = Date.now();
      const results = await cm.parallel([
        { type: "async-task", input: "1" },
        { type: "async-task", input: "2" },
      ]);
      const duration = Date.now() - start;

      expect(results.length).toBe(2);
      expect(duration).toBeLessThan(30); // Should run in parallel
    });

    it("should execute sequentially", async () => {
      const start = Date.now();
      const results = await cm.sequential([
        { type: "async-task", input: "1" },
        { type: "async-task", input: "2" },
      ]);
      const duration = Date.now() - start;

      expect(results.length).toBe(2);
      expect(duration).toBeGreaterThanOrEqual(20); // Should run sequentially
    });

    it("should execute with bounded concurrency", async () => {
      const start = Date.now();
      const results = await cm.bounded(
        [
          { type: "async-task", input: "1" },
          { type: "async-task", input: "2" },
          { type: "async-task", input: "3" },
        ],
        2,
      );
      const duration = Date.now() - start;

      expect(results.length).toBe(3);
      // With concurrency of 2, 3 tasks should take ~20ms (2+1)
      expect(duration).toBeGreaterThanOrEqual(15);
      expect(duration).toBeLessThan(50);
    });
  });

  describe("Statistics", () => {
    it("should provide statistics", () => {
      const stats = cm.getStats();
      expect(stats.scheduler).toBeDefined();
      expect(stats.handlers).toBeDefined();
      expect(stats.running).toBe(true);
    });

    it("should collect metrics", (done) => {
      cm.on("event", (event) => {
        if (event.type === "metrics") {
          expect(event.metrics).toBeDefined();
          expect(event.metrics.timestamp).toBeDefined();
          done();
        }
      });

      // Metrics are collected on interval, trigger manually
      cm.registerHandler("test", (t) => t.input);
      cm.execute("test", {});
    });
  });
});

describe("Default Configuration", () => {
  it("should have sensible defaults", () => {
    const cm = new ConcurrencyManager();
    const stats = cm.getStats();

    expect(stats.scheduler.queue.size).toBe(0);
    expect(stats.running).toBe(true);
  });
});
