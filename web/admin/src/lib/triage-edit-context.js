// Saved field patches never change membership or order in the current editing context.
export function mergePatchMaps(current, patches) {
  const next = { ...current }
  for (const [id, patch] of Object.entries(patches)) {
    const key = id.toLowerCase()
    next[key] = { ...next[key], ...patch }
  }
  return next
}
export function mergeRecordPatches(records, patches) {
  return records.map(record => {
    const patch = patches[String(record.id).toLowerCase()]
    return patch ? { ...record, ...patch, id: record.id } : record
  })
}

// Keep saves completed after a query started, even if its response already excludes them.
export function reconcileQueryRecords(fresh, previous, newerPatches) {
  const returned = new Set(fresh.map(record => record.id.toLowerCase()))
  const retained = previous.filter(record => newerPatches[record.id.toLowerCase()] && !returned.has(record.id.toLowerCase()))
  return mergeRecordPatches([...fresh, ...retained], newerPatches)
    .filter(record => !newerPatches[record.id.toLowerCase()]?._removedFromContext)
}
