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

describe('Projects — soft-delete lifecycle (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let devToken: string;
  let adminId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    const ds = app.get(DataSource);
    await ds.query('TRUNCATE TABLE "projects" RESTART IDENTITY CASCADE');
    await ds.query('TRUNCATE TABLE "users" RESTART IDENTITY CASCADE');

    const server = app.getHttpServer();

    // Set up one ADMIN and one DEVELOPER
    const adminRes = await request(server)
      .post('/users')
      .send({
        username: 'projadmin',
        email: 'projadmin@example.com',
        fullName: 'Proj Admin',
        role: 'ADMIN',
        password: 'secret123',
      });
    adminId = adminRes.body.id;

    await request(server)
      .post('/users')
      .send({
        username: 'projdev',
        email: 'projdev@example.com',
        fullName: 'Proj Dev',
        role: 'DEVELOPER',
        password: 'secret123',
      });

    adminToken = (
      await request(server)
        .post('/auth/login')
        .send({ username: 'projadmin', password: 'secret123' })
    ).body.accessToken;

    devToken = (
      await request(server)
        .post('/auth/login')
        .send({ username: 'projdev', password: 'secret123' })
    ).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  let projectId: number;

  it('creates a project (200, no deletedAt in response)', async () => {
    const res = await request(app.getHttpServer())
      .post('/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Alpha', description: 'Test', ownerId: adminId })
      .expect(200);
    expect(res.body).toMatchObject({ name: 'Alpha', ownerId: adminId });
    expect(res.body.deletedAt).toBeNull();
    projectId = res.body.id;
  });

  it('rejects ownerId pointing to a non-existent user (404)', async () => {
    await request(app.getHttpServer())
      .post('/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Ghost', ownerId: 99999 })
      .expect(404);
  });

  it('soft-deletes the project (200)', async () => {
    await request(app.getHttpServer())
      .delete(`/projects/${projectId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('GET /projects no longer includes the deleted project', async () => {
    const res = await request(app.getHttpServer())
      .get('/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.every((p: { id: number }) => p.id !== projectId)).toBe(true);
  });

  it('GET /projects/:id returns 404 for the soft-deleted project', async () => {
    await request(app.getHttpServer())
      .get(`/projects/${projectId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('GET /projects/deleted returns the project for ADMIN', async () => {
    const res = await request(app.getHttpServer())
      .get('/projects/deleted')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const found = res.body.find((p: { id: number }) => p.id === projectId);
    expect(found).toBeDefined();
    expect(found.deletedAt).not.toBeNull();
  });

  it('GET /projects/deleted returns 403 for a DEVELOPER', async () => {
    await request(app.getHttpServer())
      .get('/projects/deleted')
      .set('Authorization', `Bearer ${devToken}`)
      .expect(403);
  });

  it('POST /projects/:id/restore (ADMIN) — 200', async () => {
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/restore`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('project is visible in GET /projects again after restore', async () => {
    const res = await request(app.getHttpServer())
      .get('/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.some((p: { id: number }) => p.id === projectId)).toBe(true);
  });

  it('POST /projects/:id/restore returns 403 for a DEVELOPER', async () => {
    // Soft-delete again so restore has something to act on
    await request(app.getHttpServer())
      .delete(`/projects/${projectId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    await request(app.getHttpServer())
      .post(`/projects/${projectId}/restore`)
      .set('Authorization', `Bearer ${devToken}`)
      .expect(403);
  });

  it('POST /projects/:id/restore returns 401 with no token', async () => {
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/restore`)
      .expect(401);
  });

  it('PATCH /projects/:id updates name and description', async () => {
    // Restore first so we have a live project
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/restore`)
      .set('Authorization', `Bearer ${adminToken}`);

    await request(app.getHttpServer())
      .patch(`/projects/${projectId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Alpha v2', description: 'Updated' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/projects/${projectId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.name).toBe('Alpha v2');
    expect(res.body.description).toBe('Updated');
  });
});
