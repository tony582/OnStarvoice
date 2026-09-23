import {createTransport, CloudRequestError} from './transport.mjs';
export {CloudRequestError, normalizeCloudUrl} from './transport.mjs';

export function createCloudClient(options = {}) {
  if (!options.agentToken) throw new TypeError('A valid agent token is required');
  const request = createTransport(options);
  const checked = async (path, params) => {
    const result = await request(path, params);
    if (!Array.isArray(result.receipts)) throw new CloudRequestError('invalid_cloud_response');
    return result;
  };
  return Object.freeze({
    ingest: (batch, opts) => checked('/agent/discoveries', {...opts, body: batch}),
    getReceipts: (id, opts) => checked(`/agent/discovery-receipts?batchId=${encodeURIComponent(id)}`, opts),
  });
}
