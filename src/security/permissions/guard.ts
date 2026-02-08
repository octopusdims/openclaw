/**
 * Permission Guards for OpenClaw
 * Provides middleware and decorators for protecting commands and actions
 */

import type { PermissionManager } from "./manager.js";
import type { PermissionAction, PermissionScope } from "./types.js";
import { getPermissionManager } from "./manager.js";

export type GuardOptions = {
  /** Permission manager instance (uses default if not provided) */
  permissionManager?: PermissionManager;
  /** Action to check */
  action: PermissionAction;
  /** Scope of the permission check */
  scope?: PermissionScope;
  /** Custom error message */
  errorMessage?: string;
  /** Whether to throw on denial (default: true) */
  throwOnDenial?: boolean;
  /** Optional callback for audit logging */
  onCheck?: (result: GuardResult) => void;
};

export type GuardResult = {
  allowed: boolean;
  userId: string;
  action: PermissionAction;
  scope: PermissionScope;
  scopeId?: string;
  reason?: string;
};

export type GuardContext = {
  userId: string;
  scopeId?: string;
  channelId?: string;
  agentId?: string;
  sessionId?: string;
};

export class PermissionGuardError extends Error {
  constructor(
    message: string,
    public readonly userId: string,
    public readonly action: PermissionAction,
    public readonly scope: PermissionScope,
  ) {
    super(message);
    this.name = "PermissionGuardError";
  }
}

/**
 * Check permission and return result without throwing
 */
export function checkGuard(context: GuardContext, options: GuardOptions): GuardResult {
  const pm = options.permissionManager ?? getPermissionManager();
  const scope = options.scope ?? inferScope(context);
  const scopeId = resolveScopeId(context, scope);

  const result = pm.checkPermission(context.userId, options.action, scope, scopeId);

  const guardResult: GuardResult = {
    allowed: result.allowed,
    userId: context.userId,
    action: options.action,
    scope,
    scopeId,
    reason: result.reason,
  };

  if (options.onCheck) {
    options.onCheck(guardResult);
  }

  return guardResult;
}

/**
 * Guard a function execution with permission check
 */
export function guard<T extends (...args: unknown[]) => unknown>(
  context: GuardContext,
  options: GuardOptions,
  fn: T,
): ReturnType<T> {
  const result = checkGuard(context, options);

  if (!result.allowed) {
    const throwOnDenial = options.throwOnDenial ?? true;
    if (throwOnDenial) {
      throw new PermissionGuardError(
        options.errorMessage ?? `Permission denied: ${options.action}`,
        context.userId,
        options.action,
        result.scope,
      );
    }
    return undefined as ReturnType<T>;
  }

  return fn() as ReturnType<T>;
}

/**
 * Async guard for async functions
 */
export async function guardAsync<T>(
  context: GuardContext,
  options: GuardOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const result = checkGuard(context, options);

  if (!result.allowed) {
    const throwOnDenial = options.throwOnDenial ?? true;
    if (throwOnDenial) {
      throw new PermissionGuardError(
        options.errorMessage ?? `Permission denied: ${options.action}`,
        context.userId,
        options.action,
        result.scope,
      );
    }
    return undefined as T;
  }

  return await fn();
}

/**
 * Create a reusable guard for a specific context
 */
export function createGuard(context: GuardContext, defaultOptions?: Partial<GuardOptions>) {
  return {
    check: (action: PermissionAction, options?: Partial<GuardOptions>) => {
      return checkGuard(context, {
        action,
        ...defaultOptions,
        ...options,
      } as GuardOptions);
    },

    require: <T extends (...args: unknown[]) => unknown>(
      action: PermissionAction,
      fn: T,
      options?: Partial<GuardOptions>,
    ) => {
      return guard(context, { action, ...defaultOptions, ...options } as GuardOptions, fn);
    },

    requireAsync: <T>(
      action: PermissionAction,
      fn: () => Promise<T>,
      options?: Partial<GuardOptions>,
    ) => {
      return guardAsync(context, { action, ...defaultOptions, ...options } as GuardOptions, fn);
    },

    /**
     * Check if user has any of the specified permissions
     */
    checkAny: (actions: PermissionAction[], options?: Partial<GuardOptions>) => {
      for (const action of actions) {
        const result = checkGuard(context, {
          action,
          ...defaultOptions,
          ...options,
        } as GuardOptions);
        if (result.allowed) {
          return result;
        }
      }
      return {
        allowed: false,
        userId: context.userId,
        action: actions[0],
        scope: defaultOptions?.scope ?? inferScope(context),
        reason: "None of the required permissions granted",
      } as GuardResult;
    },

    /**
     * Check if user has all of the specified permissions
     */
    checkAll: (actions: PermissionAction[], options?: Partial<GuardOptions>) => {
      for (const action of actions) {
        const result = checkGuard(context, {
          action,
          ...defaultOptions,
          ...options,
        } as GuardOptions);
        if (!result.allowed) {
          return result;
        }
      }
      return {
        allowed: true,
        userId: context.userId,
        action: actions[actions.length - 1],
        scope: defaultOptions?.scope ?? inferScope(context),
      } as GuardResult;
    },
  };
}

/**
 * Infer permission scope from context
 */
function inferScope(context: GuardContext): PermissionScope {
  if (context.sessionId) return "session";
  if (context.agentId) return "agent";
  if (context.channelId) return "channel";
  return "global";
}

/**
 * Resolve scope ID from context based on scope type
 */
function resolveScopeId(context: GuardContext, scope: PermissionScope): string | undefined {
  switch (scope) {
    case "session":
      return context.sessionId;
    case "agent":
      return context.agentId;
    case "channel":
      return context.channelId;
    default:
      return undefined;
  }
}

/**
 * Higher-order function to wrap a handler with permission check
 */
export function withPermission<TArgs extends unknown[], TReturn>(
  getContext: (...args: TArgs) => GuardContext,
  action: PermissionAction,
  handler: (...args: TArgs) => TReturn,
): (...args: TArgs) => TReturn {
  return (...args: TArgs) => {
    const context = getContext(...args);
    return guard(context, { action }, () => handler(...args));
  };
}

/**
 * Higher-order function for async handlers
 */
export function withPermissionAsync<TArgs extends unknown[], TReturn>(
  getContext: (...args: TArgs) => GuardContext,
  action: PermissionAction,
  handler: (...args: TArgs) => Promise<TReturn>,
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs) => {
    const context = getContext(...args);
    return await guardAsync(context, { action }, () => handler(...args));
  };
}

/**
 * Create middleware for command processing
 */
export function createCommandGuard(
  commandPrefix: string,
  getUserId: (ctx: unknown) => string | undefined,
  options?: {
    permissionManager?: PermissionManager;
    onDenied?: (command: string, userId: string) => void;
  },
) {
  return (ctx: unknown, next: () => void) => {
    const userId = getUserId(ctx);
    if (!userId) {
      return next();
    }

    const guardContext: GuardContext = { userId };
    const action: PermissionAction = `command:execute`;

    const result = checkGuard(guardContext, {
      action,
      permissionManager: options?.permissionManager,
    });

    if (result.allowed) {
      return next();
    }

    if (options?.onDenied) {
      options.onDenied(commandPrefix, userId);
    }

    throw new PermissionGuardError(
      `Command "${commandPrefix}" is not permitted`,
      userId,
      action,
      "global",
    );
  };
}

/**
 * Batch permission check for multiple users
 */
export function checkBatch(
  userIds: string[],
  action: PermissionAction,
  options?: {
    permissionManager?: PermissionManager;
    scope?: PermissionScope;
  },
): Map<string, GuardResult> {
  const results = new Map<string, GuardResult>();

  for (const userId of userIds) {
    const result = checkGuard({ userId }, {
      action,
      scope: options?.scope ?? "global",
      ...options,
    } as GuardOptions);
    results.set(userId, result);
  }

  return results;
}
