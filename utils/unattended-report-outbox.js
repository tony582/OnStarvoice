import "./control-storage-reserve.js";
import "./unattended-report-outbox-core.js";

export const {
  enqueueUnattendedCheckpointReport,
  discardUnattendedCheckpointReports,
  flushUnattendedCheckpointReportOutbox,
  UNATTENDED_CHECKPOINT_REPORT_OUTBOX_STORAGE_KEY,
  UNATTENDED_CHECKPOINT_REPORT_OUTBOX_MAX_ENTRIES,
} = globalThis.OnStarvoiceUnattendedCheckpointOutbox;
