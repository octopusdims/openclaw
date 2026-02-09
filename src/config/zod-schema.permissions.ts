import { z } from "zod";

export const PermissionGrantSchema = z
  .object({
    action: z.string(),
    allow: z.boolean(),
    scope: z.enum(["global", "channel", "agent", "session"]),
    scopeId: z.string().optional(),
    expiresAt: z.number().optional(),
    reason: z.string().optional(),
  })
  .strict();

export const RoleSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    level: z.number(),
    permissions: z.array(PermissionGrantSchema),
    inherits: z.array(z.string()).optional(),
    system: z.boolean().optional(),
    description: z.string().optional(),
  })
  .strict();

export const UserPermissionSchema = z
  .object({
    userId: z.string(),
    roles: z.array(z.string()),
    directGrants: z.array(PermissionGrantSchema).optional(),
    assignedAt: z.number(),
    assignedBy: z.string().optional(),
    expiresAt: z.number().optional(),
  })
  .strict();

export const PermissionSettingsSchema = z
  .object({
    enabled: z.boolean(),
    defaultRole: z.string(),
    customRoles: z.array(RoleSchema).optional(),
    userAssignments: z.array(UserPermissionSchema).optional(),
    requireExplicit: z.boolean().optional(),
    autoAssignFromAllowlist: z.boolean().optional(),
    allowlistRoleMapping: z
      .object({
        owner: z.string().optional(),
        allowed: z.string().optional(),
      })
      .optional(),
  })
  .strict();

export const PermissionBindingSchema = z
  .object({
    id: z.string(),
    type: z.enum(["channel", "agent", "session"]),
    minRole: z.string().optional(),
    requiredPermissions: z.array(z.string()).optional(),
    roleOverrides: z.record(z.string(), z.string()).optional(),
  })
  .strict();
