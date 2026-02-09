import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConcurrencyManager, TaskScheduler, type Task } from "./index.js";

// 设置全局测试超时时间为 5s
const TEST_TIMEOUT = 5000;

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
    it("should schedule and execute tasks", { timeout: TEST_TIMEOUT }, async () => {
      const task: Omit<Task<string, string>, "id"> = {
        type: "test",
        input: "hello",
        priority: "normal",
        createdAt: Date.now(),
      };

      const promise = scheduler.schedule(task);

      const next = scheduler.next();
      expect(next).toBeDefined();

      scheduler.markStarted(next!.id);
      scheduler.markCompleted(next!.id, "result");

      const result = await promise;
      expect(result).toBe("result");
    });

    it("should handle task failures", { timeout: TEST_TIMEOUT }, async () => {
      const task: Omit<Task<string, string>, "id"> = {
        type: "test",
        input: "hello",
        priority: "normal",
        createdAt: Date.now(),
      };

      const promise = scheduler.schedule(task);

      const next = scheduler.next();
      expect(next).toBeDefined();
      scheduler.markStarted(next!.id);
      scheduler.markFailed(next!.id, new Error("Test error"));

      await expect(promise).rejects.toThrow("Test error");
    });

    it("should respect priority ordering", { timeout: TEST_TIMEOUT }, async () => {
      const results: string[] = [];

      // 调度低优先级任务
      const lowPromise = scheduler
        .schedule({ type: "test", input: "low", priority: "low", createdAt: Date.now() })
        .then(() => results.push("low"));

      // 调度高优先级任务
      const highPromise = scheduler
        .schedule({ type: "test", input: "high", priority: "high", createdAt: Date.now() })
        .then(() => results.push("high"));

      // 第一次取出的应该是高优先级
      const highTask = scheduler.next();
      expect(highTask?.priority).toBe("high");
      scheduler.markStarted(highTask!.id);
      scheduler.markCompleted(highTask!.id, "done");

      // 第二次取出的是低优先级
      const lowTask = scheduler.next();
      expect(lowTask?.priority).toBe("low");
      scheduler.markStarted(lowTask!.id);
      scheduler.markCompleted(lowTask!.id, "done");

      await Promise.all([highPromise, lowPromise]);
      // 验证执行顺序
      expect(results).toEqual(["high", "low"]);
    });
  });

  describe("Queue Management", () => {
    it("should limit queue size", { timeout: TEST_TIMEOUT }, async () => {
      const smallScheduler = new TaskScheduler(
        { maxSize: 2, fullPolicy: "reject", priorityScheduling: true, fairScheduling: false },
        { globalLimit: 10, perOwnerLimit: 10 },
      );

      smallScheduler.schedule({
        type: "test",
        input: "1",
        priority: "normal",
        createdAt: Date.now(),
      });
      smallScheduler.schedule({
        type: "test",
        input: "2",
        priority: "normal",
        createdAt: Date.now(),
      });

      // 第三次提交应因为队列满而拒绝
      await expect(
        smallScheduler.schedule({
          type: "test",
          input: "3",
          priority: "normal",
          createdAt: Date.now(),
        }),
      ).rejects.toThrow(/full|limit/i);
    });

    it("should cancel tasks", { timeout: TEST_TIMEOUT }, async () => {
      const promise = scheduler.schedule({
        type: "test",
        input: "test",
        priority: "normal",
        createdAt: Date.now(),
      });

      // 获取自动生成的 ID
      const taskInQueue = scheduler.next();
      expect(taskInQueue).toBeDefined();

      // 使用正确的 ID 取消
      const cancelled = scheduler.cancel(taskInQueue!.id);
      expect(cancelled).toBe(true);

      await expect(promise).rejects.toThrow(/cancel/i);
    });

    it("should cancel by owner", { timeout: TEST_TIMEOUT }, async () => {
      const owner1Tasks = [
        scheduler.schedule({
          type: "test",
          input: "1",
          priority: "normal",
          ownerId: "owner1",
          createdAt: Date.now(),
        }),
        scheduler.schedule({
          type: "test",
          input: "2",
          priority: "normal",
          ownerId: "owner1",
          createdAt: Date.now(),
        }),
      ];

      scheduler.schedule({
        type: "test",
        input: "3",
        priority: "normal",
        ownerId: "owner2",
        createdAt: Date.now(),
      });

      const cancelledCount = scheduler.cancelByOwner("owner1");
      expect(cancelledCount).toBe(2);

      await Promise.all(owner1Tasks.map((p) => expect(p).rejects.toThrow(/cancel/i)));

      const stats = scheduler.getStats();
      // 只剩下 owner2 的一个任务
      expect(stats.queue.size).toBe(1);
    });
  });

  describe("Concurrency Limits", () => {
    it("should respect global limit", () => {
      for (let i = 0; i < 5; i++) {
        scheduler.schedule({ type: "test", input: i, priority: "normal", createdAt: Date.now() });
      }

      // 启动 5 个任务（达到全局上限）
      for (let i = 0; i < 5; i++) {
        const next = scheduler.next();
        if (next) {
          scheduler.markStarted(next.id);
        }
      }

      // 全局限制为 5，此时 next 应该返回 undefined
      const next = scheduler.next();
      expect(next).toBeUndefined();
    });

    it("should respect per-owner limit", () => {
      for (let i = 0; i < 3; i++) {
        scheduler.schedule({
          type: "test",
          input: i,
          priority: "normal",
          ownerId: "owner1",
          createdAt: Date.now(),
        });
      }

      // 启动该 owner 的 2 个任务（达到 perOwnerLimit）
      const t1 = scheduler.next();
      if (t1) {
        scheduler.markStarted(t1.id);
      }
      const t2 = scheduler.next();
      if (t2) {
        scheduler.markStarted(t2.id);
      }

      // 第 3 个任务虽然在队列中，但不应被取出
      const t3 = scheduler.next();
      expect(t3).toBeUndefined();
    });
  });

  describe("Batch Operations", () => {
    it("should schedule multiple tasks", { timeout: TEST_TIMEOUT }, async () => {
      const tasks = [1, 2, 3].map((i) => ({
        type: "test",
        input: i,
        priority: "normal" as const,
        createdAt: Date.now(),
      }));

      const batchPromise = scheduler.scheduleAll(tasks);

      // 模拟工作流：取出、开始、完成
      for (let i = 0; i < 3; i++) {
        const next = scheduler.next();
        if (next) {
          scheduler.markStarted(next.id);
          scheduler.markCompleted(next.id, next.input);
        }
      }

      const results = await batchPromise;
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
        metricsIntervalMs: 100, // Short interval for testing
        workerPool: {
          useWorkerThreads: false,
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
    it("should register and execute handlers", { timeout: TEST_TIMEOUT }, async () => {
      cm.registerHandler("double", (task) => (task.input as number) * 2);
      const result = await cm.execute("double", 21);
      expect(result).toBe(42);
    });

    it("should throw for unregistered handlers", async () => {
      await expect(cm.execute("unknown", {})).rejects.toThrow(/No handler registered/);
    });
  });

  describe("Execution Strategies", () => {
    beforeEach(() => {
      cm.registerHandler("async-task", async (task) => {
        await new Promise((r) => setTimeout(r, 20)); // 稍微增加延迟以提高测试稳定性
        return task.input;
      });
    });

    it("should execute in parallel", { timeout: TEST_TIMEOUT }, async () => {
      const start = Date.now();
      const results = await cm.parallel([
        { type: "async-task", input: "1" },
        { type: "async-task", input: "2" },
      ]);
      const duration = Date.now() - start;

      expect(results.length).toBe(2);
      // 并行执行时间应接近单次任务时间（< 40ms），而非累加时间（> 40ms）
      expect(duration).toBeLessThan(40);
    });

    it("should execute sequentially", { timeout: TEST_TIMEOUT }, async () => {
      const start = Date.now();
      const results = await cm.sequential([
        { type: "async-task", input: "1" },
        { type: "async-task", input: "2" },
      ]);
      const duration = Date.now() - start;

      expect(results.length).toBe(2);
      // 串行执行时间应大于等于任务时间之和
      expect(duration).toBeGreaterThanOrEqual(40);
    });

    it("should execute with bounded concurrency", { timeout: TEST_TIMEOUT }, async () => {
      const start = Date.now();
      // 3个任务，每个20ms，并发度2。预期耗时约 40ms
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
      expect(duration).toBeGreaterThanOrEqual(40);
      expect(duration).toBeLessThan(60);
    });
  });

  describe("Statistics & Events", () => {
    it("should provide statistics", () => {
      const stats = cm.getStats();
      expect(stats.scheduler).toBeDefined();
      expect(stats.running).toBe(true);
    });

    it("should collect metrics via events", { timeout: TEST_TIMEOUT }, async () => {
      const metricsPromise = new Promise<void>((resolve) => {
        cm.on("event", (event) => {
          if (event.type === "metrics") {
            resolve();
          }
        });
      });

      cm.registerHandler("test", (t) => t.input);
      // 触发执行以产生指标
      await cm.execute("test", {});

      // 注意：如果 metrics 是定时触发，可能需要手动调用触发方法或等待
      await expect(metricsPromise).resolves.toBeUndefined();
    });
  });
});
