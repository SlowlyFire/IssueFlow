// One place where every action string lives. Anywhere a service or
// controller emits an audit event, they reference these constants — no
// free-text strings in the wild. The string values themselves are what
// land in the `action` column.
export const AuditActions = {
  USER_CREATE: 'USER_CREATE',
  USER_UPDATE: 'USER_UPDATE',
  USER_DELETE: 'USER_DELETE',

  PROJECT_CREATE: 'PROJECT_CREATE',
  PROJECT_UPDATE: 'PROJECT_UPDATE',
  PROJECT_DELETE: 'PROJECT_DELETE',
  PROJECT_RESTORE: 'PROJECT_RESTORE',

  TICKET_CREATE: 'TICKET_CREATE',
  TICKET_UPDATE: 'TICKET_UPDATE',
  TICKET_DELETE: 'TICKET_DELETE',
  TICKET_RESTORE: 'TICKET_RESTORE',

  DEPENDENCY_ADD: 'DEPENDENCY_ADD',
  DEPENDENCY_REMOVE: 'DEPENDENCY_REMOVE',

  AUTO_ASSIGN: 'AUTO_ASSIGN',
} as const;

export type AuditAction = (typeof AuditActions)[keyof typeof AuditActions];

export const AuditEntityTypes = {
  USER: 'User',
  PROJECT: 'Project',
  TICKET: 'Ticket',
} as const;

export type AuditEntityType =
  (typeof AuditEntityTypes)[keyof typeof AuditEntityTypes];
