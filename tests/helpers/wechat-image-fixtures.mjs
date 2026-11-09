import {deflateSync} from 'node:zlib';

function chunk(type, content) {
  const name = Buffer.from(type), data = Buffer.concat([name, content]);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(content.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, data, checksum]);
}

// A real, locally generated PNG. No fixtures or test paths need external image downloads.
export function pngFixture(width = 120, height = 120, noise = false) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  let seed = 12345;
  for (let y = 0; y < height; y++) {
    for (let x = 1; x <= width * 3; x++) {
      seed = (1664525 * seed + 1013904223) >>> 0;
      pixels[y * (width * 3 + 1) + x] = noise ? seed >>> 24 : 127;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
