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

describe('Audit log: retrofit + GET /audit-logs (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let devToken: string;
  let adminId: number;
  let projectId: number;
  let ds: DataSource;

  beforeAll(async () => {
    const mod: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = mod.createNestApplication();
    configureApp(app);
    await app.init();

    ds = app.get(DataSource);
    await ds.query(
      'TRUNCATE TABLE "ticket_dependencies", "tickets", "projects", "users", "audit_logs" RESTART IDENTITY CASCADE',
    );

    const server = app.getHttpServer();

    const a = await request(server).post('/users').send({
      username: 'auditadmin',
      email: 'auditadmin@example.com',
      fullName: 'Audit Admin',
      role: 'ADMIN',
      password: 'secret123',
    });
    adminId = a.body.id;

    await request(server).post('/users').send({
      username: 'auditdev',
      email: 'auditdev@example.com',
      fullName: 'Audit Dev',
      role: 'DEVELOPER',
      password: 'secret123',
    });

    adminToken = (
      await request(server)
        .post('/auth/login')
        .send({ username: 'auditadmin', password: 'secret123' })
    ).body.accessToken;

    devToken = (
      await request(server)
        .post('/auth/login')
        .send({ username: 'auditdev', password: 'secret123' })
    ).body.accessToken;

    const p = await request(server)
      .post('/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'AuditProj', ownerId: adminId });
    projectId = p.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const logsRepo = () => ds.getRepository(AuditLog);
  const truncateAudit = () =>
    ds.query('TRUNCATE TABLE "audit_logs" RESTART IDENTITY CASCADE');

  // ── Retrofit: exactly-one audit row per state-changing operation ─────────

  describe('Retrofit verification — exactly one audit row per operation', () => {
    it('create ticket with manual assignee → ONE row, TICKET_CREATE only (no AUTO_ASSIGN)', async () => {
      await truncateAudit();
      const res = await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Manual-assign',
          type: 'BUG',
          projectId,
          assigneeId: adminId,
        })
        .expect(200);
      const logs = await logsRepo().find();
      expect(logs.length).toBe(1);
      expect(logs[0]).toMatchObject({
        action: 'TICKET_CREATE',
        entityType: 'Ticket',
        entityId: res.body.id,
        actorType: 'USER',
        actorId: adminId,
      });
      expect(logs[0].beforeJson).toBeNull();
      expect(logs[0].afterJson).toMatchObject({
        id: res.body.id,
        title: 'Manual-assign',
        assigneeId: adminId,
      });
    });

    it('update project → ONE row, PROJECT_UPDATE with before/after diff visible', async () => {
      await truncateAudit();
      const original = (
        await request(app.getHttpServer())
          .get(`/projects/${projectId}`)
          .set('Authorization', `Bearer ${adminToken}`)
      ).body;
      await request(app.getHttpServer())
        .patch(`/projects/${projectId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'AuditProj-Renamed' })
        .expect(200);
      const logs = await logsRepo().find();
      expect(logs.length).toBe(1);
      expect(logs[0]).toMatchObject({
        action: 'PROJECT_UPDATE',
        entityType: 'Project',
        entityId: projectId,
        actorType: 'USER',
        actorId: adminId,
      });
      const before = logs[0].beforeJson as Record<string, unknown>;
      const after = logs[0].afterJson as Record<string, unknown>;
      expect(before.name).toBe(original.name);
      expect(after.name).toBe('AuditProj-Renamed');
    });

    it('restore ticket → ONE row, TICKET_RESTORE with before.deletedAt set and after.deletedAt null', async () => {
      // Create + delete + then restore — assert only the RESTORE audit row
      // exists by truncating immediately before the restore call.
      const t = (
        await request(app.getHttpServer())
          .post('/tickets')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ title: 'will-restore', type: 'BUG', projectId, assigneeId: adminId })
      ).body;
      await request(app.getHttpServer())
        .delete(`/tickets/${t.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      await truncateAudit();
      await request(app.getHttpServer())
        .post(`/tickets/${t.id}/restore`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const logs = await logsRepo().find();
      expect(logs.length).toBe(1);
      expect(logs[0]).toMatchObject({
        action: 'TICKET_RESTORE',
        entityType: 'Ticket',
        entityId: t.id,
        actorType: 'USER',
        actorId: adminId,
      });
      const before = logs[0].beforeJson as Record<string, unknown>;
      const after = logs[0].afterJson as Record<string, unknown>;
      expect(before.deletedAt).not.toBeNull();
      expect(after.deletedAt).toBeNull();
    });

    it('auto-assigned create → TWO rows: TICKET_CREATE + AUTO_ASSIGN', async () => {
      await truncateAudit();
      const res = await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'auto-assigned', type: 'BUG', projectId })
        .expect(200);
      const logs = await logsRepo().find({ order: { id: 'ASC' } });
      expect(logs.length).toBe(2);
      const actions = logs.map((l) => l.action);
      expect(actions).toContain('TICKET_CREATE');
      expect(actions).toContain('AUTO_ASSIGN');
      const autoAssign = logs.find((l) => l.action === 'AUTO_ASSIGN')!;
      expect(autoAssign.actorType).toBe('SYSTEM');
      expect(autoAssign.actorId).toBeNull();
      expect(autoAssign.entityId).toBe(res.body.id);
    });
  });

  // ── passwordHash filter ─────────────────────────────────────────────────────

  describe('passwordHash stripping', () => {
    it('USER_CREATE audit row has no passwordHash in afterJson', async () => {
      await truncateAudit();
      const res = await request(app.getHttpServer())
        .post('/users')
        .send({
          username: 'hashtest',
          email: 'hashtest@example.com',
          fullName: 'Hash Test',
          role: 'DEVELOPER',
          password: 'secret123',
        })
        .expect(200);
      const logs = await logsRepo().find({
        where: { action: 'USER_CREATE', entityId: res.body.id },
      });
      expect(logs.length).toBe(1);
      const after = logs[0].afterJson as Record<string, unknown>;
      expect(after.passwordHash).toBeUndefined();
      // Sanity: other fields are present.
      expect(after.username).toBe('hashtest');
      expect(after.email).toBe('hashtest@example.com');
    });
  });

  // ── Failed-operation = no audit row ─────────────────────────────────────────

  describe('Failed operations never leave an audit row', () => {
    let ticketId: number;
    let currentVersion: number;

    beforeAll(async () => {
      const r = await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'failtest',
          type: 'BUG',
          projectId,
          assigneeId: adminId,
        });
      ticketId = r.body.id;
      currentVersion = r.body.version;
    });

    it('412 stale If-Match → 0 new audit rows', async () => {
      await truncateAudit();
      await request(app.getHttpServer())
        .patch(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', '"999"')
        .send({ title: 'wont-apply' })
        .expect(412);
      const logs = await logsRepo().find();
      expect(logs.length).toBe(0);
    });

    it('428 missing If-Match → 0 new audit rows', async () => {
      await truncateAudit();
      await request(app.getHttpServer())
        .patch(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'wont-apply' })
        .expect(428);
      const logs = await logsRepo().find();
      expect(logs.length).toBe(0);
    });

    it('409 DONE-frozen → 0 new audit rows', async () => {
      // Walk to DONE
      let v = currentVersion;
      for (const s of ['IN_PROGRESS', 'IN_REVIEW', 'DONE']) {
        const r = await request(app.getHttpServer())
          .patch(`/tickets/${ticketId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .set('If-Match', `"${v}"`)
          .send({ status: s })
          .expect(200);
        v = r.body.version;
      }
      // Now try to update a DONE ticket — 409
      await truncateAudit();
      await request(app.getHttpServer())
        .patch(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', `"${v}"`)
        .send({ title: 'frozen-cant-rename' })
        .expect(409);
      const logs = await logsRepo().find();
      expect(logs.length).toBe(0);
    });

    it('404 on bad assigneeId during ticket create → 0 audit rows', async () => {
      await truncateAudit();
      await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'bad-assignee',
          type: 'BUG',
          projectId,
          assigneeId: 99999,
        })
        .expect(404);
      const logs = await logsRepo().find();
      expect(logs.length).toBe(0);
    });
  });

  // ── GET /audit-logs endpoint ────────────────────────────────────────────────

  describe('GET /audit-logs', () => {
    beforeAll(async () => {
      // Build a known set of rows: 3 ticket creates + 2 project creates.
      await truncateAudit();
      await ds.query(
        'TRUNCATE TABLE "ticket_dependencies", "tickets" RESTART IDENTITY CASCADE',
      );
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer())
          .post('/tickets')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            title: `seed-${i}`,
            type: 'BUG',
            projectId,
            assigneeId: adminId,
          });
      }
      for (let i = 0; i < 2; i++) {
        await request(app.getHttpServer())
          .post('/projects')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ name: `seed-proj-${i}`, ownerId: adminId });
      }
    });

    it('no filter → all 5 rows, newest first', async () => {
      const r = await request(app.getHttpServer())
        .get('/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(r.body.total).toBe(5);
      expect(r.body.page).toBe(1);
      expect(r.body.limit).toBe(50);
      // newest first
      for (let i = 1; i < r.body.data.length; i++) {
        const prev = new Date(r.body.data[i - 1].createdAt).getTime();
        const cur = new Date(r.body.data[i].createdAt).getTime();
        expect(prev).toBeGreaterThanOrEqual(cur);
      }
    });

    it('filter by entityType=Project → 2 rows', async () => {
      const r = await request(app.getHttpServer())
        .get('/audit-logs?entityType=Project')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(r.body.total).toBe(2);
      expect(
        r.body.data.every((e: { entityType: string }) => e.entityType === 'Project'),
      ).toBe(true);
    });

    it('filter by action=TICKET_CREATE → 3 rows', async () => {
      const r = await request(app.getHttpServer())
        .get('/audit-logs?action=TICKET_CREATE')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(r.body.total).toBe(3);
    });

    it('combined filter entityType=Ticket&action=TICKET_CREATE → 3 rows', async () => {
      const r = await request(app.getHttpServer())
        .get('/audit-logs?entityType=Ticket&action=TICKET_CREATE')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(r.body.total).toBe(3);
    });

    it('filter by actor=adminId → all 5 rows (admin made them all)', async () => {
      const r = await request(app.getHttpServer())
        .get(`/audit-logs?actor=${adminId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(r.body.total).toBe(5);
    });

    it('pagination page=1 limit=2 → 2 entries, total=5', async () => {
      const r = await request(app.getHttpServer())
        .get('/audit-logs?page=1&limit=2')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(r.body.total).toBe(5);
      expect(r.body.data.length).toBe(2);
      expect(r.body.page).toBe(1);
      expect(r.body.limit).toBe(2);
    });

    it('pagination page=2 limit=2 → next 2 entries, total still 5', async () => {
      const all = (
        await request(app.getHttpServer())
          .get('/audit-logs?limit=50')
          .set('Authorization', `Bearer ${adminToken}`)
      ).body.data;
      const r = await request(app.getHttpServer())
        .get('/audit-logs?page=2&limit=2')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(r.body.data.length).toBe(2);
      // Page 2 should be items 2 and 3 (0-indexed) of the unpaginated list.
      expect(r.body.data[0].id).toBe(all[2].id);
      expect(r.body.data[1].id).toBe(all[3].id);
    });

    it('limit > 200 → 400 (DTO @Max(200))', async () => {
      await request(app.getHttpServer())
        .get('/audit-logs?limit=999')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('invalid entityId (not a number) → 400', async () => {
      await request(app.getHttpServer())
        .get('/audit-logs?entityId=abc')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('DEVELOPER → 403', async () => {
      await request(app.getHttpServer())
        .get('/audit-logs')
        .set('Authorization', `Bearer ${devToken}`)
        .expect(403);
    });

    it('no token → 401', async () => {
      await request(app.getHttpServer())
        .get('/audit-logs')
        .expect(401);
    });
  });
});
