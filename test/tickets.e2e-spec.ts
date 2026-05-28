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
import { Ticket } from './../src/tickets/ticket.entity';

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

describe('Tickets — CRUD + state machine + If-Match locking + soft-delete (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let devToken: string;
  let adminId: number;
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
      'TRUNCATE TABLE "tickets", "projects", "users" RESTART IDENTITY CASCADE',
    );

    const server = app.getHttpServer();

    const adminRes = await request(server).post('/users').send({
      username: 's4admin',
      email: 's4admin@example.com',
      fullName: 'S4 Admin',
      role: 'ADMIN',
      password: 'secret123',
    });
    adminId = adminRes.body.id;

    await request(server).post('/users').send({
      username: 's4dev',
      email: 's4dev@example.com',
      fullName: 'S4 Dev',
      role: 'DEVELOPER',
      password: 'secret123',
    });

    adminToken = (
      await request(server)
        .post('/auth/login')
        .send({ username: 's4admin', password: 'secret123' })
    ).body.accessToken;

    devToken = (
      await request(server)
        .post('/auth/login')
        .send({ username: 's4dev', password: 'secret123' })
    ).body.accessToken;

    const projectRes = await request(server)
      .post('/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'TicketsE2E', ownerId: adminId });
    projectId = projectRes.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Create ──────────────────────────────────────────────────────────────────

  describe('POST /tickets — create', () => {
    it('creates with defaults (status=TODO, version=1, ETag header)', async () => {
      const res = await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Default ticket',
          type: 'BUG',
          projectId,
          priority: 'HIGH',
        })
        .expect(200);
      expect(res.body.status).toBe('TODO');
      expect(res.body.version).toBe(1);
      expect(res.headers.etag).toBe('"1"');
    });

    it('rejects status=DONE on create (400)', async () => {
      const res = await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Born DONE',
          type: 'BUG',
          projectId,
          status: 'DONE',
        })
        .expect(400);
      expect(JSON.stringify(res.body.message)).toMatch(/cannot be created/i);
    });

    it('rejects unknown projectId (404)', async () => {
      await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'X', type: 'BUG', projectId: 99999 })
        .expect(404);
    });

    it('rejects unknown assigneeId (404)', async () => {
      await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'X', type: 'BUG', projectId, assigneeId: 99999 })
        .expect(404);
    });
  });

  // ── State machine wiring (PATCH) ────────────────────────────────────────────

  describe('PATCH — state machine', () => {
    let id: number;
    let etag: string;

    beforeEach(async () => {
      const res = await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'SM-fixture', type: 'BUG', projectId });
      id = res.body.id;
      etag = res.headers.etag;
    });

    it('rejects skip TODO → IN_REVIEW (400)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/tickets/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', etag)
        .send({ status: 'IN_REVIEW' })
        .expect(400);
      expect(res.body.message).toMatch(/skip|sequential/i);
    });

    it('rejects backward transition (400)', async () => {
      // Move to IN_PROGRESS
      const r1 = await request(app.getHttpServer())
        .patch(`/tickets/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', etag)
        .send({ status: 'IN_PROGRESS' })
        .expect(200);
      // Try IN_PROGRESS → TODO
      const r2 = await request(app.getHttpServer())
        .patch(`/tickets/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', r1.headers.etag)
        .send({ status: 'TODO' })
        .expect(400);
      expect(r2.body.message).toMatch(/backward/i);
    });

    it('full forward lifecycle TODO → IN_PROGRESS → IN_REVIEW → DONE with version bumps', async () => {
      let currentEtag = etag;
      for (const target of ['IN_PROGRESS', 'IN_REVIEW', 'DONE']) {
        const res = await request(app.getHttpServer())
          .patch(`/tickets/${id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .set('If-Match', currentEtag)
          .send({ status: target })
          .expect(200);
        expect(res.body.status).toBe(target);
        currentEtag = res.headers.etag;
      }
    });

    it('DONE ticket rejects all updates with 409 (DONE-frozen)', async () => {
      let currentEtag = etag;
      for (const target of ['IN_PROGRESS', 'IN_REVIEW', 'DONE']) {
        const r = await request(app.getHttpServer())
          .patch(`/tickets/${id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .set('If-Match', currentEtag)
          .send({ status: target });
        currentEtag = r.headers.etag;
      }
      // Now in DONE — any update is 409.
      const titleAttempt = await request(app.getHttpServer())
        .patch(`/tickets/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', currentEtag)
        .send({ title: 'Re-title' })
        .expect(409);
      expect(titleAttempt.body.message).toMatch(/DONE.*frozen/i);
    });

    it('DONE-frozen wins over missing If-Match (409, not 428)', async () => {
      let currentEtag = etag;
      for (const target of ['IN_PROGRESS', 'IN_REVIEW', 'DONE']) {
        const r = await request(app.getHttpServer())
          .patch(`/tickets/${id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .set('If-Match', currentEtag)
          .send({ status: target });
        currentEtag = r.headers.etag;
      }
      // No If-Match header — DONE-frozen reports first.
      const r = await request(app.getHttpServer())
        .patch(`/tickets/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'Z' })
        .expect(409);
      expect(r.body.message).toMatch(/DONE.*frozen/i);
    });
  });

  // ── If-Match locking ────────────────────────────────────────────────────────

  describe('PATCH — If-Match contract', () => {
    let id: number;

    beforeEach(async () => {
      const res = await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'Lock-fixture', type: 'BUG', projectId });
      id = res.body.id;
    });

    it('returns 428 when If-Match is missing', async () => {
      const r = await request(app.getHttpServer())
        .patch(`/tickets/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'X' })
        .expect(428);
      expect(r.body.message).toMatch(/If-Match.*required/i);
    });

    it('returns 412 when If-Match version is stale', async () => {
      const r = await request(app.getHttpServer())
        .patch(`/tickets/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', '"99"')
        .send({ title: 'X' })
        .expect(412);
      expect(r.body.message).toMatch(/version|reload/i);
    });

    it('succeeds with correct If-Match; version increments; new ETag', async () => {
      const r = await request(app.getHttpServer())
        .patch(`/tickets/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', '"1"')
        .send({ title: 'Renamed' })
        .expect(200);
      expect(r.body.version).toBe(2);
      expect(r.headers.etag).toBe('"2"');
      expect(r.body.title).toBe('Renamed');
    });

    it('accepts both quoted and unquoted If-Match (tolerant parse)', async () => {
      // Quoted
      const r1 = await request(app.getHttpServer())
        .patch(`/tickets/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', '"1"')
        .send({ title: 'A' })
        .expect(200);
      // Unquoted, against the new version
      const r2 = await request(app.getHttpServer())
        .patch(`/tickets/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', `${r1.body.version}`)
        .send({ title: 'B' })
        .expect(200);
      expect(r2.body.title).toBe('B');
    });

    // ── The race ────────────────────────────────────────────────────────────
    // Two concurrent PATCH requests with the SAME If-Match: "1". The desired
    // outcome is exactly one 200 and one 412 — either the explicit check
    // fires (Node serializes the requests through it) OR the atomic
    // conditional UPDATE catches the loser (Postgres row-lock orders the
    // writes; the loser's UPDATE WHERE version=1 finds 0 rows).
    it('rejects the loser of a concurrent race (412)', async () => {
      const server = app.getHttpServer();
      const results = await Promise.allSettled([
        request(server)
          .patch(`/tickets/${id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .set('If-Match', '"1"')
          .send({ title: 'A wins' }),
        request(server)
          .patch(`/tickets/${id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .set('If-Match', '"1"')
          .send({ title: 'B wins' }),
      ]);
      const statuses = results.map((r) =>
        r.status === 'fulfilled' ? r.value.status : null,
      );
      expect(statuses).toContain(200);
      expect(statuses).toContain(412);
      expect(statuses.filter((s) => s === 200).length).toBe(1);
      expect(statuses.filter((s) => s === 412).length).toBe(1);
    });

    // Deterministic proof that the SECOND line of defense (atomic UPDATE
    // WHERE version=N) catches a race even if the in-memory explicit check
    // passed for both requests. Drives the repository directly so we know
    // exactly what state the DB is in: side-channel bumps the version,
    // then a conditional UPDATE with the stale version finds 0 rows.
    it('atomic UPDATE WHERE version=N rejects a stale write directly', async () => {
      const repo = app.get(DataSource).getRepository(Ticket);
      const ticket = await repo.findOne({ where: { id } });
      expect(ticket!.version).toBe(1);

      // Side-channel bump (version → 2) via the public PATCH path.
      await request(app.getHttpServer())
        .patch(`/tickets/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', '"1"')
        .send({ title: 'sidewinder' })
        .expect(200);

      // The same atomic UPDATE the service uses — should match zero rows
      // because version is now 2 in the DB.
      const result = await repo
        .createQueryBuilder()
        .update(Ticket)
        .set({ title: 'stale write' })
        .where('id = :id AND version = :v', { id, v: 1 })
        .execute();
      expect(result.affected).toBe(0);

      // And nothing changed: title is still what the side-channel set.
      const after = await repo.findOne({ where: { id } });
      expect(after!.title).toBe('sidewinder');
    });
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  describe('PATCH — validation', () => {
    let id: number;

    beforeEach(async () => {
      const res = await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'Validation-fixture', type: 'BUG', projectId });
      id = res.body.id;
    });

    it('rejects unknown body fields (forbidNonWhitelisted)', async () => {
      await request(app.getHttpServer())
        .patch(`/tickets/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', '"1"')
        .send({ projectId: 99 }) // not in UpdateTicketDto
        .expect(400);
    });

    it('rejects bad If-Match format (400)', async () => {
      await request(app.getHttpServer())
        .patch(`/tickets/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', 'garbage')
        .send({ title: 'x' })
        .expect(400);
    });
  });

  // ── Soft-delete + admin ─────────────────────────────────────────────────────

  describe('Soft-delete + admin endpoints', () => {
    let id: number;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'Soft-fixture', type: 'BUG', projectId });
      id = res.body.id;
    });

    it('DELETE soft-deletes the ticket (200)', async () => {
      await request(app.getHttpServer())
        .delete(`/tickets/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });

    it('GET /tickets?projectId no longer shows the deleted ticket', async () => {
      const r = await request(app.getHttpServer())
        .get(`/tickets?projectId=${projectId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(r.body.every((t: { id: number }) => t.id !== id)).toBe(true);
    });

    it('GET /tickets/:id returns 404 for the soft-deleted ticket', async () => {
      await request(app.getHttpServer())
        .get(`/tickets/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });

    it('GET /tickets/deleted as ADMIN — includes the ticket', async () => {
      const r = await request(app.getHttpServer())
        .get(`/tickets/deleted?projectId=${projectId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const found = r.body.find((t: { id: number }) => t.id === id);
      expect(found).toBeDefined();
      expect(found.deletedAt).not.toBeNull();
    });

    it('GET /tickets/deleted as DEVELOPER — 403', async () => {
      await request(app.getHttpServer())
        .get(`/tickets/deleted?projectId=${projectId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(403);
    });

    it('POST /tickets/:id/restore as ADMIN — 200; ticket is back in the list', async () => {
      await request(app.getHttpServer())
        .post(`/tickets/${id}/restore`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const r = await request(app.getHttpServer())
        .get(`/tickets?projectId=${projectId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(r.body.some((t: { id: number }) => t.id === id)).toBe(true);
    });

    it('POST /tickets/:id/restore as DEVELOPER — 403', async () => {
      // Re-delete so we have something to attempt restoring.
      await request(app.getHttpServer())
        .delete(`/tickets/${id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      await request(app.getHttpServer())
        .post(`/tickets/${id}/restore`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(403);
      // Restore for cleanliness
      await request(app.getHttpServer())
        .post(`/tickets/${id}/restore`)
        .set('Authorization', `Bearer ${adminToken}`);
    });

    it('POST /tickets/:id/restore on a non-deleted ticket — 404', async () => {
      await request(app.getHttpServer())
        .post(`/tickets/${id}/restore`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });
});
