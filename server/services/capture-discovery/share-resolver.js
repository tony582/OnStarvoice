import https from 'node:https';
import {createShareDnsLookup} from './share-dns.js';
import {BlockList, isIP} from 'node:net';
import {parseDouyinShareUrl} from './identity.js';

const hosts = new Set(['v.douyin.com', 'www.douyin.com', 'www.iesdouyin.com']);
const blocked = new BlockList();
const blockedV6 = new BlockList();
const publicV6 = new BlockList();
publicV6.addSubnet("2000::",3,"ipv6");
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
  ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],
  ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) blocked.addSubnet(address,prefix,'ipv4');
for (const [address,prefix] of [['::',96],['::ffff:0:0',96],['64:ff9b::',96],['100::',64],
  ['2001::',32],['2001:db8::',32],['2002::',16],['fc00::',7],['fe80::',10],['ff00::',8]]) blockedV6.addSubnet(address,prefix,'ipv6');
export function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address,'ipv4') : family === 6
    && publicV6.check(address,'ipv6') && !blockedV6.check(address,'ipv6');
}
function validateUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.has(url.hostname)) {
    throw new Error('UNSAFE_SHARE_REDIRECT');
  }
  return url;
}
function requestHeaders(url, {signal, address, family}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {method:'GET', signal, timeout:2500, family, autoSelectFamily:false,
      headers:{'User-Agent':'Mozilla/5.0', Accept:'text/html'},
      // Pin the validated DNS result, preventing a second lookup/rebinding.
      lookup(_hostname, _options, callback) { callback(null,address,family); },
    }, response => {
      resolve({status:response.statusCode, location:response.headers.location});
      response.destroy();
    });
    request.on('timeout', () => request.destroy(new Error('SHARE_RESOLUTION_TIMEOUT')));
    request.on('error', reject);
    request.end();
  });
}
export function createShareResolver({dnsLookup = createShareDnsLookup(), request = requestHeaders} = {}) {
  return async (value, {signal} = {}) => {
    let url = validateUrl(value);
    for (let hop = 0; hop <= 3; hop++) {
      if (signal?.aborted) throw new Error('SHARE_RESOLUTION_ABORTED');
      const addresses = await dnsLookup(url.hostname, {all:true, verbatim:true, signal});
      if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) throw new Error('UNSAFE_SHARE_ADDRESS');
      if (signal?.aborted) throw new Error('SHARE_RESOLUTION_ABORTED');
      const response = await request(url, {...addresses[0], signal});
      if ([301,302,303,307,308].includes(response.status) && response.location) {
        url = validateUrl(new URL(response.location, url));
        const parsed = parseDouyinShareUrl(url.href);
        if (parsed.status === 'resolved') return parsed.canonicalUrl;
        continue;
      }
      const parsed = parseDouyinShareUrl(url.href);
      if (response.status >= 200 && response.status < 300 && parsed.status === 'resolved') return parsed.canonicalUrl;
      throw new Error('SHARE_REDIRECT_UNRESOLVED');
    }
    throw new Error('SHARE_REDIRECT_LIMIT');
  };
}
export const resolveDouyinShareUrl = createShareResolver();
