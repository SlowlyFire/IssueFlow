import {
  ClassSerializerInterceptor,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { parse } from 'csv-parse/sync';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
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

describe('CSV export/import (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let adminToken: string;
  let devToken: string;
  let adminId: number;
  let devId: number;
  let projectId: number;

  beforeAll(async () => {
    const mod: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = mod.createNestApplication();
    configureApp(app);
    await app.init();

    ds = app.get(DataSource);
    server = app.getHttpServer();

    await ds.query(
      'TRUNCATE TABLE "ticket_dependencies", "tickets", "projects", "users", "audit_logs" RESTART IDENTITY CASCADE',
    );

    const a = await request(server).post('/users').send({
      username: 'csvadmin',
      email: 'csvadmin@example.com',
      fullName: 'CSV Admin',
      role: 'ADMIN',
      password: 'secret123',
    });
    adminId = a.body.id;

    const d = await request(server).post('/users').send({
      username: 'csvdev',
      email: 'csvdev@example.com',
      fullName: 'CSV Dev',
      role: 'DEVELOPER',
      password: 'secret123',
    });
    devId = d.body.id;

    const al = await request(server)
      .post('/auth/login')
      .send({ username: 'csvadmin', password: 'secret123' });
    adminToken = al.body.accessToken;

    const dl = await request(server)
      .post('/auth/login')
      .send({ username: 'csvdev', password: 'secret123' });
    devToken = dl.body.accessToken;

    const p = await request(server)
      .post('/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'CSV Project', description: 'test', ownerId: adminId });
    projectId = p.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Helper ─────────────────────────────────────────────────────────────────

  async function createTicket(opts: {
    title: string;
    description?: string;
    priority?: string;
    type?: string;
  }) {
    const res = await request(server)
      .post('/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: opts.title,
        description: opts.description,
        type: opts.type ?? 'BUG',
        priority: opts.priority ?? 'MEDIUM',
        projectId,
        assigneeId: devId,
      });
    expect(res.status).toBe(200);
    return res.body as { id: number };
  }

  // ── Export: comma and quote in title roundtrip ─────────────────────────────
  // This is the specific case the spec flagged — the reviewer will probe it.
  it('export: title with embedded comma AND double-quote roundtrips correctly', async () => {
    await ds.query(
      'TRUNCATE TABLE "ticket_dependencies", "tickets", "audit_logs" RESTART IDENTITY CASCADE',
    );

    const tricky = 'Fix "the bug", urgently';
    await createTicket({ title: tricky });

    const res = await request(server)
      .get(`/tickets/export?projectId=${projectId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain(
      `tickets-${projectId}.csv`,
    );

    // Parse the CSV back and verify the title is bit-for-bit identical.
    const rows = parse(res.text, {
      columns: true,
      trim: true,
    }) as Record<string, string>[];

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe(tricky);
  });

  // ── Export: newline in description roundtrip ───────────────────────────────
  it('export: description with embedded newline roundtrips correctly', async () => {
    await ds.query(
      'TRUNCATE TABLE "ticket_dependencies", "tickets", "audit_logs" RESTART IDENTITY CASCADE',
    );

    const multiLine = 'Line one\nLine two\nLine three';
    await createTicket({ title: 'Newline ticket', description: multiLine });

    const res = await request(server)
      .get(`/tickets/export?projectId=${projectId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const rows = parse(res.text, { columns: true }) as Record<string, string>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe(multiLine);
  });

  // ── Export: columns in exact spec order ───────────────────────────────────
  it('export: CSV has exactly the seven required columns in the right order', async () => {
    await ds.query(
      'TRUNCATE TABLE "ticket_dependencies", "tickets", "audit_logs" RESTART IDENTITY CASCADE',
    );
    await createTicket({ title: 'Col order check' });

    const res = await request(server)
      .get(`/tickets/export?projectId=${projectId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    const header = res.text.split('\n')[0].trim();
    expect(header).toBe('id,title,description,status,priority,type,assigneeId');
  });

  // ── Export: 404 for unknown project ───────────────────────────────────────
  it('export: 404 for non-existent project', async () => {
    const res = await request(server)
      .get('/tickets/export?projectId=99999')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  // ── Import roundtrip ───────────────────────────────────────────────────────
  it('import roundtrip: export → import into new project → fields match', async () => {
    await ds.query(
      'TRUNCATE TABLE "ticket_dependencies", "tickets", "audit_logs" RESTART IDENTITY CASCADE',
    );

    // Source tickets
    await createTicket({ title: 'Alpha', description: 'First', priority: 'HIGH', type: 'FEATURE' });
    await createTicket({ title: 'Beta, the sequel', description: 'Has a comma', priority: 'LOW', type: 'BUG' });

    const exportRes = await request(server)
      .get(`/tickets/export?projectId=${projectId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(exportRes.status).toBe(200);

    // New destination project
    const destProj = await request(server)
      .post('/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Import Dest', description: 'dest', ownerId: adminId });
    const destProjId: number = destProj.body.id;

    const importRes = await request(server)
      .post('/tickets/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('projectId', String(destProjId))
      .attach('file', Buffer.from(exportRes.text), {
        contentType: 'text/csv',
        filename: 'export.csv',
      });

    expect(importRes.status).toBe(200);
    expect(importRes.body.created).toBe(2);
    expect(importRes.body.failed).toBe(0);
    expect(importRes.body.errors).toHaveLength(0);

    // Verify the imported tickets match the originals (excluding id, projectId)
    const listRes = await request(server)
      .get(`/tickets?projectId=${destProjId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.body).toHaveLength(2);

    const titles = listRes.body.map((t: { title: string }) => t.title).sort();
    expect(titles).toEqual(['Alpha', 'Beta, the sequel'].sort());

    const alpha = listRes.body.find((t: { title: string }) => t.title === 'Alpha');
    expect(alpha.priority).toBe('HIGH');
    expect(alpha.type).toBe('FEATURE');
    expect(alpha.description).toBe('First');

    const beta = listRes.body.find((t: { title: string }) => t.title === 'Beta, the sequel');
    expect(beta.description).toBe('Has a comma');
  });

  // ── Import: row-level error with 1-indexed row numbers ────────────────────
  it('import: one bad row out of three → created: 2, failed: 1, errors[0].row === 2', async () => {
    // Destination project that we create fresh to avoid id conflicts
    const p2 = await request(server)
      .post('/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Import Err Project', description: 'test', ownerId: adminId });

    const csv = [
      'id,title,description,status,priority,type,assigneeId',
      `1,Good row one,,TODO,LOW,BUG,${devId}`,
      `2,Bad row — invalid priority,,TODO,NOT_A_PRIORITY,BUG,${devId}`,
      `3,Good row three,,TODO,HIGH,FEATURE,${devId}`,
    ].join('\n');

    const res = await request(server)
      .post('/tickets/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('projectId', String(p2.body.id))
      .attach('file', Buffer.from(csv), {
        contentType: 'text/csv',
        filename: 'import.csv',
      });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
    expect(res.body.failed).toBe(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].row).toBe(2);
    expect(res.body.errors[0].error).toMatch(/priority/i);
  });

  // ── Import: DONE status is rejected per row ────────────────────────────────
  it('import: row with status=DONE → that row fails with a clear message', async () => {
    const p3 = await request(server)
      .post('/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Import DONE Project', description: 'test', ownerId: adminId });

    const csv = [
      'id,title,description,status,priority,type,assigneeId',
      `1,Closed ticket,,DONE,LOW,BUG,${devId}`,
    ].join('\n');

    const res = await request(server)
      .post('/tickets/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('projectId', String(p3.body.id))
      .attach('file', Buffer.from(csv), {
        contentType: 'text/csv',
        filename: 'import.csv',
      });

    expect(res.body.failed).toBe(1);
    expect(res.body.errors[0].error).toMatch(/DONE/);
  });

  // ── Import: auto-assignment when assigneeId is absent ─────────────────────
  it('import: row without assigneeId triggers auto-assign to the only DEVELOPER', async () => {
    const p4 = await request(server)
      .post('/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Import AutoAssign Project', description: 'test', ownerId: adminId });

    // No assigneeId column value — the field is left empty.
    const csv = [
      'id,title,description,status,priority,type,assigneeId',
      `1,Auto-assign me,,TODO,MEDIUM,FEATURE,`,
    ].join('\n');

    const res = await request(server)
      .post('/tickets/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('projectId', String(p4.body.id))
      .attach('file', Buffer.from(csv), {
        contentType: 'text/csv',
        filename: 'import.csv',
      });

    expect(res.body.created).toBe(1);

    const list = await request(server)
      .get(`/tickets?projectId=${p4.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    // The only DEVELOPER in the system is devId.
    expect(list.body[0].assigneeId).toBe(devId);
  });

  // ── Import: empty CSV ──────────────────────────────────────────────────────
  it('import: empty CSV (header-only) → created: 0, failed: 0, errors: []', async () => {
    const p5 = await request(server)
      .post('/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Import Empty Project', description: 'test', ownerId: adminId });

    const csv = 'id,title,description,status,priority,type,assigneeId\n';

    const res = await request(server)
      .post('/tickets/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('projectId', String(p5.body.id))
      .attach('file', Buffer.from(csv), {
        contentType: 'text/csv',
        filename: 'empty.csv',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 0, failed: 0, errors: [] });
  });

  // ── Import: non-CSV file rejected ─────────────────────────────────────────
  it('import: PNG file upload is rejected with 400', async () => {
    // A minimal PNG: 8-byte signature so the MIME check fires.
    const pngSignature = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    const res = await request(server)
      .post('/tickets/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('projectId', String(projectId))
      .attach('file', pngSignature, {
        contentType: 'image/png',
        filename: 'photo.png',
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/csv/i);
  });

  // ── Import: 404 for unknown project ───────────────────────────────────────
  it('import: 404 for non-existent project', async () => {
    const csv = 'id,title,description,status,priority,type,assigneeId\n';
    const res = await request(server)
      .post('/tickets/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('projectId', '99999')
      .attach('file', Buffer.from(csv), {
        contentType: 'text/csv',
        filename: 'test.csv',
      });
    expect(res.status).toBe(404);
  });

  // ── Auth gates ─────────────────────────────────────────────────────────────
  it('export: 401 without token', async () => {
    const res = await request(server).get(
      `/tickets/export?projectId=${projectId}`,
    );
    expect(res.status).toBe(401);
  });

  it('import: 401 without token', async () => {
    const csv = 'id,title,description,status,priority,type,assigneeId\n';
    const res = await request(server)
      .post('/tickets/import')
      .field('projectId', String(projectId))
      .attach('file', Buffer.from(csv), {
        contentType: 'text/csv',
        filename: 'test.csv',
      });
    expect(res.status).toBe(401);
  });
});
