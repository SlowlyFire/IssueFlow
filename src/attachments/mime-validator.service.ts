import { BadRequestException, Injectable } from '@nestjs/common';

// We never trust the client-supplied Content-Type (the MIME field in the
// multipart header). A malicious user can trivially set Content-Type:
// image/png while uploading an executable. We check the actual bytes.
//
// Magic-number table:
//   PNG   89 50 4E 47 0D 0A 1A 0A  (8 bytes)
//   JPEG  FF D8 FF               (3 bytes)
//   PDF   25 50 44 46            ('%PDF')
//   text/plain — no universal magic number. We declare a buffer to be
//     text/plain if it:
//       (a) contains no NUL bytes (NUL signals binary data in almost
//           all text editors and Unix tools), AND
//       (b) decodes as valid UTF-8 from start to finish.
//     This covers ASCII and UTF-8 encoded text. Non-UTF-8 encodings
//     (Latin-1, Shift-JIS) will be rejected — acceptable for this scope.

export const ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'application/pdf',
  'text/plain',
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

@Injectable()
export class MimeValidatorService {
  /**
   * Validates both that the claimed MIME is in the allowlist AND that the
   * actual file bytes match. Throws BadRequestException on any failure.
   */
  validate(buffer: Buffer, claimedMime: string): AllowedMimeType {
    const allowed = ALLOWED_MIME_TYPES as readonly string[];
    if (!allowed.includes(claimedMime)) {
      throw new BadRequestException(
        `MIME type "${claimedMime}" is not allowed. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`,
      );
    }
    const actual = this.detect(buffer);
    if (actual !== claimedMime) {
      throw new BadRequestException(
        `File contents do not match the declared type (declared: ${claimedMime}, detected: ${actual ?? 'unknown'})`,
      );
    }
    return actual as AllowedMimeType;
  }

  // Detects MIME from magic bytes. Returns null if the buffer matches no
  // known type. Used internally and also exposed for tests.
  detect(buffer: Buffer): string | null {
    if (buffer.length === 0) return null;

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return 'image/png';
    }

    // JPEG: FF D8 FF
    if (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    ) {
      return 'image/jpeg';
    }

    // PDF: 25 50 44 46 ('%PDF')
    if (
      buffer.length >= 4 &&
      buffer[0] === 0x25 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x44 &&
      buffer[3] === 0x46
    ) {
      return 'application/pdf';
    }

    // text/plain: no NUL bytes + valid UTF-8
    if (this.isPlainText(buffer)) {
      return 'text/plain';
    }

    return null;
  }

  private isPlainText(buffer: Buffer): boolean {
    // NUL byte anywhere → binary, not plain text.
    if (buffer.includes(0x00)) return false;
    try {
      // TextDecoder throws on invalid UTF-8 sequences.
      const decoder = new TextDecoder('utf-8', { fatal: true });
      decoder.decode(buffer);
      return true;
    } catch {
      return false;
    }
  }
}
