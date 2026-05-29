import {
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

// Optimistic-concurrency If-Match contract shared by Ticket and Comment
// updates. Mirror this header in the ETag response on every read+write so
// clients always have a fresh source.
//
//   missing → 428 Precondition Required (we refuse unversioned writes)
//   bad format → 400
//   stale → 412 (raised by callers after comparing parsed value to current)
//
// Tolerates quoted ("3"), unquoted (3), and weak ETag (W/"3") forms.
export function parseIfMatch(ifMatch: string | undefined): number {
  if (ifMatch === undefined || ifMatch === '') {
    throw new HttpException(
      'If-Match header is required for updates (carry the version you loaded, e.g. If-Match: "3")',
      HttpStatus.PRECONDITION_REQUIRED, // 428
    );
  }
  const normalized = ifMatch.replace(/^W\//, '').replace(/"/g, '').trim();
  const v = Number(normalized);
  if (!Number.isInteger(v) || v < 0) {
    throw new BadRequestException(
      'If-Match must be a non-negative integer (the entity version)',
    );
  }
  return v;
}
