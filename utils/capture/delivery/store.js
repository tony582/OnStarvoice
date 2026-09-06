// Explicit persistence boundary for list and direct prepared-record saves.
// Preserve the original return value/Promise, arguments and storage queue ownership.
export function createStoreStage({ports}) {
  const {persistRecord, persistRecords} = ports;
  function savePreparedRecord(...args) { return persistRecord(...args); }
  function savePreparedRecords(...args) { return persistRecords(...args); }
  return Object.freeze({savePreparedRecord, savePreparedRecords});
}
