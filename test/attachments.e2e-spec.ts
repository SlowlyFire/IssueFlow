import {
  ClassSerializerInterceptor,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as struct from 'buffer';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { AuditLog } from './../src/audit/audit-log.entity';
import { AllExceptionsFilter } from './../src/common/all-exceptions.filter';

void struct; // just to import buffer polyfill for tests

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

// ── Minimal real file buffers ────────────────────────────────────────────

/** Builds a minimal valid 1x1 PNG. */
function makePng(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const mkChunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.concat([t, data]);
    const crc = Buffer.allocUnsafe(4);
    crc.writeUInt32BE(crc32(crcBuf), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdrData = Buffer.allocUnsafe(13);
  ihdrData.writeUInt32BE(1, 0);  // width 1
  ihdrData.writeUInt32BE(1, 4);  // height 1
  ihdrData[8] = 8; ihdrData[9] = 2; ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;
  const raw = Buffer.from([0x00, 0xff, 0x00, 0x00]); // filter + RGB
  const compressed = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    mkChunk('IHDR', ihdrData),
    mkChunk('IDAT', compressed),
    mkChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Minimal valid 1x1 JPEG (actual FF D8 FF bytes). */
function makeJpeg(): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xdb, 0x00, 0x43, 0x00,
    ...Array(64).fill(0x10),
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
    0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xf4, 0xa8, 0x28,
    0xff, 0xd9,
  ]);
}

/** Minimal PDF. */
function makePdf(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'ascii');
}

/** Valid UTF-8 plain text. */
function makePlainText(): Buffer {
  return Buffer.from('Hello, this is plain text. No NUL bytes here.\n', 'utf-8');
}

// Minimal CRC-32 implementation for PNG chunk building
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('Attachments — upload, validate, download, delete (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let adminId: number;
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
      'TRUNCATE TABLE "attachments", "ticket_dependencies", "tickets", "projects", "users", "audit_logs" RESTART IDENTITY CASCADE',
    );
    const server = app.getHttpServer();
    const a = await request(server).post('/users').send({
      username: 'attadmin',
      email: 'attadmin@example.com',
      fullName: 'Att Admin',
      role: 'ADMIN',
      password: 'secret123',
    });
    adminId = a.body.id;
    adminToken = (
      await request(server)
        .post('/auth/login')
        .send({ username: 'attadmin', password: 'secret123' })
    ).body.accessToken;
    const p = await request(server)
      .post('/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'AttProj', ownerId: adminId });
    ticketId = (
      await request(server)
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'AttTicket',
          type: 'BUG',
          projectId: p.body.id,
          assigneeId: adminId,
        })
    ).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Valid uploads ──────────────────────────────────────────────────────

  describe('valid file uploads', () => {
    it('uploads a PNG; row has correct fields; storagePath has no traversal', async () => {
      const buf = makePng();
      const r = await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/attachments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('file', buf, { filename: 'photo.png', contentType: 'image/png' })
        .expect(200);
      expect(r.body).toMatchObject({
        id: expect.any(Number),
        ticketId,
        filename: 'photo.png',
        mimeType: 'image/png',
        uploadedById: adminId,
      });
      expect(r.body.storagePath).not.toContain('..');
      expect(r.body.storagePath).not.toContain('photo.png');
      // File must actually exist on disk.
      expect(fs.existsSync(r.body.storagePath)).toBe(true);
    });

    it('uploads a JPEG', async () => {
      const r = await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/attachments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('file', makeJpeg(), {
          filename: 'pic.jpg',
          contentType: 'image/jpeg',
        })
        .expect(200);
      expect(r.body.mimeType).toBe('image/jpeg');
    });

    it('uploads a PDF', async () => {
      const r = await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/attachments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('file', makePdf(), {
          filename: 'doc.pdf',
          contentType: 'application/pdf',
        })
        .expect(200);
      expect(r.body.mimeType).toBe('application/pdf');
    });

    it('uploads a text/plain file', async () => {
      const r = await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/attachments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('file', makePlainText(), {
          filename: 'notes.txt',
          contentType: 'text/plain',
        })
        .expect(200);
      expect(r.body.mimeType).toBe('text/plain');
    });

    it('path traversal: user-supplied filename is stored as display name only; storagePath is always a server-generated UUID', async () => {
      // Note: Supertest's .attach() strips path components before sending
      // (path.basename behaviour in form-data), so the server receives the
      // basename only. The real protection is on the server side: regardless
      // of what filename arrives, we use randomUUID() for the storagePath
      // and only put the original in the filename column. This test pins
      // that the storagePath is UUID-based and doesn't echo the user name.
      const r = await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/attachments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('file', makePlainText(), {
          filename: 'passwd',
          contentType: 'text/plain',
        })
        .expect(200);
      // filename column records what the user sent (display name only).
      expect(r.body.filename).toBe('passwd');
      // Storage path must NOT contain the user-supplied name — it uses a UUID.
      expect(r.body.storagePath).not.toContain('passwd');
      expect(r.body.storagePath).not.toContain('..');
      // Must be inside the uploads directory.
      expect(r.body.storagePath).toContain(path.sep + 'uploads' + path.sep);
    });
  });

  // ── Rejection cases ────────────────────────────────────────────────────

  describe('file validation rejections', () => {
    it('rejects a file > 10 MB', async () => {
      // 11 MB buffer of zeros — will be rejected before magic-number check
      const big = Buffer.alloc(11 * 1024 * 1024 + 1);
      // multer rejects before the data reaches our service, returning 413
      const r = await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/attachments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('file', big, {
          filename: 'big.bin',
          contentType: 'text/plain',
        });
      expect([400, 413]).toContain(r.status);
      expect(
        typeof r.body.message === 'string'
          ? r.body.message.toLowerCase()
          : '',
      ).toMatch(/size|large|limit/i);
    });

    it('rejects disallowed MIME type (application/javascript)', async () => {
      const r = await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/attachments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('file', Buffer.from('alert(1)'), {
          filename: 'script.js',
          contentType: 'application/javascript',
        })
        .expect(400);
      expect(r.body.message).toMatch(/not allowed/i);
    });

    it('rejects magic-number mismatch: PNG declared but bytes are not PNG', async () => {
      // First two bytes 'MZ' are the DOS/PE executable signature.
      const fake = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(20)]);
      const r = await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/attachments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('file', fake, {
          filename: 'fake.png',
          contentType: 'image/png',
        })
        .expect(400);
      expect(r.body.message).toMatch(/do not match/i);
    });

    it('rejects magic-number mismatch: JPEG declared but bytes are PNG', async () => {
      const r = await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/attachments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('file', makePng(), {
          filename: 'lie.jpg',
          contentType: 'image/jpeg',
        })
        .expect(400);
      expect(r.body.message).toMatch(/do not match/i);
    });

    it('rejects a non-existent ticket (404)', async () => {
      await request(app.getHttpServer())
        .post('/tickets/99999/attachments')
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('file', makePng(), {
          filename: 'x.png',
          contentType: 'image/png',
        })
        .expect(404);
    });
  });

  // ── Download ──────────────────────────────────────────────────────────

  describe('download', () => {
    let attId: number;
    const pngBuf = makePng();

    beforeAll(async () => {
      const r = await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/attachments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('file', pngBuf, {
          filename: 'download-me.png',
          contentType: 'image/png',
        });
      attId = r.body.id;
    });

    it('returns original bytes, correct Content-Type, correct Content-Disposition', async () => {
      const r = await request(app.getHttpServer())
        .get(`/tickets/${ticketId}/attachments/${attId}/download`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(r.headers['content-type']).toMatch(/image\/png/);
      expect(r.headers['content-disposition']).toMatch(
        /attachment; filename="download-me\.png"/,
      );
      // Bytes must match exactly.
      expect(Buffer.from(r.body).equals(pngBuf) || r.body.equals(pngBuf)).toBe(
        true,
      );
    });
  });

  // ── Delete ─────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('DELETE removes the row AND the file from disk; second DELETE is 404', async () => {
      const r = await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/attachments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('file', makePlainText(), {
          filename: 'todelete.txt',
          contentType: 'text/plain',
        })
        .expect(200);
      const attId = r.body.id;
      const storagePath = r.body.storagePath;

      expect(fs.existsSync(storagePath)).toBe(true);

      await request(app.getHttpServer())
        .delete(`/tickets/${ticketId}/attachments/${attId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(fs.existsSync(storagePath)).toBe(false);

      // Row is gone too: second DELETE should 404
      await request(app.getHttpServer())
        .delete(`/tickets/${ticketId}/attachments/${attId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });

    it('DELETE writes an ATTACHMENT_DELETE audit row', async () => {
      const r = await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/attachments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('file', makePlainText(), {
          filename: 'audit-del.txt',
          contentType: 'text/plain',
        });
      const attId = r.body.id;
      await ds.query('TRUNCATE TABLE "audit_logs" RESTART IDENTITY CASCADE');

      await request(app.getHttpServer())
        .delete(`/tickets/${ticketId}/attachments/${attId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const logs = await ds
        .getRepository(AuditLog)
        .find({ where: { action: 'ATTACHMENT_DELETE', entityId: attId } });
      expect(logs.length).toBe(1);
      expect(logs[0]).toMatchObject({
        actorType: 'USER',
        actorId: adminId,
        entityType: 'Attachment',
        entityId: attId,
      });
      expect(logs[0].beforeJson).not.toBeNull();
      expect(logs[0].afterJson).toBeNull();
    });
  });

  // ── Audit row on upload ────────────────────────────────────────────────

  describe('audit on upload', () => {
    it('ATTACHMENT_UPLOAD audit row is written with correct shape', async () => {
      await ds.query('TRUNCATE TABLE "audit_logs" RESTART IDENTITY CASCADE');
      const r = await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/attachments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('file', makePng(), {
          filename: 'audit-upload.png',
          contentType: 'image/png',
        })
        .expect(200);
      const attId = r.body.id;
      const logs = await ds
        .getRepository(AuditLog)
        .find({ where: { action: 'ATTACHMENT_UPLOAD', entityId: attId } });
      expect(logs.length).toBe(1);
      expect(logs[0]).toMatchObject({
        actorType: 'USER',
        actorId: adminId,
        entityType: 'Attachment',
      });
      expect((logs[0].afterJson as { filename: string }).filename).toBe(
        'audit-upload.png',
      );
    });
  });

  // ── List ──────────────────────────────────────────────────────────────

  describe('GET /tickets/:ticketId/attachments', () => {
    it('returns all attachments for the ticket', async () => {
      const r = await request(app.getHttpServer())
        .get(`/tickets/${ticketId}/attachments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body.length).toBeGreaterThan(0);
      expect(r.body[0]).toHaveProperty('id');
      expect(r.body[0]).toHaveProperty('filename');
      expect(r.body[0]).toHaveProperty('mimeType');
    });

    it('non-existent ticket → 404', async () => {
      await request(app.getHttpServer())
        .get('/tickets/99999/attachments')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });
});
