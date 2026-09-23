export class RunnerFault extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = 'RunnerFault';
    this.code = code;
    this.details = details;
  }
}

export function requireEvidence(condition, code, message) {
  if (!condition) throw new RunnerFault(code, message);
}
