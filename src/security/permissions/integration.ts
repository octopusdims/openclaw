/**
 * Permission System Integration for OpenClaw
 * Integrates RBAC with existing OpenClaw command and message handling
 */

import type { CommandAuthorization } from "../../auto-reply/command-auth.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.js";
import { createGuard, PermissionGuardError } from "./guard.js";
import {
  PermissionManager,
  type PermissionConfig,
  type PermissionAction,
  type GuardContext,
} from "./index.js";

export type PermissionIntegrationOptions = {
  config: OpenClawConfig;
  permissionManager: PermissionManager;
};

/** Map OpenClaw commands to permission actions */
const COMMAND_ACTION_MAP: Record<string, PermissionAction> = {
  bash: "command:bash",
  config: "command:config",
  debug: "command:debug",
  restart: "command:restart",
  compact: "session:write",
  reset: "session:delete",
  status: "gateway:status",
  model: "config:read",
  tools: "tools:all",
  agent: "agent:modify",
  agents: "agent:read",
  session: "session:read",
  broadcast: "broadcast:send",
};

/**
 * Extract permission config from OpenClaw config
 */
export function extractPermissionConfig(config: OpenClawConfig): PermissionConfig {
  const commands = config.commands;

  return {
    enabled: commands?.useAccessGroups ?? true,
    defaultRole: "user",
    requireExplicit: false,
    autoAssignFromAllowlist: true,
    allowlistRoleMapping: {
      owner: "admin",
      allowed: "user",
    },
  };
}

/**
 * Build guard context from OpenClaw message context
 */
export function buildGuardContext(
  msgCtx: MsgContext,
  commandAuth?: CommandAuthorization,
): GuardContext {
  return {
    userId: commandAuth?.senderId ?? msgCtx.SenderId ?? msgCtx.From ?? "unknown",
    channelId: msgCtx.Provider ?? msgCtx.Surface,
    agentId: msgCtx.AgentId,
  };
}

/**
 * Check if a user can execute a command
 */
export function canExecuteCommand(
  options: PermissionIntegrationOptions,
  msgCtx: MsgContext,
  commandName: string,
  commandAuth?: CommandAuthorization,
): { allowed: boolean; reason?: string } {
  const pm = options.permissionManager;
  const guardCtx = buildGuardContext(msgCtx, commandAuth);

  // Map command to permission action
  const action = COMMAND_ACTION_MAP[commandName] ?? "command:execute";

  const result = pm.checkPermission(
    guardCtx.userId,
    action,
    guardCtx.channelId ? "channel" : "global",
    guardCtx.channelId,
  );

  return {
    allowed: result.allowed,
    reason: result.reason,
  };
}

/**
 * Wrap a command handler with permission check
 */
export function withPermissionCheck<T extends (...args: unknown[]) => unknown>(
  options: PermissionIntegrationOptions,
  commandName: string,
  handler: T,
  getContext: (...args: Parameters<T>) => {
    msgCtx: MsgContext;
    commandAuth?: CommandAuthorization;
  },
): (...args: Parameters<T>) => ReturnType<T> {
  return (...args: Parameters<T>) => {
    const { msgCtx, commandAuth } = getContext(...args);
    const { allowed, reason } = canExecuteCommand(options, msgCtx, commandName, commandAuth);

    if (!allowed) {
      throw new PermissionGuardError(
        `Command "${commandName}" is not allowed: ${reason ?? "Permission denied"}`,
        commandAuth?.senderId ?? msgCtx.SenderId ?? "unknown",
        COMMAND_ACTION_MAP[commandName] ?? "command:execute",
        "global",
      );
    }

    return handler(...args);
  };
}

/**
 * Create permission-aware command registry
 */
export function createPermissionAwareRegistry(options: PermissionIntegrationOptions) {
  const commandRegistry = new Map<string, (...args: unknown[]) => unknown>();

  return {
    register<T extends (...args: unknown[]) => unknown>(
      commandName: string,
      requiredAction: PermissionAction,
      handler: T,
    ): void {
      const wrapped = (...args: unknown[]) => {
        const pm = options.permissionManager;
        const msgCtx = args[0] as MsgContext;
        const guardCtx = buildGuardContext(msgCtx);

        const guard = createGuard(guardCtx, { permissionManager: pm });
        const result = guard.check(requiredAction);

        if (!result.allowed) {
          throw new PermissionGuardError(
            `Command "${commandName}" requires ${requiredAction} permission`,
            guardCtx.userId,
            requiredAction,
            result.scope,
          );
        }

        return handler(...args);
      };

      commandRegistry.set(commandName, wrapped);
    },

    execute(commandName: string, ...args: unknown[]): unknown {
      const handler = commandRegistry.get(commandName);
      if (!handler) {
        throw new Error(`Unknown command: ${commandName}`);
      }
      return handler(...args);
    },

    has(commandName: string): boolean {
      return commandRegistry.has(commandName);
    },

    list(): string[] {
      return Array.from(commandRegistry.keys());
    },
  };
}

/**
 * Auto-assign permissions based on existing allowlist configuration
 */
export function syncPermissionsWithAllowlist(
  options: PermissionIntegrationOptions,
  commandAuth: CommandAuthorization,
): void {
  const pm = options.permissionManager;

  if (!commandAuth.senderId) return;

  // Auto-assign based on allowlist status
  pm.autoAssignFromAllowlist(
    commandAuth.senderId,
    commandAuth.senderIsOwner,
    commandAuth.isAuthorizedSender,
  );
}

/**
 * Get user's permission summary for display
 */
export function getUserPermissionSummary(
  options: PermissionIntegrationOptions,
  userId: string,
): {
  userId: string;
  roles: string[];
  level: number;
  permissions: string[];
} {
  const pm = options.permissionManager;
  const roles = pm.getUserRoles(userId);
  const level = pm.getUserLevel(userId);

  // Get all allowed actions
  const allActions: PermissionAction[] = [
    "command:execute",
    "command:bash",
    "command:config",
    "command:debug",
    "agent:create",
    "agent:delete",
    "session:read",
    "session:write",
    "tools:all",
    "gateway:admin",
    "broadcast:send",
  ];

  const allowedActions = allActions.filter((action) => pm.checkPermission(userId, action).allowed);

  return {
    userId,
    roles: roles.map((r) => r.name),
    level,
    permissions: allowedActions,
  };
}

/**
 * Middleware for auto-reply pipeline
 */
export function createPermissionMiddleware(options: PermissionIntegrationOptions) {
  return {
    /**
     * Check permissions before processing message
     */
    beforeProcess(
      msgCtx: MsgContext,
      commandAuth: CommandAuthorization,
    ): { allowed: boolean; reason?: string } {
      syncPermissionsWithAllowlist(options, commandAuth);

      const pm = options.permissionManager;
      const guardCtx = buildGuardContext(msgCtx, commandAuth);

      // Check basic message receive permission
      const result = pm.checkPermission(
        guardCtx.userId,
        "channel:receive",
        guardCtx.channelId ? "channel" : "global",
        guardCtx.channelId,
      );

      return {
        allowed: result.allowed,
        reason: result.reason,
      };
    },

    /**
     * Check permissions before executing reply
     */
    beforeReply(
      msgCtx: MsgContext,
      commandAuth: CommandAuthorization,
    ): { allowed: boolean; reason?: string } {
      const pm = options.permissionManager;
      const guardCtx = buildGuardContext(msgCtx, commandAuth);

      const result = pm.checkPermission(
        guardCtx.userId,
        "channel:send",
        guardCtx.channelId ? "channel" : "global",
        guardCtx.channelId,
      );

      return {
        allowed: result.allowed,
        reason: result.reason,
      };
    },

    /**
     * Check tool execution permission
     */
    beforeTool(
      msgCtx: MsgContext,
      toolName: string,
      commandAuth: CommandAuthorization,
    ): { allowed: boolean; reason?: string } {
      const pm = options.permissionManager;
      const guardCtx = buildGuardContext(msgCtx, commandAuth);

      // Map tool name to permission action
      let action: PermissionAction = "tools:all";
      if (toolName.includes("bash")) action = "tools:bash";
      else if (toolName.includes("browser")) action = "tools:browser";
      else if (toolName.includes("file")) action = "tools:file";

      const result = pm.checkPermission(
        guardCtx.userId,
        action,
        guardCtx.agentId ? "agent" : "global",
        guardCtx.agentId,
      );

      return {
        allowed: result.allowed,
        reason: result.reason,
      };
    },
  };
}
