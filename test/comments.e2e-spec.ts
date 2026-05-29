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
import { Mention } from './../src/comments/mention.entity';
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

describe('Comments + mentions + diffing (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let adminId: number;
  let aliceId: number;
  let bobId: number;
  let charlieId: number;
  let projectId: number;
  let ticketId: number;
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
      'TRUNCATE TABLE "mentions", "comments", "ticket_dependencies", "tickets", "projects", "users", "audit_logs" RESTART IDENTITY CASCADE',
    );

    const server = app.getHttpServer();

    const a = await request(server).post('/users').send({
      username: 'cadmin',
      email: 'cadmin@example.com',
      fullName: 'C Admin',
      role: 'ADMIN',
      password: 'secret123',
    });
    adminId = a.body.id;
    aliceId = (
      await request(server).post('/users').send({
        username: 'alice',
        email: 'alice@example.com',
        fullName: 'Alice',
        role: 'DEVELOPER',
        password: 'secret123',
      })
    ).body.id;
    bobId = (
      await request(server).post('/users').send({
        username: 'bob',
        email: 'bob@example.com',
        fullName: 'Bob',
        role: 'DEVELOPER',
        password: 'secret123',
      })
    ).body.id;
    charlieId = (
      await request(server).post('/users').send({
        username: 'charlie',
        email: 'charlie@example.com',
        fullName: 'Charlie',
        role: 'DEVELOPER',
        password: 'secret123',
      })
    ).body.id;

    adminToken = (
      await request(server)
        .post('/auth/login')
        .send({ username: 'cadmin', password: 'secret123' })
    ).body.accessToken;

    projectId = (
      await request(server)
        .post('/projects')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'CommentsProj', ownerId: adminId })
    ).body.id;

    ticketId = (
      await request(server)
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'CommentsTicket',
          type: 'BUG',
          projectId,
          assigneeId: adminId,
        })
    ).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const mentionsRepo = () => ds.getRepository(Mention);
  const auditRepo = () => ds.getRepository(AuditLog);

  // ── Create + embedded mentions ──────────────────────────────────────────

  describe('POST /tickets/:ticketId/comments', () => {
    it('creates a comment with mentions; mentionedUsers embedded; ETag set', async () => {
      const r = await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          authorId: adminId,
          content: 'Hi @alice and @bob — go!',
        })
        .expect(200);
      expect(r.headers.etag).toBe('"1"');
      expect(r.body.version).toBe(1);
      const usernames = r.body.mentionedUsers
        .map((u: { username: string }) => u.username)
        .sort();
      expect(usernames).toEqual(['alice', 'bob']);
      r.body.mentionedUsers.forEach(
        (u: { id: number; username: string; fullName: string }) => {
          expect(u).toEqual({
            id: expect.any(Number),
            username: expect.any(String),
            fullName: expect.any(String),
          });
        },
      );
    });

    it('unknown @names are silently ignored (no error)', async () => {
      const r = await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          authorId: adminId,
          content: 'cc @ghost @phantom @alice',
        })
        .expect(200);
      const usernames = r.body.mentionedUsers.map(
        (u: { username: string }) => u.username,
      );
      expect(usernames).toEqual(['alice']);
    });

    it('case-insensitive: @ALICE resolves to alice', async () => {
      const r = await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ authorId: adminId, content: 'shouting @ALICE' })
        .expect(200);
      expect(r.body.mentionedUsers).toHaveLength(1);
      expect(r.body.mentionedUsers[0].username).toBe('alice');
    });

    it('rejects unknown authorId (404)', async () => {
      await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ authorId: 99999, content: 'hi' })
        .expect(404);
    });

    it('rejects unknown ticketId (404)', async () => {
      await request(app.getHttpServer())
        .post(`/tickets/99999/comments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ authorId: adminId, content: 'hi' })
        .expect(404);
    });

    it('rejects forbidden body fields (forbidNonWhitelisted)', async () => {
      await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ authorId: adminId, content: 'hi', isSecret: true })
        .expect(400);
    });
  });

  // ── List ───────────────────────────────────────────────────────────────

  describe('GET /tickets/:ticketId/comments', () => {
    it('returns comments newest first with mentionedUsers on each', async () => {
      const r = await request(app.getHttpServer())
        .get(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(r.body.length).toBeGreaterThanOrEqual(2);
      // newest first
      for (let i = 1; i < r.body.length; i++) {
        const prev = new Date(r.body[i - 1].createdAt).getTime();
        const cur = new Date(r.body[i].createdAt).getTime();
        expect(prev).toBeGreaterThanOrEqual(cur);
      }
      // every comment has the mentionedUsers shape
      for (const c of r.body) {
        expect(Array.isArray(c.mentionedUsers)).toBe(true);
      }
    });
  });

  // ── Diff: THE central test ─────────────────────────────────────────────

  describe('PATCH — mention diff preserves PKs', () => {
    it('PATCH @alice@bob → @bob@charlie: 1 insert (charlie), 1 delete (alice), bob keeps same PK', async () => {
      // Fresh subject comment so we can pin PK comparisons.
      const c = (
        await request(app.getHttpServer())
          .post(`/tickets/${ticketId}/comments`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ authorId: adminId, content: 'Hi @alice @bob' })
      ).body;
      expect(
        c.mentionedUsers
          .map((u: { username: string }) => u.username)
          .sort(),
      ).toEqual(['alice', 'bob']);

      // Snapshot bob's mention-row PK BEFORE the patch.
      const bobBefore = await mentionsRepo().findOne({
        where: { commentId: c.id, mentionedUserId: bobId },
      });
      expect(bobBefore).not.toBeNull();

      // Snapshot alice's PK too — we'll check it's gone.
      const aliceBefore = await mentionsRepo().findOne({
        where: { commentId: c.id, mentionedUserId: aliceId },
      });
      expect(aliceBefore).not.toBeNull();

      const patched = await request(app.getHttpServer())
        .patch(`/tickets/${ticketId}/comments/${c.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', '"1"')
        .send({ content: 'Now @bob @charlie' })
        .expect(200);

      // Returned body shows the new mention set.
      const after = patched.body.mentionedUsers
        .map((u: { username: string }) => u.username)
        .sort();
      expect(after).toEqual(['bob', 'charlie']);

      // The CRITICAL claim: bob's row PK is unchanged.
      const bobAfter = await mentionsRepo().findOne({
        where: { commentId: c.id, mentionedUserId: bobId },
      });
      expect(bobAfter).not.toBeNull();
      expect(bobAfter!.id).toBe(bobBefore!.id);

      // Alice's row is gone.
      const aliceAfter = await mentionsRepo().findOne({
        where: { commentId: c.id, mentionedUserId: aliceId },
      });
      expect(aliceAfter).toBeNull();

      // Charlie's row exists and is new.
      const charlieAfter = await mentionsRepo().findOne({
        where: { commentId: c.id, mentionedUserId: charlieId },
      });
      expect(charlieAfter).not.toBeNull();
      expect(charlieAfter!.id).not.toBe(bobBefore!.id);
      expect(charlieAfter!.id).not.toBe(aliceBefore!.id);

      // Total mention count for the comment is exactly 2.
      const all = await mentionsRepo().find({ where: { commentId: c.id } });
      expect(all.length).toBe(2);
    });

    it('PATCH that swaps mention order but keeps the set → no diff, PKs untouched', async () => {
      const c = (
        await request(app.getHttpServer())
          .post(`/tickets/${ticketId}/comments`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ authorId: adminId, content: '@alice @bob' })
      ).body;
      const beforeAll = await mentionsRepo().find({
        where: { commentId: c.id },
      });
      const beforePks = new Set(beforeAll.map((m) => m.id));

      await request(app.getHttpServer())
        .patch(`/tickets/${ticketId}/comments/${c.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', '"1"')
        .send({ content: '@bob @alice (just swapped order)' })
        .expect(200);

      const afterAll = await mentionsRepo().find({
        where: { commentId: c.id },
      });
      expect(afterAll.length).toBe(beforeAll.length);
      const afterPks = new Set(afterAll.map((m) => m.id));
      expect(afterPks).toEqual(beforePks);
    });

    it('PATCH audit row carries the mentionDiff in afterJson', async () => {
      const c = (
        await request(app.getHttpServer())
          .post(`/tickets/${ticketId}/comments`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ authorId: adminId, content: 'Hi @alice' })
      ).body;
      // Wipe audit so the only COMMENT_UPDATE row is the next one.
      await ds.query('TRUNCATE TABLE "audit_logs" RESTART IDENTITY CASCADE');

      await request(app.getHttpServer())
        .patch(`/tickets/${ticketId}/comments/${c.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', '"1"')
        .send({ content: 'Now @bob' })
        .expect(200);

      const logs = await auditRepo().find({
        where: { action: 'COMMENT_UPDATE', entityId: c.id },
      });
      expect(logs.length).toBe(1);
      const after = logs[0].afterJson as {
        mentionDiff: { added: number[]; removed: number[]; unchanged: number[] };
      };
      expect(after.mentionDiff.added).toEqual([bobId]);
      expect(after.mentionDiff.removed).toEqual([aliceId]);
      expect(after.mentionDiff.unchanged).toEqual([]);
    });
  });

  // ── If-Match contract ────────────────────────────────────────────────────

  describe('PATCH — If-Match contract', () => {
    let cid: number;

    beforeAll(async () => {
      cid = (
        await request(app.getHttpServer())
          .post(`/tickets/${ticketId}/comments`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ authorId: adminId, content: 'lock-fixture' })
      ).body.id;
    });

    it('missing If-Match → 428', async () => {
      await request(app.getHttpServer())
        .patch(`/tickets/${ticketId}/comments/${cid}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ content: 'x' })
        .expect(428);
    });

    it('stale If-Match → 412', async () => {
      await request(app.getHttpServer())
        .patch(`/tickets/${ticketId}/comments/${cid}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', '"999"')
        .send({ content: 'x' })
        .expect(412);
    });

    it('correct If-Match → 200, version bumps, new ETag', async () => {
      const r = await request(app.getHttpServer())
        .patch(`/tickets/${ticketId}/comments/${cid}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('If-Match', '"1"')
        .send({ content: 'x' })
        .expect(200);
      expect(r.body.version).toBe(2);
      expect(r.headers.etag).toBe('"2"');
    });
  });

  // ── DELETE ──────────────────────────────────────────────────────────────

  describe('DELETE /tickets/:ticketId/comments/:commentId', () => {
    it('removes the comment and its mentions in one go', async () => {
      const c = (
        await request(app.getHttpServer())
          .post(`/tickets/${ticketId}/comments`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ authorId: adminId, content: '@alice doomed' })
      ).body;
      // Mention row exists
      expect(
        await mentionsRepo().count({ where: { commentId: c.id } }),
      ).toBe(1);

      await request(app.getHttpServer())
        .delete(`/tickets/${ticketId}/comments/${c.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // Comment row is gone
      await request(app.getHttpServer())
        .get(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
        .then((r) =>
          expect(r.body.some((cc: { id: number }) => cc.id === c.id)).toBe(
            false,
          ),
        );
      // Mention rows are also gone (orphan cleanup happened in same txn).
      expect(
        await mentionsRepo().count({ where: { commentId: c.id } }),
      ).toBe(0);
    });
  });

  // ── GET /users/:userId/mentions ─────────────────────────────────────────

  describe('GET /users/:userId/mentions', () => {
    let bobCommentIds: number[];

    beforeAll(async () => {
      // Wipe all comments to keep numbers tight for pagination assertions.
      await ds.query(
        'TRUNCATE TABLE "mentions", "comments" RESTART IDENTITY CASCADE',
      );
      bobCommentIds = [];
      for (let i = 0; i < 3; i++) {
        const c = await request(app.getHttpServer())
          .post(`/tickets/${ticketId}/comments`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ authorId: adminId, content: `cc @bob round ${i}` });
        bobCommentIds.push(c.body.id);
        // Tiny delay to make createdAt orderings deterministic
        await new Promise((r) => setTimeout(r, 10));
      }
      // One comment that does NOT mention bob, to confirm filtering.
      await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ authorId: adminId, content: 'cc @alice only' });
    });

    it('returns only comments mentioning the user, newest first', async () => {
      const r = await request(app.getHttpServer())
        .get(`/users/${bobId}/mentions`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(r.body.total).toBe(3);
      expect(r.body.page).toBe(1);
      expect(r.body.data.length).toBe(3);
      // Newest first → reverse of insertion order
      expect(r.body.data.map((c: { id: number }) => c.id)).toEqual(
        [...bobCommentIds].reverse(),
      );
      // Each carries its full mentionedUsers array.
      for (const c of r.body.data) {
        expect(Array.isArray(c.mentionedUsers)).toBe(true);
        expect(
          c.mentionedUsers.some(
            (u: { id: number }) => u.id === bobId,
          ),
        ).toBe(true);
      }
    });

    it('paginates: page=1 pageSize=2 → 2 items, total=3', async () => {
      const r = await request(app.getHttpServer())
        .get(`/users/${bobId}/mentions?page=1&pageSize=2`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(r.body.total).toBe(3);
      expect(r.body.page).toBe(1);
      expect(r.body.data.length).toBe(2);
    });

    it('paginates: page=2 pageSize=2 → 1 remaining item', async () => {
      const r = await request(app.getHttpServer())
        .get(`/users/${bobId}/mentions?page=2&pageSize=2`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(r.body.data.length).toBe(1);
      expect(r.body.page).toBe(2);
    });

    it('user with zero mentions returns total=0, data=[]', async () => {
      const r = await request(app.getHttpServer())
        .get(`/users/${charlieId}/mentions`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(r.body).toMatchObject({ total: 0, data: [], page: 1 });
    });

    it('unknown userId → 404', async () => {
      await request(app.getHttpServer())
        .get(`/users/99999/mentions`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });
});
