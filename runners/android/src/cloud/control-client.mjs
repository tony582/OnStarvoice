import {createTransport, CloudRequestError} from './transport.mjs';

export function createControlClient(options) {
  const request = createTransport(options);
  const post = (name, body, opts) => request(`/android/${name}`, {...opts, body});
  // The relevance prefilter waits on a model call: it gets the transport's full 30 s, not the 10 s control default.
  const prefilterRequest = createTransport({...options, timeoutMs: 30000});
  return Object.freeze({
    register: async (body, opts) => {
      const result = await post('register', body, opts);
      if (!result.agent?.id || !result.agent?.token || result.agent.deviceId !== body.deviceId) {
        throw new CloudRequestError('invalid_registration');
      }
      return result;
    },
    poll: (body, opts) => post('agent/poll', body, opts),
    renew: (body, opts) => post('agent/renew', body, opts),
    complete: (body, opts) => post('agent/complete', body, opts),
    close: (body, opts) => post('agent/close', body, opts),
    prefilter: (body, opts) => prefilterRequest('/android/agent/prefilter', {...opts, body}),
  });
}
