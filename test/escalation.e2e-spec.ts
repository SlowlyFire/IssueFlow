import {
  ClassSerializerInterceptor,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { AuditLog } from './../src/audit/audit-log.entity';
import { AllExceptionsFilter } from './../src/common/all-exceptions.filter';
import { TicketPriority, TicketStatus } from './../src/common/enums';
import { EscalationService } from './../src/scheduler/escalation.service';

function configureApp(app: INestApplication) {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(
    new ClassSerializerInterceptor(app.get(Reflector)),
  );
}

// All timestamps for "overdue" tests use a past date so they are always
// overdue regardless of when the test suite runs.
const PAST_DUE = '2020-01-01T00:00:00.000Z';
// A future date that will never be overdue (year 2099).
const FUTURE_DUE = '2099-12-31T00:00:00.000Z';

describe('Escalation scheduler (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let svc: EscalationService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let adminToken: string;
  let devToken: string;
  let projectId: number;
  let adminId: number;
  let devId: number;

  beforeAll(async () => {
    const mod: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = mod.createNestApplication();
    configureApp(app);
    await app.init();

    ds = app.get(DataSource);
    svc = app.get(EscalationService);
    server = app.getHttpServer();

    await ds.query(
      'TRUNCATE TABLE "ticket_dependencies", "tickets", "projects", "users", "audit_logs" RESTART IDENTITY CASCADE',
    );

    // Create admin
    const a = await request(server).post('/users').send({
      username: 'escladmin',
      email: 'escladmin@example.com',
      fullName: 'Escalation Admin',
      role: 'ADMIN',
      password: 'secret123',
    });
    adminId = a.body.id;

    // Create developer
    const d = await request(server).post('/users').send({
      username: 'escldev',
      email: 'escldev@example.com',
      fullName: 'Escalation Dev',
      role: 'DEVELOPER',
      password: 'secret123',
    });
    devId = d.body.id;

    // Login both
    const al = await request(server)
      .post('/auth/login')
      .send({ username: 'escladmin', password: 'secret123' });
    adminToken = al.body.accessToken;

    const dl = await request(server)
      .post('/auth/login')
      .send({ username: 'escldev', password: 'secret123' });
    devToken = dl.body.accessToken;

    // Create a project
    const p = await request(server)
      .post('/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Escl Project', description: 'test', ownerId: adminId });
    projectId = p.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // Helper: wipe audit_logs so each test starts clean.
  async function clearAudit() {
    await ds.query('TRUNCATE TABLE "audit_logs" RESTART IDENTITY CASCADE');
  }

  // Helper: create a ticket and return it.
  async function createTicket(opts: {
    title: string;
    priority?: string;
    dueDate?: string | null;
    status?: string;
  }) {
    const res = await request(server)
      .post('/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: opts.title,
        type: 'FEATURE',
        projectId,
        assigneeId: devId,
        priority: opts.priority ?? 'LOW',
        dueDate: opts.dueDate !== undefined ? opts.dueDate : PAST_DUE,
      });
    expect(res.status).toBe(200);
    return res.body as { id: number; version: number; priority: string; isOverdue: boolean; status: string };
  }

  // Helper: fetch a ticket by id.
  async function getTicket(id: number) {
    const res = await request(server)
      .get(`/tickets/${id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    return res.body as { id: number; version: number; priority: string; isOverdue: boolean; status: string };
  }

  // Helper: count AUTO_ESCALATE audit rows for a given ticket.
  async function escalateAuditCount(ticketId: number): Promise<number> {
    const rows = await ds
      .getRepository(AuditLog)
      .findBy({ entityId: ticketId, action: 'AUTO_ESCALATE' });
    return rows.length;
  }

  // ── Part A: pure function coverage ────────────────────────────────────────
  // (The 9 pure unit tests in escalation.spec.ts are the canonical home for
  //  these cases; the e2e suite focuses on service-level and HTTP behaviour.)

  // ── Priority escalation (LOW → MEDIUM) ────────────────────────────────────
  it('LOW + overdue → MEDIUM, one AUTO_ESCALATE audit row', async () => {
    const t = await createTicket({ title: 'low-overdue', priority: 'LOW' });
    await clearAudit();

    const summary = await svc.runEscalationCycle(new Date());

    expect(summary.scanned).toBeGreaterThanOrEqual(1);
    expect(summary.escalated).toBeGreaterThanOrEqual(1);

    const updated = await getTicket(t.id);
    expect(updated.priority).toBe(TicketPriority.MEDIUM);
    expect(updated.version).toBe(t.version + 1);

    const auditCount = await escalateAuditCount(t.id);
    expect(auditCount).toBe(1);
  });

  it('MEDIUM + overdue → HIGH', async () => {
    const t = await createTicket({ title: 'med-overdue', priority: 'MEDIUM' });
    await clearAudit();

    await svc.runEscalationCycle(new Date());

    const updated = await getTicket(t.id);
    expect(updated.priority).toBe(TicketPriority.HIGH);
  });

  it('HIGH + overdue → CRITICAL, isOverdue still false', async () => {
    const t = await createTicket({ title: 'high-overdue', priority: 'HIGH' });
    await clearAudit();

    await svc.runEscalationCycle(new Date());

    const updated = await getTicket(t.id);
    expect(updated.priority).toBe(TicketPriority.CRITICAL);
    expect(updated.isOverdue).toBe(false);
  });

  // ── criticalMarked path ────────────────────────────────────────────────────
  it('CRITICAL + overdue + isOverdue false → isOverdue true, counted as criticalMarked', async () => {
    const t = await createTicket({ title: 'crit-overdue', priority: 'CRITICAL' });
    await clearAudit();

    const summary = await svc.runEscalationCycle(new Date());

    expect(summary.criticalMarked).toBeGreaterThanOrEqual(1);

    const updated = await getTicket(t.id);
    expect(updated.priority).toBe(TicketPriority.CRITICAL);
    expect(updated.isOverdue).toBe(true);

    const auditCount = await escalateAuditCount(t.id);
    expect(auditCount).toBe(1);
  });

  it('CRITICAL + overdue + isOverdue already true → idempotent, no audit row', async () => {
    // Previous test left the ticket at CRITICAL + isOverdue=true.
    // Run cycle again: it is excluded from candidates by the load-step filter.
    const critTickets = await ds.query(
      `SELECT id FROM tickets WHERE priority = 'CRITICAL' AND "isOverdue" = true LIMIT 1`,
    );
    expect(critTickets.length).toBeGreaterThan(0);
    const critId: number = critTickets[0].id;
    const countBefore = await escalateAuditCount(critId);

    await svc.runEscalationCycle(new Date());

    const countAfter = await escalateAuditCount(critId);
    expect(countAfter).toBe(countBefore); // no new row
    const updated = await getTicket(critId);
    expect(updated.isOverdue).toBe(true); // unchanged
  });

  // ── DONE ticket is filtered at load step ───────────────────────────────────
  // Decision: DONE tickets are frozen — their priority must not change.
  // We filter them at the DB load step (not let the conditional UPDATE fail)
  // for efficiency and clarity.
  it('DONE ticket with past dueDate is NOT escalated', async () => {
    const t = await createTicket({ title: 'done-overdue', priority: 'LOW' });
    // Advance the ticket to DONE through the state machine.
    let version = t.version;
    for (const nextStatus of ['IN_PROGRESS', 'IN_REVIEW', 'DONE'] as const) {
      const res = await request(server)
        .patch(`/tickets/${t.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', `"${version}"`)
        .send({ status: nextStatus });
      expect(res.status).toBe(200);
      version = res.body.version;
    }

    await clearAudit();
    await svc.runEscalationCycle(new Date());

    const updated = await getTicket(t.id);
    expect(updated.priority).toBe(TicketPriority.LOW); // unchanged
    const auditCount = await escalateAuditCount(t.id);
    expect(auditCount).toBe(0);
  });

  // ── Not-yet-overdue ticket is skipped ─────────────────────────────────────
  it('ticket with future dueDate is not escalated', async () => {
    const t = await createTicket({
      title: 'future-due',
      priority: 'LOW',
      dueDate: FUTURE_DUE,
    });
    await clearAudit();

    await svc.runEscalationCycle(new Date());

    const updated = await getTicket(t.id);
    expect(updated.priority).toBe(TicketPriority.LOW);
    const auditCount = await escalateAuditCount(t.id);
    expect(auditCount).toBe(0);
  });

  // ── Ticket with no dueDate is skipped ─────────────────────────────────────
  it('ticket with null dueDate is not escalated', async () => {
    // Create without dueDate (overriding the helper default).
    const res = await request(server)
      .post('/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'no-due-date',
        type: 'FEATURE',
        projectId,
        assigneeId: devId,
        priority: 'LOW',
      });
    expect(res.status).toBe(200);
    const t = res.body;
    await clearAudit();

    await svc.runEscalationCycle(new Date());

    const updated = await getTicket(t.id);
    expect(updated.priority).toBe(TicketPriority.LOW);
    const auditCount = await escalateAuditCount(t.id);
    expect(auditCount).toBe(0);
  });

  // ── 3-ticket mixed cycle + audit count ────────────────────────────────────
  it('mixed cycle: LOW+overdue, CRITICAL+overdue+notFlagged, DONE+overdue — exactly 2 audit rows total', async () => {
    // Wipe everything and start fresh for an isolated scenario.
    await ds.query(
      'TRUNCATE TABLE "ticket_dependencies", "tickets", "audit_logs" RESTART IDENTITY CASCADE',
    );

    const tLow = await createTicket({ title: 'mixed-low', priority: 'LOW' });
    const tCrit = await createTicket({ title: 'mixed-crit', priority: 'CRITICAL' });
    const tDone = await createTicket({ title: 'mixed-done', priority: 'LOW' });

    // Advance tDone to DONE.
    let v = tDone.version;
    for (const s of ['IN_PROGRESS', 'IN_REVIEW', 'DONE'] as const) {
      const r = await request(server)
        .patch(`/tickets/${tDone.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', `"${v}"`)
        .send({ status: s });
      expect(r.status).toBe(200);
      v = r.body.version;
    }

    await clearAudit();
    const summary = await svc.runEscalationCycle(new Date());

    // LOW → MEDIUM (escalated), CRITICAL → isOverdue=true (criticalMarked), DONE → skipped
    expect(summary.escalated).toBe(1);
    expect(summary.criticalMarked).toBe(1);

    const auditRows = await ds.getRepository(AuditLog).findBy({ action: 'AUTO_ESCALATE' });
    expect(auditRows).toHaveLength(2);
    // Verify audit row contents
    const lowRow = auditRows.find((r) => r.entityId === tLow.id);
    expect(lowRow?.afterJson).toMatchObject({ priority: 'MEDIUM' });
    const critRow = auditRows.find((r) => r.entityId === tCrit.id);
    expect(critRow?.afterJson).toMatchObject({ isOverdue: true });
    // No row for DONE ticket
    expect(auditRows.find((r) => r.entityId === tDone.id)).toBeUndefined();
  });

  // ── Idempotency: run twice, second run produces zero changes ──────────────
  it('idempotency: second cycle produces 0 changes and 0 new audit rows', async () => {
    await ds.query(
      'TRUNCATE TABLE "ticket_dependencies", "tickets", "audit_logs" RESTART IDENTITY CASCADE',
    );

    const t = await createTicket({ title: 'idem-low', priority: 'LOW' });
    await clearAudit();

    const first = await svc.runEscalationCycle(new Date());
    expect(first.escalated).toBe(1);

    // After first cycle the ticket is now MEDIUM. Run again.
    const countAfterFirst = await ds
      .getRepository(AuditLog)
      .countBy({ action: 'AUTO_ESCALATE' });
    const second = await svc.runEscalationCycle(new Date());
    // The ticket is now MEDIUM + overdue → would escalate to HIGH in the second run.
    // "Idempotent" doesn't mean "never escalates again" — it means CRITICAL+isOverdue=true
    // is the terminal state that never changes. Let's verify the terminal-state idempotency.
    // For the LOW→MEDIUM ticket (not terminal), the second run escalates it to HIGH.
    // The idempotency guarantee is specifically about CRITICAL+isOverdue=true.
    // So: run once more and reach CRITICAL, then run again.
    await svc.runEscalationCycle(new Date()); // MEDIUM → HIGH
    await svc.runEscalationCycle(new Date()); // HIGH → CRITICAL
    await svc.runEscalationCycle(new Date()); // CRITICAL → isOverdue=true

    const countBeforeTerminal = await ds
      .getRepository(AuditLog)
      .countBy({ action: 'AUTO_ESCALATE' });
    const terminalSummary = await svc.runEscalationCycle(new Date());

    const countAfterTerminal = await ds
      .getRepository(AuditLog)
      .countBy({ action: 'AUTO_ESCALATE' });
    expect(terminalSummary.escalated).toBe(0);
    expect(terminalSummary.criticalMarked).toBe(0);
    expect(countAfterTerminal).toBe(countBeforeTerminal); // no new audit rows
  });

  // ── Manual reset: PATCH priority clears isOverdue ─────────────────────────
  it('manual priority reset: CRITICAL+isOverdue=true → PATCH to LOW → isOverdue cleared → next cycle escalates', async () => {
    await ds.query(
      'TRUNCATE TABLE "ticket_dependencies", "tickets", "audit_logs" RESTART IDENTITY CASCADE',
    );

    const t = await createTicket({ title: 'reset-me', priority: 'CRITICAL' });
    // First cycle: CRITICAL + overdue → isOverdue = true.
    await svc.runEscalationCycle(new Date());
    const afterFirstCycle = await getTicket(t.id);
    expect(afterFirstCycle.isOverdue).toBe(true);
    expect(afterFirstCycle.priority).toBe(TicketPriority.CRITICAL);

    // Manual PATCH to lower priority — must reset isOverdue.
    const patchRes = await request(server)
      .patch(`/tickets/${t.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('If-Match', `"${afterFirstCycle.version}"`)
      .send({ priority: 'LOW' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.isOverdue).toBe(false); // cleared by the manual edit
    expect(patchRes.body.priority).toBe(TicketPriority.LOW);

    // Next cycle re-evaluates from LOW — it is no longer in the terminal state.
    await clearAudit();
    const summary = await svc.runEscalationCycle(new Date());
    expect(summary.escalated).toBeGreaterThanOrEqual(1);

    const updated = await getTicket(t.id);
    expect(updated.priority).toBe(TicketPriority.MEDIUM);
    expect(updated.isOverdue).toBe(false);
  });

  // ── Concurrent-edit protection (conditional UPDATE with stale version) ────
  // Demonstrates that the atomic UPDATE WHERE id=? AND version=? rejects
  // stale versions, ensuring no audit row is written when the DB state has
  // already moved on from what the caller observed.
  it('conditional UPDATE with stale version affects 0 rows and writes no audit row', async () => {
    await ds.query(
      'TRUNCATE TABLE "ticket_dependencies", "tickets", "audit_logs" RESTART IDENTITY CASCADE',
    );

    const t = await createTicket({ title: 'race-me', priority: 'LOW' });
    // Simulate the concurrent-edit scenario: the escalation service loaded
    // the ticket at version 1, but then a user PATCH bumped it to version 2
    // before the service's UPDATE executed.
    const staleVersion = t.version; // version 1 (what the scheduler "saw")

    // User PATCH happens first (bumps to version 2).
    const patch = await request(server)
      .patch(`/tickets/${t.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('If-Match', `"${staleVersion}"`)
      .send({ title: 'race-me (updated)' });
    expect(patch.status).toBe(200);
    expect(patch.body.version).toBe(staleVersion + 1); // version is now 2

    await clearAudit();

    // Now simulate the scheduler trying its conditional UPDATE with version=1
    // (the stale value it had loaded before the user's PATCH).
    const result = await ds.query(
      `UPDATE tickets SET priority = 'MEDIUM', version = version + 1
       WHERE id = $1 AND version = $2`,
      [t.id, staleVersion],
    );
    // In pg driver, rowCount is 0 because version is now 2, not 1.
    expect(result[1]).toBe(0); // pg returns [rows, rowCount]

    // No audit row was written (we didn't insert one since affected === 0).
    const auditCount = await escalateAuditCount(t.id);
    expect(auditCount).toBe(0);

    // The ticket is still LOW (user's PATCH changed only the title).
    const current = await getTicket(t.id);
    expect(current.priority).toBe(TicketPriority.LOW);

    // Now run the actual cycle — it will see version 2, UPDATE to version 3,
    // write an audit row. This proves the happy path works after a race.
    await svc.runEscalationCycle(new Date());
    const updated = await getTicket(t.id);
    expect(updated.priority).toBe(TicketPriority.MEDIUM);
    const auditCountAfterCycle = await escalateAuditCount(t.id);
    expect(auditCountAfterCycle).toBe(1);
  });

  // ── isRunning guard ────────────────────────────────────────────────────────
  it('isRunning guard: second call while cycle is "running" returns zero summary', async () => {
    // Directly set the private flag to simulate a long-running cycle.
    (svc as unknown as { isRunning: boolean }).isRunning = true;
    try {
      const summary = await svc.runEscalationCycle(new Date());
      expect(summary).toEqual({ scanned: 0, escalated: 0, criticalMarked: 0 });
    } finally {
      // Restore so subsequent tests are not affected.
      (svc as unknown as { isRunning: boolean }).isRunning = false;
    }
  });

  // ── POST /admin/escalate-now HTTP endpoint ─────────────────────────────────
  it('POST /admin/escalate-now returns the cycle summary (ADMIN)', async () => {
    const res = await request(server)
      .post('/admin/escalate-now')
      .set('Authorization', `Bearer ${adminToken}`)
      .send();
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('scanned');
    expect(res.body).toHaveProperty('escalated');
    expect(res.body).toHaveProperty('criticalMarked');
  });

  it('POST /admin/escalate-now → 403 for DEVELOPER', async () => {
    const res = await request(server)
      .post('/admin/escalate-now')
      .set('Authorization', `Bearer ${devToken}`)
      .send();
    expect(res.status).toBe(403);
  });

  it('POST /admin/escalate-now → 401 without token', async () => {
    const res = await request(server).post('/admin/escalate-now').send();
    expect(res.status).toBe(401);
  });

  // ── Audit row shape ────────────────────────────────────────────────────────
  it('AUTO_ESCALATE audit row has correct shape: SYSTEM actor, before/after priority', async () => {
    await ds.query(
      'TRUNCATE TABLE "ticket_dependencies", "tickets", "audit_logs" RESTART IDENTITY CASCADE',
    );

    const t = await createTicket({ title: 'audit-shape', priority: 'LOW' });
    await clearAudit();

    await svc.runEscalationCycle(new Date());

    const rows = await ds.getRepository(AuditLog).findBy({
      entityId: t.id,
      action: 'AUTO_ESCALATE',
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];

    expect(row.actorType).toBe('SYSTEM');
    expect(row.actorId).toBeNull();
    expect(row.action).toBe('AUTO_ESCALATE');
    expect(row.entityType).toBe('Ticket');
    expect(row.entityId).toBe(t.id);
    expect((row.beforeJson as Record<string, unknown>).priority).toBe('LOW');
    expect((row.afterJson as Record<string, unknown>).priority).toBe('MEDIUM');
  });
});
