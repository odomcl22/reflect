/**
 * A minimal ZIP writer.
 *
 * Word and Excel files are ZIP archives of XML, which is the only thing that
 * stood between Reflect and writing them. Node already has both halves of a
 * ZIP — `deflateRawSync` for the compression and `crc32` for the checksum — so
 * this is a header format rather than an algorithm, and about eighty lines.
 *
 * The alternative was a packaging dependency for a project that has one
 * runtime dependency on purpose. Eighty lines of well-specified header, in a
 * file that will not change again, is the cheaper of the two.
 *
 * Deliberately limited: no directories, no zip64, no encryption. A document is
 * a handful of small entries, and every case beyond that belongs to a library
 * we are not going to need.
 */

import { deflateRawSync, crc32 } from 'node:zlib';

const NO_COMPRESSION = 0;
const DEFLATE = 8;

/**
 * @param {Array<{name: string, data: string|Uint8Array}>} entries
 * @returns {Buffer} the archive
 */
export function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data);
    const deflated = deflateRawSync(raw);
    // Deflate can make small, already-dense data larger. Storing it then is
    // both smaller and faster to read.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? DEFLATE : NO_COMPRESSION;
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    // A fixed timestamp, so the same content produces the same bytes. A file
    // that differs only by when it was written is a file that cannot be
    // compared, and these are documents people will diff.
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk
    dir.writeUInt16LE(0, 36); // internal attrs
    dir.writeUInt32LE(0, 38); // external attrs
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + body.length;
  }

  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBytes.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, dirBytes, end]);
}
