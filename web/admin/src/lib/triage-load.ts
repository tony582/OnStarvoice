export const TRIAGE_READ_TIMEOUT_MS = 25000

export async function withTriageReadDeadline<T>(read: (signal: AbortSignal) => Promise<T>, controller: AbortController, timeoutMs = TRIAGE_READ_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('内容加载超时，请稍后重试。'))
      controller.abort()
    }, timeoutMs)
  })
  try { return await Promise.race([read(controller.signal), deadline]) }
  finally { clearTimeout(timer) }
}

export function triageLoadError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/capacity|temporarily unavailable|connection pool|database.*unavailable/i.test(message)) return '当前服务暂时繁忙，内容加载失败，请稍后重试。'
  if (/timeout|timed out|超时/i.test(message)) return '内容加载超时，请稍后重试。'
  return /[\u4e00-\u9fff]/u.test(message) ? message : '内容暂时加载失败，请稍后重试。'
}
