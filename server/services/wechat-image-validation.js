// Check complete file structure and the stored byte/dimension threshold. This is not pixel decoding
// or proof of a CDN's highest resolution. Unsupported or visibly truncated containers are rejected.
export const WECHAT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const dimensions = (width, height) => width > 0 && height > 0 ? {width, height} : null;

function pngDimensions(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  let offset = 8, size = null, imageBytes = 0;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.subarray(offset + 4, offset + 8).toString();
    const end = offset + 12 + length;
    if (end > bytes.length) return null;
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) return null;
      size = dimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12));
    } else if (type === 'IHDR') return null;
    if (type === 'IDAT') imageBytes += length;
    if (type === 'IEND') return length === 0 && end === bytes.length && imageBytes > 0 ? size : null;
    offset = end;
  }
  return null;
}

function jpegDimensions(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2, size = null, scans = 0, imageBytes = 0;
  while (offset + 2 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) return offset === bytes.length && scans > 0 && imageBytes > 0 ? size : null;
    if (marker === 0x01) continue;
    if (marker === undefined || marker === 0 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7 || offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset), end = offset + length;
    if (length < 2 || end > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8 || bytes[offset + 7] < 1 || length !== 8 + 3 * bytes[offset + 7]) return null;
      size = dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    if (marker === 0xda) {
      if (!size || length < 6 || bytes[offset + 2] < 1 || length !== 6 + 2 * bytes[offset + 2]) return null;
      scans++; offset = end;
      // Entropy bytes escape FF as FF00; restart markers do not finish the scan. A later marker can
      // begin another progressive scan, and only a final EOI completes the whole JPEG.
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { imageBytes++; offset++; continue; }
        if (bytes[offset + 1] === 0 || bytes[offset + 1] >= 0xd0 && bytes[offset + 1] <= 0xd7) { imageBytes++; offset += 2; continue; }
        break;
      }
    } else offset = end;
  }
  return null;
}

function gifDimensions(bytes) {
  if (bytes.length < 14 || !/^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString())) return null;
  const size = dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  let offset = 13 + (bytes[10] & 0x80 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0), frames = 0;
  const blocks = () => {
    let count = 0;
    while (offset < bytes.length) {
      const length = bytes[offset++];
      if (length === 0) return count;
      if (offset + length > bytes.length) return -1;
      count += length; offset += length;
    }
    return -1;
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) return frames > 0 && offset === bytes.length ? size : null;
    if (marker === 0x21) { if (offset >= bytes.length) return null; offset++; if (blocks() < 0) return null; }
    else if (marker === 0x2c) {
      if (offset + 9 > bytes.length || !dimensions(bytes.readUInt16LE(offset + 4), bytes.readUInt16LE(offset + 6))) return null;
      const flags = bytes[offset + 8]; offset += 9 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
      if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) return null;
      offset++; if (blocks() <= 0) return null; frames++;
    } else return null;
  }
  return null;
}

function bmpDimensions(bytes) {
  if (bytes.length < 26 || bytes.subarray(0, 2).toString() !== 'BM' || bytes.readUInt32LE(2) !== bytes.length) return null;
  const header = bytes.readUInt32LE(14), pixelStart = bytes.readUInt32LE(10);
  if (![12, 40, 52, 56, 108, 124].includes(header) || 14 + header > bytes.length || pixelStart < 14 + header) return null;
  const core = header === 12, width = core ? bytes.readUInt16LE(18) : bytes.readInt32LE(18);
  const height = core ? bytes.readUInt16LE(20) : Math.abs(bytes.readInt32LE(22));
  const planes = bytes.readUInt16LE(core ? 22 : 26), bits = bytes.readUInt16LE(core ? 24 : 28);
  // RGB/bitfield BMP only; RLE and embedded JPEG/PNG BMP variants remain unsupported.
  const compression = core ? 0 : bytes.readUInt32LE(30);
  if (!dimensions(width, height) || planes !== 1 || ![1, 4, 8, 16, 24, 32].includes(bits)
    || ![0, 3, 6].includes(compression) || compression !== 0 && ![16, 32].includes(bits)) return null;
  const masks = header === 40 && compression !== 0 ? compression === 6 ? 16 : 12 : 0;
  const palette = bits <= 8 ? (core ? 2 ** bits : bytes.readUInt32LE(46) || 2 ** bits) * (core ? 3 : 4) : 0;
  if (pixelStart < 14 + header + masks + palette || pixelStart + Math.ceil(width * bits / 32) * 4 * height > bytes.length) return null;
  return {width, height};
}

function webpChunks(bytes, start = 0) {
  const chunks = []; let offset = start;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset + 4), end = offset + 8 + length;
    if (end + (length & 1) > bytes.length) return null;
    chunks.push({type: bytes.subarray(offset, offset + 4).toString(), data: bytes.subarray(offset + 8, end)});
    offset = end + (length & 1);
  }
  return offset === bytes.length ? chunks : null;
}
function webpFrame({type, data}) {
  if (type === 'VP8 ' && data.length > 10 && !(data[0] & 1) && data.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    return dimensions(data.readUInt16LE(6) & 0x3fff, data.readUInt16LE(8) & 0x3fff);
  }
  if (type === 'VP8L' && data.length > 5 && data[0] === 0x2f) {
    const bits = data.readUInt32LE(1);
    return bits >>> 29 === 0 ? dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1) : null;
  }
  return null;
}
function webpDimensions(bytes) {
  if (bytes.length < 20 || bytes.subarray(0, 4).toString() !== 'RIFF' || bytes.subarray(8, 12).toString() !== 'WEBP'
    || bytes.readUInt32LE(4) + 8 !== bytes.length) return null;
  const chunks = webpChunks(bytes, 12); if (!chunks) return null;
  const extended = chunks.find(chunk => chunk.type === 'VP8X');
  if (extended && (chunks[0] !== extended || extended.data.length !== 10)) return null;
  const size = extended ? dimensions(extended.data.readUIntLE(4, 3) + 1, extended.data.readUIntLE(7, 3) + 1) : null;
  if (extended?.data[0] & 2) {
    if (!chunks.some(chunk => chunk.type === 'ANIM' && chunk.data.length === 6)) return null;
    const frames = chunks.filter(chunk => chunk.type === 'ANMF');
    if (!frames.length || frames.some(frame => frame.data.length <= 16 || !webpChunks(frame.data, 16)?.some(webpFrame))) return null;
    return size;
  }
  const frame = chunks.filter(chunk => ['VP8 ', 'VP8L'].includes(chunk.type));
  if (frame.length !== 1) return null;
  const actual = webpFrame(frame[0]);
  return actual && (!size || size.width === actual.width && size.height === actual.height) ? actual : null;
}

export function inspectWechatImage(bytes, onFailure) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > WECHAT_IMAGE_MAX_BYTES) return null;
  const candidates = [['image/png', pngDimensions], ['image/jpeg', jpegDimensions], ['image/gif', gifDimensions],
    ['image/bmp', bmpDimensions], ['image/webp', webpDimensions]];
  for (const [mime, inspect] of candidates) {
    const size = inspect(bytes);
    if (size) {
      // Only a complete, recognized image can establish that this is a layout separator.
      if (size.width < 16 || size.height < 16) { onFailure?.({code: 'decorative'}); return null; }
      return bytes.length > 10 * 1024 || size.width > 100 && size.height > 100 ? {mime, bytes: bytes.length, ...size} : null;
    }
  }
  return null;
}
