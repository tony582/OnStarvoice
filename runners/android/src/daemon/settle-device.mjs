import {DeviceClosureJournal, readDeviceClosure} from '../core/device-closure.mjs';

// Physical closure is verified before the task completion can release its slot.
// A lost Appium create/delete response never authorizes a new device session.
export async function settleDevice({device, store, task, result, clock}) {
  if (typeof device.close !== 'function') return result;
  let pending = readDeviceClosure(store,task.deviceId);
  if (!pending?.required) {
    const journal = new DeviceClosureJournal({store,task,clock});
    journal.begin('close_session');
    pending = journal.value;
  }
  try {
    const evidence = await device.close();
    if (evidence.closed !== true) throw new Error('closure_unconfirmed');
    const proof = {deviceId:task.deviceId,operationId:pending.operationId,method:'independent_stop_check',
      verifiedBy:'runner-appium-adb',verifiedAt:evidence.verifiedAt,evidenceId:evidence.evidenceId};
    const journal = new DeviceClosureJournal({store,task,clock,deviceClosureVerified:proof});
    return {...result,deviceIdle:true,stopConfirmationRequired:false,deviceClosure:journal.value};
  } catch {
    return {...result,...(result.status.startsWith('completed') ? {status:'needs_action',reason:'device_closure_required'} : {}),
      deviceIdle:false,stopConfirmationRequired:true,deviceClosure:readDeviceClosure(store,task.deviceId)};
  }
}
