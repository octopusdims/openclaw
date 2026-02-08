/**
 * Permission level definitions for OpenClaw
 * Provides hierarchical role-based access control
 */

/** Permission levels from highest to lowest authority */
export type PermissionLevel = "superadmin" | "admin" | "moderator" | "user" | "guest";

/** Permission action types */
export type PermissionAction =
  | "command:execute"
  | "command:bash"
  | "command:config"
  | "command:debug"
  | "command:restart"
  | "agent:create"
  | "agent:delete"
  | "agent:modify"
  | "session:read"
  | "session:write"
  | "session:delete"
  | "channel:admin"
  | "channel:send"
  | "channel:receive"
  | "tools:all"
  | "tools:browser"
  | "tools:bash"
  | "tools:file"
  | "gateway:admin"
  | "gateway:status"
  | "broadcast:send"
  | "memory:read"
  | "memory:write"
  | "config:read"
  | "config:write";

/** Permission scope - where the permission applies */
export type PermissionScope =
  | "global" // Applies globally
  | "channel" // Applies to specific channel
  | "agent" // Applies to specific agent
  | "session"; // Applies to specific session

/** Individual permission grant */
export type PermissionGrant = {
  /** The action being permitted */
  action: PermissionAction;
  /** Whether this is an allow or deny grant (deny takes precedence) */
  allow: boolean;
  /** Scope of the permission */
  scope: PermissionScope;
  /** Optional scope identifier (e.g., channel ID, agent ID) */
  scopeId?: string;
  /** Optional expiration timestamp */
  expiresAt?: number;
  /** Reason for this permission grant */
  reason?: string;
};

/** Role definition */
export type Role = {
  /** Unique role identifier */
  id: string;
  /** Human-readable role name */
  name: string;
  /** Role level (for hierarchical checks) */
  level: number;
  /** Base permissions for this role */
  permissions: PermissionGrant[];
  /** Roles that this role inherits from */
  inherits?: string[];
  /** Whether this is a system role (cannot be deleted) */
  system?: boolean;
  /** Role description */
  description?: string;
};

/** User permission assignment */
export type UserPermission = {
  /** User identifier (sender ID, etc.) */
  userId: string;
  /** Assigned roles */
  roles: string[];
  /** Direct permission grants (override role permissions) */
  directGrants?: PermissionGrant[];
  /** When the permissions were assigned */
  assignedAt: number;
  /** Who assigned these permissions */
  assignedBy?: string;
  /** Optional expiration */
  expiresAt?: number;
};

/** Permission check result */
export type PermissionCheckResult = {
  allowed: boolean;
  /** Role that granted the permission */
  grantedBy?: string;
  /** Permission level of the grantor */
  grantorLevel?: number;
  /** Reason for denial (if not allowed) */
  reason?: string;
  /** Whether this was explicitly denied */
  explicitlyDenied: boolean;
};

/** Permission hierarchy (higher number = more authority) */
export const PERMISSION_HIERARCHY: Record<PermissionLevel, number> = {
  superadmin: 1000,
  admin: 100,
  moderator: 50,
  user: 10,
  guest: 0,
};

/** Default system roles */
export const DEFAULT_ROLES: Role[] = [
  {
    id: "superadmin",
    name: "Super Administrator",
    level: PERMISSION_HIERARCHY.superadmin,
    system: true,
    description: "Full system access",
    permissions: [
      { action: "command:execute", allow: true, scope: "global" },
      { action: "command:bash", allow: true, scope: "global" },
      { action: "command:config", allow: true, scope: "global" },
      { action: "command:debug", allow: true, scope: "global" },
      { action: "command:restart", allow: true, scope: "global" },
      { action: "agent:create", allow: true, scope: "global" },
      { action: "agent:delete", allow: true, scope: "global" },
      { action: "agent:modify", allow: true, scope: "global" },
      { action: "session:read", allow: true, scope: "global" },
      { action: "session:write", allow: true, scope: "global" },
      { action: "session:delete", allow: true, scope: "global" },
      { action: "channel:admin", allow: true, scope: "global" },
      { action: "channel:send", allow: true, scope: "global" },
      { action: "channel:receive", allow: true, scope: "global" },
      { action: "tools:all", allow: true, scope: "global" },
      { action: "gateway:admin", allow: true, scope: "global" },
      { action: "gateway:status", allow: true, scope: "global" },
      { action: "broadcast:send", allow: true, scope: "global" },
      { action: "memory:read", allow: true, scope: "global" },
      { action: "memory:write", allow: true, scope: "global" },
      { action: "config:read", allow: true, scope: "global" },
      { action: "config:write", allow: true, scope: "global" },
    ],
  },
  {
    id: "admin",
    name: "Administrator",
    level: PERMISSION_HIERARCHY.admin,
    system: true,
    description: "Administrative access",
    permissions: [
      { action: "command:execute", allow: true, scope: "global" },
      { action: "command:config", allow: true, scope: "global" },
      { action: "command:debug", allow: true, scope: "global" },
      { action: "agent:create", allow: true, scope: "global" },
      { action: "agent:modify", allow: true, scope: "global" },
      { action: "session:read", allow: true, scope: "global" },
      { action: "session:write", allow: true, scope: "global" },
      { action: "channel:admin", allow: true, scope: "global" },
      { action: "channel:send", allow: true, scope: "global" },
      { action: "channel:receive", allow: true, scope: "global" },
      { action: "tools:browser", allow: true, scope: "global" },
      { action: "tools:file", allow: true, scope: "global" },
      { action: "gateway:status", allow: true, scope: "global" },
      { action: "broadcast:send", allow: true, scope: "global" },
      { action: "memory:read", allow: true, scope: "global" },
      { action: "memory:write", allow: true, scope: "global" },
      { action: "config:read", allow: true, scope: "global" },
      { action: "config:write", allow: true, scope: "channel" },
    ],
  },
  {
    id: "moderator",
    name: "Moderator",
    level: PERMISSION_HIERARCHY.moderator,
    system: true,
    description: "Moderation capabilities",
    permissions: [
      { action: "command:execute", allow: true, scope: "channel" },
      { action: "agent:modify", allow: true, scope: "channel" },
      { action: "session:read", allow: true, scope: "channel" },
      { action: "session:write", allow: true, scope: "channel" },
      { action: "channel:send", allow: true, scope: "global" },
      { action: "channel:receive", allow: true, scope: "global" },
      { action: "tools:browser", allow: true, scope: "channel" },
      { action: "tools:file", allow: true, scope: "channel" },
      { action: "gateway:status", allow: true, scope: "global" },
      { action: "broadcast:send", allow: true, scope: "channel" },
      { action: "memory:read", allow: true, scope: "channel" },
      { action: "config:read", allow: true, scope: "global" },
    ],
  },
  {
    id: "user",
    name: "User",
    level: PERMISSION_HIERARCHY.user,
    system: true,
    description: "Standard user",
    permissions: [
      { action: "command:execute", allow: true, scope: "channel" },
      { action: "session:read", allow: true, scope: "session" },
      { action: "session:write", allow: true, scope: "session" },
      { action: "channel:send", allow: true, scope: "channel" },
      { action: "channel:receive", allow: true, scope: "channel" },
      { action: "tools:browser", allow: true, scope: "session" },
      { action: "tools:file", allow: true, scope: "session" },
      { action: "gateway:status", allow: true, scope: "global" },
      { action: "memory:read", allow: true, scope: "session" },
      { action: "config:read", allow: true, scope: "global" },
    ],
  },
  {
    id: "guest",
    name: "Guest",
    level: PERMISSION_HIERARCHY.guest,
    system: true,
    description: "Limited guest access",
    permissions: [
      { action: "channel:receive", allow: true, scope: "channel" },
      { action: "channel:send", allow: true, scope: "channel" },
      { action: "session:read", allow: true, scope: "session" },
      { action: "gateway:status", allow: true, scope: "global" },
      { action: "config:read", allow: true, scope: "global" },
    ],
  },
];

/** Permission configuration for OpenClaw */
export type PermissionConfig = {
  /** Enable permission system */
  enabled: boolean;
  /** Default role for new users */
  defaultRole: string;
  /** Custom roles defined by user */
  customRoles?: Role[];
  /** User permission assignments */
  userAssignments?: UserPermission[];
  /** Whether to require explicit permissions (deny by default) */
  requireExplicit?: boolean;
  /** Auto-assign roles based on channel allowlists */
  autoAssignFromAllowlist?: boolean;
  /** Role mappings from channel allowlists */
  allowlistRoleMapping?: {
    owner?: string; // Role for owners (default: admin)
    allowed?: string; // Role for allowed users (default: user)
  };
};
