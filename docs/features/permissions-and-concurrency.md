# Permissions and Concurrency

OpenClaw now includes a comprehensive permission system and concurrent processing capabilities.

## Permission System

The permission system provides role-based access control (RBAC) with hierarchical permission levels.

### Permission Levels

| Level      | Value | Description             |
| ---------- | ----- | ----------------------- |
| superadmin | 1000  | Full system access      |
| admin      | 100   | Administrative access   |
| moderator  | 50    | Moderation capabilities |
| user       | 10    | Standard user           |
| guest      | 0     | Limited guest access    |

### Usage

```typescript
import { getPermissionManager, createGuard } from "openclaw/security/permissions";

// Get the permission manager
const pm = getPermissionManager({
  config: {
    enabled: true,
    defaultRole: "user",
    autoAssignFromAllowlist: true,
  },
});

// Assign roles
pm.assignRole("user123", "admin");

// Check permissions
const result = pm.checkPermission("user123", "command:bash", "global");
if (result.allowed) {
  // Execute command
}

// Use guards
const guard = createGuard({ userId: "user123" });
const check = guard.check("command:execute");

// Require specific permission
guard.require("command:bash", () => {
  // Execute bash command
});
```

### Default Roles

The system includes 5 default roles with predefined permissions:

- **superadmin**: All permissions including system administration
- **admin**: Most permissions except destructive system operations
- **moderator**: Channel management and moderation tools
- **user**: Standard messaging and session management
- **guest**: Read-only and basic messaging

### Custom Roles

Create custom roles with specific permissions:

```typescript
const customRole = {
  id: "developer",
  name: "Developer",
  level: 75,
  permissions: [
    { action: "tools:bash", allow: true, scope: "global" },
    { action: "session:write", allow: true, scope: "global" },
  ],
};

pm.createRole(customRole);
pm.assignRole("dev1", "developer");
```

## Concurrency System

The concurrency system provides multi-threaded task processing with worker pools and intelligent scheduling.

### Features

- **Worker Pool**: Automatic worker thread management
- **Task Scheduling**: Priority-based with fairness
- **Batch Processing**: Execute multiple tasks efficiently
- **Resource Limits**: Control memory and CPU usage
- **Backpressure**: Automatic load shedding when overloaded

### Usage

```typescript
import { getConcurrencyManager } from "openclaw/concurrency";

// Initialize concurrency manager
const cm = getConcurrencyManager({
  config: {
    defaultStrategy: "bounded",
    workerPool: {
      minWorkers: 2,
      maxWorkers: 8,
      useWorkerThreads: true,
      workerScript: "./worker.js",
    },
  },
});

// Register task handlers
cm.registerHandler("process-message", async (task) => {
  const { msgCtx, options } = task.input;
  // Process message
  return { reply: "Hello!" };
});

// Execute tasks
const result = await cm.execute(
  "process-message",
  {
    msgCtx: messageContext,
    options: {},
  },
  {
    priority: "high",
    ownerId: "user123",
    timeoutMs: 30000,
  },
);

// Execute multiple tasks
const results = await cm.executeAll("process-message", messages, {
  continueOnError: true,
  batchSize: 10,
});

// Parallel execution
const parallelResults = await cm.parallel([
  { type: "process-message", input: msg1, priority: "normal" },
  { type: "process-message", input: msg2, priority: "normal" },
]);

// Bounded concurrency
const boundedResults = await cm.bounded(tasks, 5); // Max 5 concurrent
```

### Task Priority

Tasks are scheduled by priority:

| Priority   | Weight | Use Case                   |
| ---------- | ------ | -------------------------- |
| critical   | 100    | System-critical operations |
| high       | 50     | User-facing urgent tasks   |
| normal     | 10     | Standard operations        |
| low        | 5      | Background tasks           |
| background | 1      | Maintenance tasks          |

### Execution Strategies

- **parallel**: Run all tasks simultaneously
- **sequential**: Run tasks one at a time
- **bounded**: Run with maximum concurrency limit
- **priority**: Schedule by priority (default)
- **fair**: Fair scheduling across owners

## Integration with OpenClaw

### Permission Integration

```typescript
import {
  canExecuteCommand,
  createPermissionMiddleware,
  syncPermissionsWithAllowlist,
} from "openclaw/security/permissions/integration";

// In your message handler
const middleware = createPermissionMiddleware({ config, permissionManager });

// Before processing
const { allowed, reason } = middleware.beforeProcess(msgCtx, commandAuth);
if (!allowed) {
  return { error: `Permission denied: ${reason}` };
}

// Before tool execution
const toolCheck = middleware.beforeTool(msgCtx, "bash", commandAuth);
if (!toolCheck.allowed) {
  return { error: "Tool not permitted" };
}
```

### Concurrency Integration

```typescript
import {
  processMessageConcurrent,
  createConcurrentQueueDrainer,
  createConcurrentBroadcast,
} from "openclaw/concurrency/integration";

// Process message with concurrency control
const result = await processMessageConcurrent(
  { config, concurrencyManager },
  { msgCtx, options, sessionKey },
  processor,
);

// Concurrent queue draining
const drainer = createConcurrentQueueDrainer({ config, concurrencyManager }, runFollowup);
await drainer.drain(sessionKey, queuedRuns);

// Concurrent broadcast
const broadcast = createConcurrentBroadcast({ config, concurrencyManager }, sendMessage);
await broadcast.send(targets, message, "bounded");
```

## Configuration

Add to your OpenClaw config:

```json5
{
  permissions: {
    enabled: true,
    defaultRole: "user",
    requireExplicit: false,
    autoAssignFromAllowlist: true,
    allowlistRoleMapping: {
      owner: "admin",
      allowed: "user",
    },
  },
  concurrency: {
    enabled: true,
    defaultStrategy: "bounded",
    workerPool: {
      minWorkers: 2,
      maxWorkers: 8,
      maxTasksPerWorker: 100,
      idleTimeoutMs: 300000,
      taskTimeoutMs: 60000,
      backpressureThreshold: 1000,
    },
    taskQueue: {
      maxSize: 10000,
      fullPolicy: "reject",
      priorityScheduling: true,
      fairScheduling: true,
      ownerQuota: 100,
    },
  },
}
```

## Testing

Run the test suites:

```bash
# Permission tests
pnpm test src/security/permissions/permissions.test.ts

# Concurrency tests
pnpm test src/concurrency/concurrency.test.ts
```
