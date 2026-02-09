import { describe, it, expect, beforeEach } from "vitest";
import {
  PermissionManager,
  type PermissionConfig,
  type Role,
  DEFAULT_ROLES,
  PERMISSION_HIERARCHY,
  checkGuard,
  guard,
  guardAsync,
  createGuard,
  PermissionGuardError,
} from "./index.js";

describe("PermissionManager", () => {
  let pm: PermissionManager;

  beforeEach(() => {
    const config: PermissionConfig = {
      enabled: true,
      defaultRole: "user",
    };
    pm = new PermissionManager({ config });
  });

  describe("Basic Permission Checks", () => {
    it("should allow superadmin all permissions", () => {
      pm.assignRole("user1", "superadmin");

      const result = pm.checkPermission("user1", "command:bash", "global");
      expect(result.allowed).toBe(true);
    });

    it("should deny guest elevated permissions", () => {
      pm.assignRole("user1", "guest");

      const result = pm.checkPermission("user1", "command:bash", "global");
      expect(result.allowed).toBe(false);
    });

    it("should use default role when user has no assignments", () => {
      const result = pm.checkPermission("unknown", "channel:receive", "channel", "ch1");
      expect(result.allowed).toBe(true); // User role allows channel:receive in channel scope
    });

    it("should allow all actions when disabled", () => {
      const disabledPm = new PermissionManager({
        config: { enabled: false, defaultRole: "user" },
      });

      const result = disabledPm.checkPermission("user1", "any:action", "global");
      expect(result.allowed).toBe(true);
    });
  });

  describe("Role Assignment", () => {
    it("should assign roles to users", () => {
      pm.assignRole("user1", "admin");
      const roles = pm.getUserRoles("user1");

      expect(roles.length).toBe(1);
      expect(roles[0].id).toBe("admin");
    });

    it("should remove roles from users", () => {
      pm.assignRole("user1", "admin");
      pm.removeRole("user1", "admin");
      const roles = pm.getUserRoles("user1");

      expect(roles.length).toBe(0);
    });

    it("should support multiple roles", () => {
      pm.assignRole("user1", "moderator");
      pm.assignRole("user1", "user");
      const roles = pm.getUserRoles("user1");

      expect(roles.length).toBe(2);
    });
  });

  describe("Permission Hierarchy", () => {
    it("should respect permission levels", () => {
      expect(PERMISSION_HIERARCHY.superadmin).toBeGreaterThan(PERMISSION_HIERARCHY.admin);
      expect(PERMISSION_HIERARCHY.admin).toBeGreaterThan(PERMISSION_HIERARCHY.moderator);
      expect(PERMISSION_HIERARCHY.moderator).toBeGreaterThan(PERMISSION_HIERARCHY.user);
      expect(PERMISSION_HIERARCHY.user).toBeGreaterThan(PERMISSION_HIERARCHY.guest);
    });

    it("should get correct user level", () => {
      pm.assignRole("admin1", "admin");
      pm.assignRole("mod1", "moderator");

      expect(pm.getUserLevel("admin1")).toBe(PERMISSION_HIERARCHY.admin);
      expect(pm.getUserLevel("mod1")).toBe(PERMISSION_HIERARCHY.moderator);
    });

    it("should check level requirements", () => {
      pm.assignRole("admin1", "admin");

      expect(pm.hasLevel("admin1", "moderator")).toBe(true);
      expect(pm.hasLevel("admin1", "superadmin")).toBe(false);
    });
  });

  describe("Direct Permission Grants", () => {
    it("should grant direct permissions", () => {
      pm.grantPermission("user1", {
        action: "command:debug",
        allow: true,
        scope: "global",
      });

      const result = pm.checkPermission("user1", "command:debug", "global");
      expect(result.allowed).toBe(true);
    });

    it("should revoke direct permissions", () => {
      pm.grantPermission("user1", {
        action: "command:debug",
        allow: true,
        scope: "global",
      });
      pm.revokePermission("user1", "command:debug", "global");

      const result = pm.checkPermission("user1", "command:debug", "global");
      expect(result.allowed).toBe(false);
    });

    it("should deny permissions take precedence", () => {
      pm.assignRole("user1", "admin");
      pm.grantPermission("user1", {
        action: "command:bash",
        allow: false,
        scope: "global",
      });

      const result = pm.checkPermission("user1", "command:bash", "global");
      expect(result.allowed).toBe(false);
      expect(result.explicitlyDenied).toBe(true);
    });
  });

  describe("Custom Roles", () => {
    it("should create custom roles", () => {
      const customRole: Role = {
        id: "custom",
        name: "Custom Role",
        level: 25,
        permissions: [{ action: "session:read", allow: true, scope: "global" }],
      };

      const created = pm.createRole(customRole);
      expect(created).toBe(true);

      pm.assignRole("user1", "custom");
      const result = pm.checkPermission("user1", "session:read", "global");
      expect(result.allowed).toBe(true);
    });

    it("should not create duplicate roles", () => {
      const customRole: Role = {
        id: "custom",
        name: "Custom Role",
        level: 25,
        permissions: [],
      };

      pm.createRole(customRole);
      const created = pm.createRole(customRole);
      expect(created).toBe(false);
    });

    it("should not delete system roles", () => {
      const deleted = pm.deleteRole("admin");
      expect(deleted).toBe(false);
    });
  });

  describe("Scope-specific Permissions", () => {
    it("should respect channel scope", () => {
      pm.grantPermission("user1", {
        action: "channel:send",
        allow: true,
        scope: "channel",
        scopeId: "ch1",
      });

      const result1 = pm.checkPermission("user1", "channel:send", "channel", "ch1");
      const result2 = pm.checkPermission("user1", "channel:send", "channel", "ch2");

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(false);
    });

    it("should allow global scope grants everywhere", () => {
      pm.grantPermission("user1", {
        action: "session:read",
        allow: true,
        scope: "global",
      });

      const result = pm.checkPermission("user1", "session:read", "session", "s1");
      expect(result.allowed).toBe(true);
    });
  });

  describe("Expiration", () => {
    it("should respect permission expiration", () => {
      pm.grantPermission("user1", {
        action: "command:debug",
        allow: true,
        scope: "global",
        expiresAt: Date.now() - 1000, // Expired
      });

      const result = pm.checkPermission("user1", "command:debug", "global");
      expect(result.allowed).toBe(false);
    });
  });
});

describe("Permission Guards", () => {
  let pm: PermissionManager;

  beforeEach(() => {
    pm = new PermissionManager({
      config: { enabled: true, defaultRole: "user" },
    });
    pm.assignRole("admin1", "admin");
  });

  describe("checkGuard", () => {
    it("should return guard result", () => {
      const result = checkGuard(
        { userId: "admin1" },
        { action: "command:execute", permissionManager: pm },
      );

      expect(result.allowed).toBe(true);
      expect(result.userId).toBe("admin1");
    });

    it("should deny unauthorized users", () => {
      const result = checkGuard(
        { userId: "guest1" },
        { action: "command:bash", permissionManager: pm },
      );

      expect(result.allowed).toBe(false);
    });
  });

  describe("guard", () => {
    it("should execute function when permitted", () => {
      const result = guard(
        { userId: "admin1" },
        { action: "command:execute", permissionManager: pm },
        () => "success",
      );

      expect(result).toBe("success");
    });

    it("should throw when not permitted", () => {
      expect(() =>
        guard(
          { userId: "guest1" },
          { action: "command:bash", permissionManager: pm },
          () => "success",
        ),
      ).toThrow(PermissionGuardError);
    });

    it("should return undefined when throwOnDenial is false", () => {
      const result = guard(
        { userId: "guest1" },
        { action: "command:bash", permissionManager: pm, throwOnDenial: false },
        () => "success",
      );

      expect(result).toBeUndefined();
    });
  });

  describe("guardAsync", () => {
    it("should execute async function when permitted", async () => {
      const result = await guardAsync(
        { userId: "admin1" },
        { action: "command:execute", permissionManager: pm },
        async () => "success",
      );

      expect(result).toBe("success");
    });

    it("should reject when not permitted", async () => {
      await expect(
        guardAsync(
          { userId: "guest1" },
          { action: "command:bash", permissionManager: pm },
          async () => "success",
        ),
      ).rejects.toThrow(PermissionGuardError);
    });
  });

  describe("createGuard", () => {
    it("should create reusable guard", () => {
      const guard = createGuard({ userId: "admin1" }, { permissionManager: pm });

      expect(guard.check("command:execute").allowed).toBe(true);
      expect(guard.check("command:bash").allowed).toBe(false);
    });

    it("should check any permission", () => {
      const guard = createGuard({ userId: "user1", channelId: "ch1" }, { permissionManager: pm });

      const result = guard.checkAny(["command:bash", "command:execute"]);
      expect(result.allowed).toBe(true); // command:execute is allowed for user in channel scope
    });

    it("should check all permissions", () => {
      pm.assignRole("testuser", "admin");
      const guard = createGuard({ userId: "testuser" }, { permissionManager: pm });

      const result = guard.checkAll(["command:execute", "session:read"]);
      expect(result.allowed).toBe(true);
    });
  });
});

describe("Default Roles", () => {
  it("should have all system roles", () => {
    const roleIds = DEFAULT_ROLES.map((r) => r.id);
    expect(roleIds).toContain("superadmin");
    expect(roleIds).toContain("admin");
    expect(roleIds).toContain("moderator");
    expect(roleIds).toContain("user");
    expect(roleIds).toContain("guest");
  });

  it("should have valid permission hierarchy", () => {
    expect(PERMISSION_HIERARCHY.superadmin).toBe(1000);
    expect(PERMISSION_HIERARCHY.admin).toBe(100);
    expect(PERMISSION_HIERARCHY.moderator).toBe(50);
    expect(PERMISSION_HIERARCHY.user).toBe(10);
    expect(PERMISSION_HIERARCHY.guest).toBe(0);
  });
});
