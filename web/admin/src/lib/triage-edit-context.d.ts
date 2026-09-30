export type RecordPatches = Record<string, Record<string, unknown>>
export function mergePatchMaps(current: RecordPatches, patches: RecordPatches): RecordPatches
export function mergeRecordPatches<T extends { id: string }>(records: T[], patches: RecordPatches): T[]
export function reconcileQueryRecords<T extends { id: string }>(fresh: T[], previous: T[], newerPatches: RecordPatches): T[]
