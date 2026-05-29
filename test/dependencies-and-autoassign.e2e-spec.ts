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
import { AllExceptionsFilter } from './../src/common/all-exceptions.filter';
import { AuditLog } from './../src/audit/audit-log.entity';

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

describe('Ticket dependencies + DONE-blocker rule + auto-assignment + workload (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let devAToken: string;
  let adminId: number;
  let devAId: number;
  let devBId: number;
  let projectId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    const ds = app.get(DataSource);
    await ds.query(
      'TRUNCATE TABLE "ticket_dependencies", "tickets", "projects", "users", "audit_logs" RESTART IDENTITY CASCADE',
    );

    const server = app.getHttpServer();

    const a = await request(server).post('/users').send({
      username: 's5admin',
      email: 's5admin@example.com',
      fullName: 'S5 Admin',
      role: 'ADMIN',
      password: 'secret123',
    });
    adminId = a.body.id;

    const dA = await request(server).post('/users').send({
      username: 's5devA',
      email: 's5devA@example.com',
      fullName: 'Dev A',
      role: 'DEVELOPER',
      password: 'secret123',
    });
    devAId = dA.body.id;

    // Different createdAt so the tie-breaker is testable
    await new Promise((r) => setTimeout(r, 50));

    const dB = await request(server).post('/users').send({
      username: 's5devB',
      email: 's5devB@example.com',
      fullName: 'Dev B',
      role: 'DEVELOPER',
      password: 'secret123',
    });
    devBId = dB.body.id;

    adminToken = (
      await request(server)
        .post('/auth/login')
        .send({ username: 's5admin', password: 'secret123' })
    ).body.accessToken;

    devAToken = (
      await request(server)
        .post('/auth/login')
        .send({ username: 's5devA', password: 'secret123' })
    ).body.accessToken;

    const p = await request(server)
      .post('/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'S5Proj', ownerId: adminId });
    projectId = p.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Auto-assignment ────────────────────────────────────────────────────────

  describe('Auto-assignment on POST /tickets', () => {
    it('ADMIN is never an auto-assign candidate even with 0 tickets', async () => {
      const r = await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'A0', type: 'BUG', projectId });
      expect(r.body.assigneeId).not.toBe(adminId);
      // Should pick a DEVELOPER (Dev A in this fresh DB — earliest registered).
      expect([devAId, devBId]).toContain(r.body.assigneeId);
    });

    it('tie at workload [0,0] → earliest-registered (Dev A) wins', async () => {
      // Wipe tickets so we start tied.
      await app
        .get(DataSource)
        .query('TRUNCATE TABLE "tickets" RESTART IDENTITY CASCADE');
      const r = await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'T-tie', type: 'BUG', projectId });
      expect(r.body.assigneeId).toBe(devAId);
    });

    it('workload [1,0] (Dev A has one, Dev B has none) → Dev B wins', async () => {
      const r = await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'T-second', type: 'BUG', projectId });
      expect(r.body.assigneeId).toBe(devBId);
    });

    it('workload [1,1] tie → Dev A wins again (earliest registered)', async () => {
      const r = await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'T-third', type: 'BUG', projectId });
      expect(r.body.assigneeId).toBe(devAId);
    });

    it('explicit assigneeId is honored (no auto-assign override)', async () => {
      const r = await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'T-explicit',
          type: 'BUG',
          projectId,
          assigneeId: devBId,
        });
      expect(r.body.assigneeId).toBe(devBId);
    });

    it('explicit assigneeId pointing nowhere → 404', async () => {
      await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'X',
          type: 'BUG',
          projectId,
          assigneeId: 99999,
        })
        .expect(404);
    });

    it('AUTO_ASSIGN audit row written alongside the Session-6 TICKET_CREATE row', async () => {
      // Truncate tickets + audit so we know the next create's rows are the
      // only ones present.
      const ds = app.get(DataSource);
      await ds.query('TRUNCATE TABLE "tickets" RESTART IDENTITY CASCADE');
      await ds.query('TRUNCATE TABLE "audit_logs" RESTART IDENTITY CASCADE');

      const r = await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'T-audit', type: 'BUG', projectId });
      const ticketId = r.body.id;
      const expectedAssignee = r.body.assigneeId;

      const logs = await ds.getRepository(AuditLog).find({
        order: { id: 'ASC' },
      });
      // Session 6 retrofitted TICKET_CREATE — auto-assigned creates now
      // produce two audit rows: the user-driven create AND the system-
      // driven assignment.
      expect(logs.length).toBe(2);
      const actions = logs.map((l) => l.action);
      expect(actions).toContain('TICKET_CREATE');
      expect(actions).toContain('AUTO_ASSIGN');

      const autoAssign = logs.find((l) => l.action === 'AUTO_ASSIGN')!;
      expect(autoAssign).toMatchObject({
        actorType: 'SYSTEM',
        actorId: null,
        entityType: 'Ticket',
        entityId: ticketId,
      });
      expect(autoAssign.afterJson).toEqual({ assigneeId: expectedAssignee });
    });

    describe('no DEVELOPERs in the system', () => {
      // The dev-role demotion must be reversed even if a downstream
      // assertion throws — otherwise later workload tests see no
      // DEVELOPERs and fail with cascading "undefined" errors.
      afterEach(async () => {
        for (const u of [devAId, devBId]) {
          await request(app.getHttpServer())
            .post(`/users/update/${u}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ role: 'DEVELOPER' });
        }
      });

      it('assigneeId is null, no AUTO_ASSIGN row (TICKET_CREATE still fires)', async () => {
        for (const u of [devAId, devBId]) {
          await request(app.getHttpServer())
            .post(`/users/update/${u}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ role: 'ADMIN' })
            .expect(200);
        }
        const ds = app.get(DataSource);
        await ds.query('TRUNCATE TABLE "audit_logs" RESTART IDENTITY CASCADE');

        const r = await request(app.getHttpServer())
          .post('/tickets')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ title: 'T-no-devs', type: 'BUG', projectId })
          .expect(200);
        expect(r.body.assigneeId).toBeNull();

        const logs = await ds.getRepository(AuditLog).find();
        const actions = logs.map((l) => l.action);
        // TICKET_CREATE always; AUTO_ASSIGN only when an assignee was
        // actually picked — which didn't happen here.
        expect(actions).toEqual(['TICKET_CREATE']);
      });
    });
  });

  // ── Workload endpoint ──────────────────────────────────────────────────────

  describe('GET /projects/:id/workload', () => {
    it('returns counts in ascending order; includes devs with 0; excludes ADMIN', async () => {
      const ds = app.get(DataSource);
      await ds.query('TRUNCATE TABLE "tickets" RESTART IDENTITY CASCADE');

      // Give Dev A two tickets, Dev B one
      for (let i = 0; i < 2; i++) {
        await request(app.getHttpServer())
          .post('/tickets')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            title: `A-load-${i}`,
            type: 'BUG',
            projectId,
            assigneeId: devAId,
          });
      }
      await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'B-load',
          type: 'BUG',
          projectId,
          assigneeId: devBId,
        });

      const r = await request(app.getHttpServer())
        .get(`/projects/${projectId}/workload`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // ADMIN never appears.
      expect(r.body.every((e: { userId: number }) => e.userId !== adminId)).toBe(
        true,
      );
      // Both devs appear.
      const byId = new Map<number, number>(
        r.body.map((e: { userId: number; openTicketCount: number }) => [
          e.userId,
          e.openTicketCount,
        ]),
      );
      expect(byId.get(devAId)).toBe(2);
      expect(byId.get(devBId)).toBe(1);
      // Sorted ascending — first entry has the lowest count.
      const counts = r.body.map(
        (e: { openTicketCount: number }) => e.openTicketCount,
      );
      const sorted = [...counts].sort((a, b) => a - b);
      expect(counts).toEqual(sorted);
    });

    it('non-DONE only: DONE tickets do not count', async () => {
      const ds = app.get(DataSource);
      await ds.query('TRUNCATE TABLE "tickets" RESTART IDENTITY CASCADE');

      // One ticket for Dev A, walk to DONE.
      const t = (
        await request(app.getHttpServer())
          .post('/tickets')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            title: 'will-be-done',
            type: 'BUG',
            projectId,
            assigneeId: devAId,
          })
      ).body;
      let v = t.version;
      for (const s of ['IN_PROGRESS', 'IN_REVIEW', 'DONE']) {
        const r = await request(app.getHttpServer())
          .patch(`/tickets/${t.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .set('If-Match', `"${v}"`)
          .send({ status: s });
        v = r.body.version;
      }

      const r = await request(app.getHttpServer())
        .get(`/projects/${projectId}/workload`)
        .set('Authorization', `Bearer ${adminToken}`);
      const devA = r.body.find((e: { userId: number }) => e.userId === devAId);
      expect(devA.openTicketCount).toBe(0);
    });

    it('non-DEVELOPER token still gets 200 (read-only data, no role gate on the endpoint)', async () => {
      await request(app.getHttpServer())
        .get(`/projects/${projectId}/workload`)
        .set('Authorization', `Bearer ${devAToken}`)
        .expect(200);
    });

    it('no token → 401', async () => {
      await request(app.getHttpServer())
        .get(`/projects/${projectId}/workload`)
        .expect(401);
    });

    it('unknown project → 404', async () => {
      await request(app.getHttpServer())
        .get(`/projects/99999/workload`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });

  // ── Dependencies ───────────────────────────────────────────────────────────

  describe('Ticket dependencies', () => {
    let t1: number, t2: number, t3: number;

    beforeEach(async () => {
      const ds = app.get(DataSource);
      await ds.query(
        'TRUNCATE TABLE "ticket_dependencies", "tickets" RESTART IDENTITY CASCADE',
      );
      const mk = async (title: string) =>
        (
          await request(app.getHttpServer())
            .post('/tickets')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ title, type: 'BUG', projectId })
        ).body.id as number;
      t1 = await mk('t1');
      t2 = await mk('t2');
      t3 = await mk('t3');
    });

    it('adds a blocker (200) and GET /dependencies returns it', async () => {
      await request(app.getHttpServer())
        .post(`/tickets/${t1}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ blockedBy: t2 })
        .expect(200);
      const r = await request(app.getHttpServer())
        .get(`/tickets/${t1}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(r.body.map((b: { id: number }) => b.id)).toEqual([t2]);
    });

    it('self-dependency → 400', async () => {
      const r = await request(app.getHttpServer())
        .post(`/tickets/${t1}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ blockedBy: t1 })
        .expect(400);
      expect(r.body.message).toMatch(/cannot block itself/i);
    });

    it('cross-project → 400', async () => {
      const otherProj = (
        await request(app.getHttpServer())
          .post('/projects')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ name: 'OtherP', ownerId: adminId })
      ).body.id;
      const otherTicket = (
        await request(app.getHttpServer())
          .post('/tickets')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ title: 'foreign', type: 'BUG', projectId: otherProj })
      ).body.id;
      const r = await request(app.getHttpServer())
        .post(`/tickets/${t1}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ blockedBy: otherTicket })
        .expect(400);
      expect(r.body.message).toMatch(/same project/i);
    });

    it('direct 2-node cycle (A blocks B, then B blocks A) → 400', async () => {
      await request(app.getHttpServer())
        .post(`/tickets/${t1}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ blockedBy: t2 })
        .expect(200);
      // Now t2 blockedBy t1 would close: t1→t2→t1
      const r = await request(app.getHttpServer())
        .post(`/tickets/${t2}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ blockedBy: t1 })
        .expect(400);
      expect(r.body.message).toMatch(/cycle/i);
    });

    it('3-node cycle (A→B→C→A) → 400 (proves BFS handles depth)', async () => {
      await request(app.getHttpServer())
        .post(`/tickets/${t1}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ blockedBy: t2 })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/tickets/${t2}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ blockedBy: t3 })
        .expect(200);
      // Now t3 blockedBy t1 would close: t1→t2→t3→t1
      const r = await request(app.getHttpServer())
        .post(`/tickets/${t3}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ blockedBy: t1 })
        .expect(400);
      expect(r.body.message).toMatch(/cycle/i);
    });

    it('DELETE removes a blocker (200); subsequent DELETE → 404', async () => {
      await request(app.getHttpServer())
        .post(`/tickets/${t1}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ blockedBy: t2 })
        .expect(200);
      await request(app.getHttpServer())
        .delete(`/tickets/${t1}/dependencies/${t2}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .delete(`/tickets/${t1}/dependencies/${t2}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });

    it('soft-deleted blocker is hidden by GET /dependencies', async () => {
      await request(app.getHttpServer())
        .post(`/tickets/${t1}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ blockedBy: t2 })
        .expect(200);
      // Soft-delete t2
      await request(app.getHttpServer())
        .delete(`/tickets/${t2}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const r = await request(app.getHttpServer())
        .get(`/tickets/${t1}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(r.body).toEqual([]);
    });

    it('cannot ADD a soft-deleted ticket as a blocker → 404', async () => {
      // Soft-delete t3 first
      await request(app.getHttpServer())
        .delete(`/tickets/${t3}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/tickets/${t1}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ blockedBy: t3 })
        .expect(404);
    });

    it('re-adding the same dependency is idempotent (200, no duplicate row)', async () => {
      await request(app.getHttpServer())
        .post(`/tickets/${t1}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ blockedBy: t2 })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/tickets/${t1}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ blockedBy: t2 })
        .expect(200);
      const r = await request(app.getHttpServer())
        .get(`/tickets/${t1}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(r.body.length).toBe(1);
    });
  });

  // ── DONE-blocker rule ──────────────────────────────────────────────────────

  describe('DONE-blocker rule on PATCH', () => {
    let target: number;
    let blocker: number;

    beforeEach(async () => {
      const ds = app.get(DataSource);
      await ds.query(
        'TRUNCATE TABLE "ticket_dependencies", "tickets" RESTART IDENTITY CASCADE',
      );
      target = (
        await request(app.getHttpServer())
          .post('/tickets')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ title: 'target', type: 'BUG', projectId })
      ).body.id;
      blocker = (
        await request(app.getHttpServer())
          .post('/tickets')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ title: 'blocker', type: 'BUG', projectId })
      ).body.id;
    });

    const walkTo = async (id: number, statuses: string[]) => {
      let v = (
        await request(app.getHttpServer())
          .get(`/tickets/${id}`)
          .set('Authorization', `Bearer ${adminToken}`)
      ).body.version;
      for (const s of statuses) {
        const r = await request(app.getHttpServer())
          .patch(`/tickets/${id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .set('If-Match', `"${v}"`)
          .send({ status: s });
        v = r.body.version;
      }
      return v;
    };

    it('target with open blocker → PATCH to DONE 400 names blocker id', async () => {
      await request(app.getHttpServer())
        .post(`/tickets/${target}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ blockedBy: blocker })
        .expect(200);
      const v = await walkTo(target, ['IN_PROGRESS', 'IN_REVIEW']);
      const r = await request(app.getHttpServer())
        .patch(`/tickets/${target}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', `"${v}"`)
        .send({ status: 'DONE' })
        .expect(400);
      expect(r.body.message).toMatch(new RegExp(`\\[${blocker}\\]`));
      expect(r.body.message).toMatch(/Cannot transition to DONE/);
    });

    it('all blockers DONE → target can transition to DONE', async () => {
      await request(app.getHttpServer())
        .post(`/tickets/${target}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ blockedBy: blocker })
        .expect(200);
      await walkTo(blocker, ['IN_PROGRESS', 'IN_REVIEW', 'DONE']);
      const v = await walkTo(target, ['IN_PROGRESS', 'IN_REVIEW']);
      const r = await request(app.getHttpServer())
        .patch(`/tickets/${target}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', `"${v}"`)
        .send({ status: 'DONE' })
        .expect(200);
      expect(r.body.status).toBe('DONE');
    });

    it('no blockers → target can transition to DONE freely', async () => {
      const v = await walkTo(target, ['IN_PROGRESS', 'IN_REVIEW']);
      await request(app.getHttpServer())
        .patch(`/tickets/${target}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', `"${v}"`)
        .send({ status: 'DONE' })
        .expect(200);
    });

    it('multiple open blockers → message lists all ids', async () => {
      const blocker2 = (
        await request(app.getHttpServer())
          .post('/tickets')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ title: 'blocker2', type: 'BUG', projectId })
      ).body.id;
      await request(app.getHttpServer())
        .post(`/tickets/${target}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ blockedBy: blocker })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/tickets/${target}/dependencies`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ blockedBy: blocker2 })
        .expect(200);
      const v = await walkTo(target, ['IN_PROGRESS', 'IN_REVIEW']);
      const r = await request(app.getHttpServer())
        .patch(`/tickets/${target}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', `"${v}"`)
        .send({ status: 'DONE' })
        .expect(400);
      expect(r.body.message).toMatch(new RegExp(`${blocker}`));
      expect(r.body.message).toMatch(new RegExp(`${blocker2}`));
    });
  });
});
