import {createTransport, CloudRequestError} from './transport.mjs';

export function createControlClient(options) {
  const request = createTransport(options);
  const post = (name, body, opts) => request(`/android/${name}`, {...opts, body});
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
  });
}
