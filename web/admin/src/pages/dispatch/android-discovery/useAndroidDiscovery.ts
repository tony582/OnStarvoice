import {useCallback, useEffect, useRef, useState} from 'react'
import {androidApi, friendlyError} from './api'
import type {AndroidApi} from './api'
import type {AndroidNode, DiscoveryRun, DiscoveryRunDetail} from './types'

export function useAndroidDiscovery(client: AndroidApi = androidApi) {
  const [nodes, setNodes] = useState<AndroidNode[]>([])
  const [runs, setRuns] = useState<DiscoveryRun[]>([])
  const [selectedId, updateSelectedId] = useState('')
  const [detail, setDetail] = useState<DiscoveryRunDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const active = useRef(true)
  const inFlight = useRef(false)
  const acting = useRef(false)
  const currentId = useRef('')
  const detailVersion = useRef(0)

  const loadDetail = useCallback(async (id: string) => {
    const version = ++detailVersion.current
    try {
      const result = await client.detail(id)
      if (active.current && currentId.current === id && detailVersion.current === version) setDetail(result)
    } catch (err) {
      if (active.current && detailVersion.current === version) setError(friendlyError(err))
    }
  }, [client])

  const setSelectedId = useCallback((id: string) => {
    currentId.current = id
    updateSelectedId(id)
    setDetail(null)
    void loadDetail(id)
  }, [loadDetail])

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const [deviceData, taskData] = await Promise.all([client.nodes(), client.runs()])
      if (!active.current) return
      setNodes(deviceData.nodes)
      setRuns(taskData.runs)
      setError('')
      const id = currentId.current || taskData.runs[0]?.id
      if (id) {
        if (!currentId.current) { currentId.current = id; updateSelectedId(id) }
        await loadDetail(id)
      } else setDetail(null)
    } catch (err) { if (active.current) setError(friendlyError(err)) }
    finally { inFlight.current = false; if (active.current) setLoading(false) }
  }, [client, loadDetail])

  useEffect(() => {
    active.current = true
    const start = window.setTimeout(() => { void refresh() }, 0)
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 15000)
    return () => { active.current = false; window.clearTimeout(start); window.clearInterval(timer) }
  }, [refresh])

  const act = useCallback(async (operation: () => Promise<unknown>, message: string) => {
    if (acting.current) return false
    acting.current = true
    setBusy(true); setError(''); setFeedback('')
    try {
      await operation()
      if (active.current) { setFeedback(message); await refresh() }
      return true
    } catch (err) { if (active.current) setError(friendlyError(err)); return false }
    finally { acting.current = false; if (active.current) setBusy(false) }
  }, [refresh])

  return {nodes, runs, selectedId, setSelectedId, detail, loading, busy, error, feedback, refresh, act}
}
