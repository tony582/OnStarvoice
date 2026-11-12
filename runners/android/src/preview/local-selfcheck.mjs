import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';

/** A one-use loopback page exercises Chrome's network process without contacting any external site. */
export async function visitLocalPreviewPage(visit, {signal} = {}) {
  const marker = `starvoice-preview-${randomBytes(16).toString('hex')}`;
  const path = `/preview-selfcheck/${marker}`;
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== path) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'", 'Connection': 'close'});
    response.end(`<!doctype html><html><head><title>StarVoice preview check</title></head><body>${marker}</body></html>`);
  });
  const aborted = () => signal?.reason ?? Object.assign(new Error('Preview check canceled'), {code: 'aborted'});
  let abort;
  const canceled = new Promise((_, reject) => {
    abort = () => reject(aborted());
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
  });
  canceled.catch(() => {});
  try {
    if (signal?.aborted) throw aborted();
    await Promise.race([new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({host: '127.0.0.1', port: 0, exclusive: true, signal}, resolve);
    }), canceled]);
    if (signal?.aborted) throw aborted();
    const address = server.address();
    if (!address || address.address !== '127.0.0.1') throw new Error('Preview check must bind loopback');
    await Promise.race([visit(`http://127.0.0.1:${address.port}${path}`, marker, signal), canceled]);
  } finally {
    signal?.removeEventListener('abort', abort);
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
  }
}
