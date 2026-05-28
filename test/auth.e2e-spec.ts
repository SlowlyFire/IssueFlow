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

// Mirrors main.ts: any global setup that lives there must also be applied
// to the e2e Nest app, otherwise the test environment behaves subtly
// different from production.
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

describe('Auth flow (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    // Start each run from a clean users table so the test is deterministic
    // even when run repeatedly against the same dev DB.
    const dataSource = app.get(DataSource);
    await dataSource.query('TRUNCATE TABLE "users" RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await app.close();
  });

  it('register → login → /auth/me → logout → reused token rejected', async () => {
    const server = app.getHttpServer();

    // 1. Register
    const registerRes = await request(server)
      .post('/users')
      .send({
        username: 'e2euser',
        email: 'e2e@example.com',
        fullName: 'E2E User',
        role: 'DEVELOPER',
        password: 'secret123',
      })
      .expect(200);

    expect(registerRes.body).toMatchObject({
      id: expect.any(Number),
      username: 'e2euser',
      email: 'e2e@example.com',
      fullName: 'E2E User',
      role: 'DEVELOPER',
    });
    // The contract: passwordHash must never appear in any response.
    expect(registerRes.body).not.toHaveProperty('passwordHash');

    // 2. Login
    const loginRes = await request(server)
      .post('/auth/login')
      .send({ username: 'e2euser', password: 'secret123' })
      .expect(200);

    expect(loginRes.body).toMatchObject({
      accessToken: expect.any(String),
      tokenType: 'Bearer',
      expiresIn: expect.any(Number),
    });
    const token = loginRes.body.accessToken;

    // 3. /auth/me with the token → 200, profile, no passwordHash
    const meRes = await request(server)
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(meRes.body).toMatchObject({
      username: 'e2euser',
      email: 'e2e@example.com',
    });
    expect(meRes.body).not.toHaveProperty('passwordHash');

    // 4. /auth/me with no token → 401
    await request(server).get('/auth/me').expect(401);

    // 5. Logout → 200
    await request(server)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // 6. Reuse the now-revoked token → 401 with deny-list message
    const reusedRes = await request(server)
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(reusedRes.body.message).toMatch(/revoked/i);
  });

  it('rejects wrong password and missing username with the same 401 message', async () => {
    const server = app.getHttpServer();

    const wrongPw = await request(server)
      .post('/auth/login')
      .send({ username: 'e2euser', password: 'NOPE' })
      .expect(401);

    const missingUser = await request(server)
      .post('/auth/login')
      .send({ username: 'does-not-exist', password: 'NOPE' })
      .expect(401);

    expect(wrongPw.body.message).toBe(missingUser.body.message);
  });

  it('rejects duplicate username with 409', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .send({
        username: 'e2euser',
        email: 'different@example.com',
        fullName: 'Dup',
        role: 'DEVELOPER',
        password: 'secret123',
      })
      .expect(409);
  });

  it('forbids unknown fields on registration (forbidNonWhitelisted)', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .send({
        username: 'unique1',
        email: 'unique1@example.com',
        fullName: 'U',
        role: 'DEVELOPER',
        password: 'secret123',
        isAdmin: true,
      })
      .expect(400);
  });
});
