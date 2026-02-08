/**
 * Permission System for OpenClaw
 * Role-based access control (RBAC) with hierarchical permissions
 */

export {
  PermissionManager,
  getPermissionManager,
  resetPermissionManager,
  type PermissionManagerOptions,
  type PermissionStorage,
} from "./manager.js";

export {
  checkGuard,
  guard,
  guardAsync,
  createGuard,
  withPermission,
  withPermissionAsync,
  createCommandGuard,
  checkBatch,
  PermissionGuardError,
  type GuardOptions,
  type GuardResult,
  type GuardContext,
} from "./guard.js";

export {
  DEFAULT_ROLES,
  PERMISSION_HIERARCHY,
  type PermissionLevel,
  type PermissionAction,
  type PermissionScope,
  type PermissionGrant,
  type Role,
  type UserPermission,
  type PermissionCheckResult,
  type PermissionConfig,
} from "./types.js";
