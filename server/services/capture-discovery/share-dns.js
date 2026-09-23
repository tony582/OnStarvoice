import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

const hosts = new Set(['v.douyin.com','www.douyin.com','www.iesdouyin.com']);
const fail = (retryable=false,retryDelayMs=100) => {
  throw Object.assign(new Error('SHARE_DNS_UNAVAILABLE'),{retryable,retryDelayMs});
};
const domain = value => typeof value === 'string' ? value.toLowerCase().replace(/\.$/u,'') : '';

async function readDocument(response) {
  if (!response.ok) {
    const header=response.headers.get('retry-after');
    const requested=header===null?100:/^\d+(?:\.\d+)?$/u.test(header)
      ?Number(header)*1000:Date.parse(header)-Date.now();
    const retryable=[408,429].includes(response.status)||response.status>=500&&response.status<=599;
    await response.body?.cancel().catch(()=>{});
    // Respect provider backoff; long waits remain an explicit pending result.
    fail(retryable&&Number.isFinite(requested)&&requested<=1000,Math.max(100,requested));
  }
  if (!response.body) fail();
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const {value,done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) fail();
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(()=>{}); }
}

function addressesFrom(data, hostname) {
  if (data?.TC !== false || data.CD === true || data.Question?.length !== 1
      || domain(data.Question[0].name) !== hostname || data.Question[0].type !== 1) fail();
  if (data.Status === 2) fail(true); // SERVFAIL may be a transient upstream failure.
  if (data.Status !== 0 || !Array.isArray(data.Answer) || data.Answer.length > 64) fail();
  let name = hostname, ttl = 60;
  const visited = new Set();
  for (let hop = 0; hop < 8; hop++) {
    if (visited.has(name)) fail();
    visited.add(name);
    const records = data.Answer.filter(row => domain(row.name) === name);
    for (const row of records) {
      if (!Number.isInteger(row.TTL) || row.TTL < 0) fail();
      ttl = Math.min(ttl,row.TTL);
    }
    const aliases = records.filter(row => row.type === 5);
    const addresses = records.filter(row => row.type === 1);
    if (aliases.length) {
      if (aliases.length !== 1 || addresses.length) fail();
      name = domain(aliases[0].data);
      if (name.length > 253 || !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/u.test(name)) fail();
      continue;
    }
    if (!addresses.length || addresses.some(row => isIP(row.data) !== 4)) fail();
    return {ttl,addresses:[...new Set(addresses.map(row=>row.data))].map(address=>({address,family:4}))};
  }
  fail();
}

/** Opt-in resolver for hosts whose system DNS returns proxy synthetic addresses.
 * Only public platform hostnames are sent, never work URLs, credentials or captions.
 * Reference: https://developers.google.com/speed/public-dns/docs/doh/json
 * Returned addresses still pass the share resolver's public-IP checks and TLS pinning.
 */
export function createShareDnsLookup({mode = process.env.ANDROID_DISCOVERY_DNS_MODE || 'system',
  systemLookup = lookup, fetchImpl = globalThis.fetch, now = Date.now} = {}) {
  if (mode === 'system') return systemLookup;
  if (mode !== 'google-doh') throw new Error('UNSUPPORTED_SHARE_DNS_MODE');
  const cache = new Map();
  const query = async (hostname,signal) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
    const timer = setTimeout(abort,1500);
    try {
      const url = new URL('https://dns.google/resolve');
      url.search = new URLSearchParams({name:hostname,type:'A',edns_client_subnet:'0.0.0.0/0'}).toString();
      let response;
      try { response=await fetchImpl(url,{signal:controller.signal,redirect:'error',headers:{Accept:'application/dns-json'}}); }
      catch { fail(!signal?.aborted); }
      const result=addressesFrom(await readDocument(response),hostname);
      if (controller.signal.aborted) fail(!signal?.aborted);
      return result;
    } catch (error) {
      if (signal?.aborted) fail();
      if (controller.signal.aborted) fail(true);
      throw error;
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  };
  return async (hostname, {signal} = {}) => {
    if (!hosts.has(hostname)) throw new Error('UNSAFE_SHARE_DNS_HOST');
    if (signal?.aborted) fail();
    const cached=cache.get(hostname);
    if (cached && cached.until>now()) return cached.addresses.map(row=>({...row}));
    for (let attempt=0;attempt<2;attempt++) {
      try {
        const result=await query(hostname,signal);
        cache.set(hostname,{addresses:result.addresses,until:now()+result.ttl*1000});
        return result.addresses.map(row=>({...row}));
      } catch (error) {
        if (signal?.aborted || !error.retryable || attempt===1) fail();
        try { await delay(error.retryDelayMs,undefined,{signal}); } catch { fail(); }
      }
    }
  };
}
