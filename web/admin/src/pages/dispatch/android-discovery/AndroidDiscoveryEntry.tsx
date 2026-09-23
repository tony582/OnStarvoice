import {useEffect, useRef, useState} from 'react'
import {Smartphone, X} from 'lucide-react'
import {Button} from '@/components/ui/button'
import {androidApi} from './api'
import {AndroidDiscoveryPanel} from './AndroidDiscoveryPanel'

export function AndroidDiscoveryEntry({writable}: {writable: boolean}) {
  const [enabled, setEnabled] = useState(false)
  const [open, setOpen] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    let active = true
    androidApi.capabilities().then(result => { if (active) setEnabled(result.enabled) }).catch(() => {})
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (open) dialog.current?.showModal()
    else dialog.current?.close()
  }, [open])
  if (!enabled) return null
  return <>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}><Smartphone className="h-4 w-4"/>手机发现</Button>
    <dialog ref={dialog} onClose={() => setOpen(false)} aria-labelledby="android-discovery-title"
      className="fixed m-auto max-h-[92dvh] w-[min(1180px,96vw)] max-w-none overflow-y-auto rounded-2xl border border-border bg-card p-4 text-foreground shadow-2xl backdrop:bg-black/35 sm:p-6">
      <header className="mb-5 flex items-center justify-between gap-3">
        <h2 id="android-discovery-title" className="flex items-center gap-2 text-lg font-bold"><Smartphone className="h-5 w-5 text-primary"/>抖音手机发现</h2>
        <Button size="icon" variant="ghost" onClick={() => setOpen(false)} aria-label="关闭手机发现"><X className="h-5 w-5"/></Button>
      </header>
      {open && <AndroidDiscoveryPanel writable={writable}/>}
    </dialog>
  </>
}
