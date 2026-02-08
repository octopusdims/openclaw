/**
 * Permission Manager for OpenClaw
 * Handles role-based access control (RBAC) with hierarchical permissions
 */

import type {
  PermissionAction,
  PermissionCheckResult,
  PermissionConfig,
  PermissionGrant,
  PermissionScope,
  Role,
  UserPermission,
} from "./types.js";
import { DEFAULT_ROLES, PERMISSION_HIERARCHY } from "./types.js";

export type PermissionManagerOptions = {
  config?: PermissionConfig;
  /** Optional storage for persisting permissions */
  storage?: PermissionStorage;
};

export type PermissionStorage = {
  load(): Promise<PermissionConfig>;
  save(config: PermissionConfig): Promise<void>;
};

export class PermissionManager {
  private config: PermissionConfig;
  private roles: Map<string, Role> = new Map();
  private userPermissions: Map<string, UserPermission> = new Map();
  private storage?: PermissionStorage;

  constructor(options: PermissionManagerOptions = {}) {
    this.config = options.config ?? {
      enabled: true,
      defaultRole: "user",
      requireExplicit: false,
      autoAssignFromAllowlist: true,
      allowlistRoleMapping: {
        owner: "admin",
        allowed: "user",
      },
    };
    this.storage = options.storage;
    this.initializeRoles();
    this.initializeUserAssignments();
  }

  private initializeRoles(): void {
    // Load default system roles
    for (const role of DEFAULT_ROLES) {
      this.roles.set(role.id, role);
    }

    // Load custom roles from config
    if (this.config.customRoles) {
      for (const role of this.config.customRoles) {
        // Custom roles cannot override system roles
        if (!role.system) {
          this.roles.set(role.id, role);
        }
      }
    }
  }

  private initializeUserAssignments(): void {
    if (this.config.userAssignments) {
      for (const assignment of this.config.userAssignments) {
        this.userPermissions.set(assignment.userId, assignment);
      }
    }
  }

  /**
   * Check if a user has permission to perform an action
   */
  checkPermission(
    userId: string,
    action: PermissionAction,
    scope: PermissionScope = "global",
    scopeId?: string,
  ): PermissionCheckResult {
    if (!this.config.enabled) {
      return { allowed: true, explicitlyDenied: false };
    }

    const userPerms = this.userPermissions.get(userId);
    const defaultRole = this.roles.get(this.config.defaultRole);

    // If user has no permissions and explicit is required, deny
    if (!userPerms && this.config.requireExplicit) {
      return {
        allowed: false,
        explicitlyDenied: false,
        reason: "No permissions assigned and explicit mode is enabled",
      };
    }

    // Collect all applicable grants from roles and direct grants
    const allGrants: Array<{
      grant: PermissionGrant;
      roleId: string;
      roleLevel: number;
    }> = [];

    // Add grants from user's roles
    if (userPerms) {
      for (const roleId of userPerms.roles) {
        const role = this.roles.get(roleId);
        if (role) {
          // Add inherited role permissions
          const inheritedGrants = this.getInheritedGrants(role);
          for (const grant of inheritedGrants) {
            allGrants.push({ grant, roleId, roleLevel: role.level });
          }
          // Add role's own permissions
          for (const grant of role.permissions) {
            allGrants.push({ grant, roleId, roleLevel: role.level });
          }
        }
      }

      // Add direct grants
      if (userPerms.directGrants) {
        for (const grant of userPerms.directGrants) {
          allGrants.push({
            grant,
            roleId: "direct",
            roleLevel: Number.MAX_SAFE_INTEGER, // Direct grants have highest priority
          });
        }
      }
    }

    // If no grants found, fall back to default role
    if (allGrants.length === 0 && defaultRole) {
      for (const grant of defaultRole.permissions) {
        allGrants.push({
          grant,
          roleId: defaultRole.id,
          roleLevel: defaultRole.level,
        });
      }
    }

    // Sort grants by priority (deny > allow, higher role level > lower, explicit > inherited)
    allGrants.sort((a, b) => {
      // Deny takes precedence over allow
      if (a.grant.allow !== b.grant.allow) {
        return a.grant.allow ? 1 : -1;
      }
      // Higher role level takes precedence
      if (a.roleLevel !== b.roleLevel) {
        return b.roleLevel - a.roleLevel;
      }
      // More specific scope takes precedence
      const scopePriority = { session: 3, agent: 2, channel: 1, global: 0 };
      return scopePriority[b.grant.scope] - scopePriority[a.grant.scope];
    });

    // Check for explicit denials first
    for (const { grant, roleId, roleLevel } of allGrants) {
      if (this.grantMatches(grant, action, scope, scopeId)) {
        if (!grant.allow) {
          return {
            allowed: false,
            explicitlyDenied: true,
            grantedBy: roleId,
            grantorLevel: roleLevel,
            reason: `Explicitly denied by ${roleId}`,
          };
        }
      }
    }

    // Check for allows
    for (const { grant, roleId, roleLevel } of allGrants) {
      if (this.grantMatches(grant, action, scope, scopeId)) {
        if (grant.allow) {
          return {
            allowed: true,
            explicitlyDenied: false,
            grantedBy: roleId,
            grantorLevel: roleLevel,
          };
        }
      }
    }

    // No matching grant found
    return {
      allowed: !this.config.requireExplicit,
      explicitlyDenied: false,
      reason: this.config.requireExplicit ? "No explicit permission granted" : undefined,
    };
  }

  /**
   * Check if a grant matches the requested action and scope
   */
  private grantMatches(
    grant: PermissionGrant,
    action: PermissionAction,
    scope: PermissionScope,
    scopeId?: string,
  ): boolean {
    // Check action match (support wildcards)
    if (grant.action !== "*" && !this.actionMatches(grant.action, action)) {
      return false;
    }

    // Check scope match
    if (grant.scope !== scope) {
      // Global scope grants apply everywhere
      if (grant.scope !== "global") {
        return false;
      }
    }

    // Check scope ID if specified
    if (grant.scopeId !== undefined && grant.scopeId !== scopeId) {
      return false;
    }

    // Check expiration
    if (grant.expiresAt !== undefined && grant.expiresAt < Date.now()) {
      return false;
    }

    return true;
  }

  /**
   * Check if a grant action matches the requested action (supports wildcards)
   */
  private actionMatches(grantAction: string, requestedAction: string): boolean {
    if (grantAction === requestedAction) {
      return true;
    }

    // Support wildcard patterns like "tools:*" or "command:*"
    if (grantAction.endsWith(":*")) {
      const prefix = grantAction.slice(0, -1);
      return requestedAction.startsWith(prefix);
    }

    return false;
  }

  /**
   * Get all grants from inherited roles
   */
  private getInheritedGrants(role: Role): PermissionGrant[] {
    const grants: PermissionGrant[] = [];
    const visited = new Set<string>();

    const collect = (roleId: string) => {
      if (visited.has(roleId)) return;
      visited.add(roleId);

      const parentRole = this.roles.get(roleId);
      if (!parentRole) return;

      // Add parent's inherited grants first (recursively)
      if (parentRole.inherits) {
        for (const inheritedId of parentRole.inherits) {
          collect(inheritedId);
        }
      }

      // Add parent's own grants
      grants.push(...parentRole.permissions);
    };

    if (role.inherits) {
      for (const inheritedId of role.inherits) {
        collect(inheritedId);
      }
    }

    return grants;
  }

  /**
   * Assign a role to a user
   */
  assignRole(userId: string, roleId: string, assignedBy?: string): boolean {
    const role = this.roles.get(roleId);
    if (!role) {
      return false;
    }

    let userPerms = this.userPermissions.get(userId);
    if (!userPerms) {
      userPerms = {
        userId,
        roles: [],
        assignedAt: Date.now(),
        assignedBy,
      };
      this.userPermissions.set(userId, userPerms);
    }

    if (!userPerms.roles.includes(roleId)) {
      userPerms.roles.push(roleId);
    }

    return true;
  }

  /**
   * Remove a role from a user
   */
  removeRole(userId: string, roleId: string): boolean {
    const userPerms = this.userPermissions.get(userId);
    if (!userPerms) {
      return false;
    }

    const index = userPerms.roles.indexOf(roleId);
    if (index === -1) {
      return false;
    }

    userPerms.roles.splice(index, 1);

    // Clean up if no roles left
    if (
      userPerms.roles.length === 0 &&
      (!userPerms.directGrants || userPerms.directGrants.length === 0)
    ) {
      this.userPermissions.delete(userId);
    }

    return true;
  }

  /**
   * Grant a direct permission to a user
   */
  grantPermission(userId: string, grant: PermissionGrant, assignedBy?: string): void {
    let userPerms = this.userPermissions.get(userId);
    if (!userPerms) {
      userPerms = {
        userId,
        roles: [this.config.defaultRole],
        directGrants: [],
        assignedAt: Date.now(),
        assignedBy,
      };
      this.userPermissions.set(userId, userPerms);
    }

    if (!userPerms.directGrants) {
      userPerms.directGrants = [];
    }

    // Remove any existing grant for the same action/scope combination
    userPerms.directGrants = userPerms.directGrants.filter(
      (g) => !(g.action === grant.action && g.scope === grant.scope && g.scopeId === grant.scopeId),
    );

    userPerms.directGrants.push(grant);
  }

  /**
   * Revoke a direct permission from a user
   */
  revokePermission(
    userId: string,
    action: PermissionAction,
    scope: PermissionScope,
    scopeId?: string,
  ): boolean {
    const userPerms = this.userPermissions.get(userId);
    if (!userPerms || !userPerms.directGrants) {
      return false;
    }

    const initialLength = userPerms.directGrants.length;
    userPerms.directGrants = userPerms.directGrants.filter(
      (g) => !(g.action === action && g.scope === scope && g.scopeId === scopeId),
    );

    return userPerms.directGrants.length < initialLength;
  }

  /**
   * Create a custom role
   */
  createRole(role: Role): boolean {
    if (role.system) {
      return false; // Cannot create system roles
    }
    if (this.roles.has(role.id)) {
      return false; // Role already exists
    }

    this.roles.set(role.id, role);
    return true;
  }

  /**
   * Delete a custom role
   */
  deleteRole(roleId: string): boolean {
    const role = this.roles.get(roleId);
    if (!role || role.system) {
      return false;
    }

    this.roles.delete(roleId);

    // Remove role from all users
    for (const userPerms of this.userPermissions.values()) {
      const index = userPerms.roles.indexOf(roleId);
      if (index !== -1) {
        userPerms.roles.splice(index, 1);
      }
    }

    return true;
  }

  /**
   * Get user's roles
   */
  getUserRoles(userId: string): Role[] {
    const userPerms = this.userPermissions.get(userId);
    if (!userPerms) {
      const defaultRole = this.roles.get(this.config.defaultRole);
      return defaultRole ? [defaultRole] : [];
    }

    return userPerms.roles
      .map((id) => this.roles.get(id))
      .filter((r): r is Role => r !== undefined);
  }

  /**
   * Get user's highest permission level
   */
  getUserLevel(userId: string): number {
    const roles = this.getUserRoles(userId);
    return Math.max(...roles.map((r) => r.level), 0);
  }

  /**
   * Check if user has a specific role
   */
  hasRole(userId: string, roleId: string): boolean {
    const userPerms = this.userPermissions.get(userId);
    if (!userPerms) {
      return roleId === this.config.defaultRole;
    }
    return userPerms.roles.includes(roleId);
  }

  /**
   * Check if user has higher or equal level than required
   */
  hasLevel(userId: string, requiredLevel: number | string): boolean {
    const userLevel = this.getUserLevel(userId);
    const required =
      typeof requiredLevel === "string"
        ? (PERMISSION_HIERARCHY[requiredLevel as keyof typeof PERMISSION_HIERARCHY] ?? 0)
        : requiredLevel;
    return userLevel >= required;
  }

  /**
   * Get all available roles
   */
  getAllRoles(): Role[] {
    return Array.from(this.roles.values());
  }

  /**
   * Auto-assign role based on channel allowlist status
   */
  autoAssignFromAllowlist(userId: string, isOwner: boolean, isAllowed: boolean): void {
    if (!this.config.autoAssignFromAllowlist) {
      return;
    }

    const mapping = this.config.allowlistRoleMapping;
    if (isOwner && mapping?.owner) {
      this.assignRole(userId, mapping.owner);
    } else if (isAllowed && mapping?.allowed) {
      this.assignRole(userId, mapping.allowed);
    }
  }

  /**
   * Save current configuration to storage
   */
  async save(): Promise<void> {
    if (!this.storage) {
      return;
    }

    const config: PermissionConfig = {
      ...this.config,
      customRoles: Array.from(this.roles.values()).filter((r) => !r.system),
      userAssignments: Array.from(this.userPermissions.values()),
    };

    await this.storage.save(config);
  }

  /**
   * Load configuration from storage
   */
  async load(): Promise<void> {
    if (!this.storage) {
      return;
    }

    const config = await this.storage.load();
    this.config = config;
    this.roles.clear();
    this.userPermissions.clear();
    this.initializeRoles();
    this.initializeUserAssignments();
  }
}

/** Singleton instance */
let defaultManager: PermissionManager | undefined;

export function getPermissionManager(options?: PermissionManagerOptions): PermissionManager {
  if (!defaultManager) {
    defaultManager = new PermissionManager(options);
  }
  return defaultManager;
}

export function resetPermissionManager(): void {
  defaultManager = undefined;
}
