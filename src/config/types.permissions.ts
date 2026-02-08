/**
 * Permission configuration types for OpenClaw
 */

import type {
  PermissionConfig as CorePermissionConfig,
  Role,
  UserPermission,
} from "../security/permissions/types.js";

/**
 * Permission configuration (extends core permission config)
 */
export type PermissionSettings = CorePermissionConfig & {
  /** Storage backend for permissions (default: memory) */
  storage?: "memory" | "file" | "custom";
  /** File path if using file storage */
  storagePath?: string;
  /** Cache TTL for permission lookups (ms) */
  cacheTtlMs?: number;
  /** Enable permission audit logging */
  auditLog?: boolean;
  /** Audit log path */
  auditLogPath?: string;
};

/**
 * Permission bindings for channels/agents
 */
export type PermissionBinding = {
  /** Channel or agent ID */
  id: string;
  /** Type of binding */
  type: "channel" | "agent" | "session";
  /** Required minimum role for access */
  minRole?: string;
  /** Required permissions for specific actions */
  requiredPermissions?: string[];
  /** Role overrides for this binding */
  roleOverrides?: Record<string, string>;
};

/**
 * Extend the main OpenClaw config types
 * Add this to types.openclaw.ts:
 *
 * permissions?: PermissionSettings;
 * permissionBindings?: PermissionBinding[];
 */
