import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {inspectWechatImage, WECHAT_IMAGE_MAX_BYTES} from '../server/services/wechat-image-validation.js';
import {pngFixture} from './helpers/wechat-image-fixtures.mjs';

// Complete 120x130 RGB images encoded locally with Pillow 12.1.1; deflate only reduces fixture size.
// Pillow is not a runtime/test dependency. These contain real image data, not hand-built format headers.
const encoded = {
  jpeg: 'eJz7f+P/AwYBLzdPNwZGRgYGRiBk+H+bwZmBg42NnY2Vg52dnZOTg4tHhJeHm5tHUkiYX0RWSl5OVkpGRkFFT11BSUdZRkbDXFPHwNDExERe3dLWwshGz9jECGQIIycnJw83jwQvr4SRooyiEcng/wEGQQ6GJoYKZkYlBiZBRmZBxv9HGOSB7mRlBAMGKGBkYmZhZWPn4OTiBirYKsDAxMjMzMTCzMrKwgKUrQXKM7AIsgopGjqyCQcmsisVihg1TlzIoey08aBo0MUPKsZJRU2cXGLiEpJSqmrqGppaJqZm5haWVs4urm7uHp5ewSGhYeERkVHJKalp6RmZWcUlpWXlFZVVzS2tbe0dnV2TJk+ZOm36jJmzFi1esnTZ8hUrV23avGXrtu07du46dPjI0WPHT5w8denylavXrt+4eevho8dPnj57/uLlq4+fPn/5+u37j5+/QP5iZGBmhAGs/hIE+ouJhYWZhR3kL0amcpACQRZWRUM2IcdA9sRCYSWjRg4Rp4kLNx7kVDYO+iCaVHSRS0zF5KHqR5DXwD4jzmNNZPkM7jGEv24x8DAzAiOPWZDBnmGhq0j4hspEV5EAxlGMFbP/vwkAomz+CA==',
  progressive: 'eJz7f+P/AwYBLzdPNwZGRgYGRiBk+H+bwZmBg42NnY2Vg52dnZOTg4tHhJeHm5tHUkiYX0RWSl5OVkpGRkFFT11BSUdZRkbDXFPHwNDExERe3dLWwshGz9jECGQIIycnJw83jwQvr4SRooyiEcng/yEGQQ6GJoYKZkYlBiZBRmZBxv9HGETBTkUBLCBhRizCtxh4mBkZmASYBYCemxOpwUAGANkpIoBudgHQbA6gjYysTPUgBYLoChLACpgZGe0ZBfEoYIIrwGkFmz3ECtxusFesh3mVgRkoIfD5vA0ZiIA/BAj5QwC/P4AK6v/fBAA0IHMK',
  gif: 'eJwB8QAO/0dJRjg3YXgAggCBAABQeKAAAAAAAAAAAAAsAAAAAHgAggBACMoAAQgcSLCgwYMIEypcyLChw4cQI0qcSLGixYsYM2rcyLGjx48gQ4ocSbKkyZMoU6pcybKly5cwY8qcSbOmzZs4c+rcybOnz59AgwodSrSo0aNIkypdyrSp06dQo0qdSrWq1atYs2rdyrWr169gw4odS7as2bNo06pdy7at27dw48qdS7eu3bt48+rdy7ev37+AAwseTLiw4cOIEytezLix48eQI0ueTLmy5cuYM2vezLmz58+gQ4seTbq06dOoU6tezbq169ewMQYEADvwjXcl',
  webp: 'eJwL8nRzy2BgYAh3dQoIC7BQiAGyBdgZ5jJqVTA0Mdjlms30XKK0aKFCB0MDb2dm3sNSzwIGRtttSh9Z3W03indoWb7t2OMYeD7H9RFXX3WSvkBI8W2BDwz//j7Y/3+rgadk6/5/rdIaMziuLlX50AA0mgEAyJ8otw==',
  webp_lossless: 'eJwL8nRzU2FgYAh3dQoIC7DwEQey9csdFBjYA/Y4iW75n8ggdOj/fy+X/8HnGADwXA2/',
  bmp: 'eJztyDENgEAQRNGloaRGAgoQQE+CnKtRggowcAKQxOYIFqje5P1mlrW/om3Opqxke9bF2P77jKjD27ejbAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPzgATtIvGM=',
  webp_animated: 'eJwL8nRzM2BkYAh3dQoIC7CI4GJgYGAC4nIGhkYGBkc/T182Bhhw9PN1a4LzICpSgMqB+hSygCIGnAxzGbUqGJoY7HLNZnouUVZaqNDB0MDbmZl3/4O+wx7GH4yqb00YVPjVVB7t4pPf63Bxu+3smesZF+dVmxvHMbvd+ZaXtoetd+ebO2creKWLb247wPDvsdP/Tx5fi2XZ/y90O6W2ybWs1XF1BtglVZguYQC5JAlIf2FHuMRosmcTBwPDjWnT3v5nnPvMgMFju4PXoitRnf/Obbsenb1267Vbr3NLt+26HZu7DlXAl4HhX+P9f+azz2ZH/3+lpLBki5uEodLbzOgMBwYAvottVg==',
};
const fixture = name => inflateSync(Buffer.from(encoded[name], 'base64'));
const samples = () => Object.fromEntries(['jpeg', 'progressive', 'gif', 'webp', 'webp_lossless', 'webp_animated', 'bmp'].map(name => [name, fixture(name)]));

test('complete real PNG/JPEG/progressive JPEG/GIF/WebP/BMP containers retain their dimensions', async t => {
  for (const [name, bytes] of Object.entries({png: pngFixture(120, 130), ...samples()})) await t.test(name, () => {
    assert.deepEqual(inspectWechatImage(bytes), {mime: `image/${name === 'progressive' ? 'jpeg' : name.startsWith('webp') ? 'webp' : name}`,
      width: 120, height: 130, bytes: bytes.length});
  });
});

test('header-only files and missing final bytes cannot pass the dimension or byte threshold', () => {
  const fixtures = {png: pngFixture(120, 130), ...samples()};
  const headers = {png: 24, jpeg: 20, progressive: 20, gif: 13, webp: 30, webp_lossless: 25, webp_animated: 30, bmp: 54};
  for (const [name, bytes] of Object.entries(fixtures)) {
    assert.equal(inspectWechatImage(bytes.subarray(0, headers[name])), null, `${name} header only`);
    assert.equal(inspectWechatImage(bytes.subarray(0, bytes.length - 1)), null, `${name} truncated ending`);
    assert.equal(inspectWechatImage(bytes.subarray(0, Math.floor(bytes.length / 2))), null, `${name} truncated payload`);
  }
});

test('container headers cannot hide missing image data by shortening their declared length', () => {
  const png = pngFixture(120, 130);
  assert.equal(inspectWechatImage(Buffer.concat([png.subarray(0, 33), png.subarray(-12)])), null, 'PNG has IHDR and IEND but no IDAT');
  const jpeg = fixture('jpeg'), scan = jpeg.indexOf(Buffer.from([0xff, 0xda]));
  assert.equal(inspectWechatImage(Buffer.concat([jpeg.subarray(0, scan), Buffer.from([0xff, 0xd9])])), null, 'JPEG has dimensions and EOI but no scan');
  const gif = fixture('gif').subarray(0, 25);
  assert.equal(inspectWechatImage(Buffer.concat([gif, Buffer.from([0x3b])])), null, 'GIF has palette and trailer but no image');
  const webp = Buffer.from(fixture('webp').subarray(0, 30)); webp.writeUInt32LE(webp.length - 8, 4);
  assert.equal(inspectWechatImage(webp), null, 'WebP RIFF length cannot hide an incomplete chunk');
  const bmp = Buffer.from(fixture('bmp').subarray(0, 100)); bmp.writeUInt32LE(bmp.length, 2);
  assert.equal(inspectWechatImage(bmp), null, 'BMP byte length cannot replace its required pixel area');
});

test('unrecognized formats, unsupported compressed BMP, placeholders and oversized data stay unverified', () => {
  assert.equal(inspectWechatImage(Buffer.from('<html>not authorized</html>'.repeat(1000))), null);
  assert.equal(inspectWechatImage(pngFixture(20, 20)), null);
  assert.equal(inspectWechatImage(Buffer.alloc(WECHAT_IMAGE_MAX_BYTES + 1)), null);
  const bmp = fixture('bmp'); bmp.writeUInt32LE(1, 30);
  assert.equal(inspectWechatImage(bmp), null, 'RLE BMP is not structurally supported');
  assert.ok(inspectWechatImage(pngFixture(80, 80, true)), 'valid images over 10 KB keep the byte alternative');
});
