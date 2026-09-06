import {createStoreStage} from './store.js';
import {createCheckpointStage} from './checkpoint.js';
import {createCacheStage} from './cache.js';
import {createPayloadStage} from './payload.js';
import {createTraceModelStage} from './trace-model.js';
import {createCommentModelStage} from './comment-model.js';
import {createMetricsModelStage} from './metrics-model.js';
import {createRecordModelStage} from './record-model.js';
import {createHistoryStage} from './history.js';
import {createCancellationStage} from './cancellation.js';
import {createSingleStage} from './single.js';
import {createBatchStage} from './batch.js';
import {createRequestsStage} from './requests.js';
import {createResultsStage} from './results.js';
import {createBatchPlanStage} from './batch-plan.js';
import {createPreflightStage} from './preflight.js';

// One owner of the existing list checkpoint pointer. Sync queues stay call-local.
// The storage mutation queue and reliable timer remain host-owned capabilities.
export function createResultDeliveryPipeline(ports) {
  const state = {activeListCaptureCheckpointSession: null};
  const operations = Object.create(null);
  Object.assign(operations, createStoreStage({ports}));
  Object.assign(operations, createCheckpointStage({state, ports, operations}));
  Object.assign(operations, createCacheStage({state, ports, operations}));
  Object.assign(operations, createPayloadStage({state, ports, operations}));
  Object.assign(operations, createTraceModelStage({state, ports, operations}));
  Object.assign(operations, createCommentModelStage({state, ports, operations}));
  Object.assign(operations, createMetricsModelStage({state, ports, operations}));
  Object.assign(operations, createRecordModelStage({state, ports, operations}));
  Object.assign(operations, createHistoryStage({state, ports, operations}));
  Object.assign(operations, createCancellationStage({state, ports, operations}));
  Object.assign(operations, createSingleStage({state, ports, operations}));
  Object.assign(operations, createBatchStage({state, ports, operations}));
  Object.assign(operations, createRequestsStage({state, ports, operations}));
  Object.assign(operations, createResultsStage({state, ports, operations}));
  Object.assign(operations, createBatchPlanStage({state, ports, operations}));
  Object.assign(operations, createPreflightStage({state, ports, operations}));
  return Object.freeze(operations);
}
