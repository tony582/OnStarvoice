type ApiRequestOptions = RequestInit & {
  skipTenant?: boolean
  timeoutMs?: number
}

type ApiCallOptions = {
  skipTenant?: boolean
  timeoutMs?: number
}

function responseMessage(data: unknown, fallback: string) {
  if (!data || typeof data !== 'object') return fallback
  const response = data as { message?: unknown; error?: unknown }
  if (typeof response.message === 'string' && response.message) return response.message
  if (typeof response.error === 'string' && response.error) return response.error
  return fallback
}

class ApiClient {
  private tenantId = ''

  setTenant(id: string) {
    this.tenantId = id
  }

  getTenant() {
    return this.tenantId
  }

  async request<T = unknown>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    }
    if (!options.skipTenant && this.tenantId) {
      headers['x-tenant-id'] = this.tenantId
    }

    const { timeoutMs, ...fetchOptions } = options
    delete fetchOptions.skipTenant
    const timeoutController =
      Number.isFinite(timeoutMs) &&
      Number(timeoutMs) > 0 &&
      !fetchOptions.signal
        ? new AbortController()
        : null
    const timeoutId = timeoutController
      ? window.setTimeout(() => timeoutController.abort(), Number(timeoutMs))
      : null

    let resp: Response
    try {
      resp = await fetch(`/api${path}`, {
        credentials: 'same-origin',
        ...fetchOptions,
        ...(timeoutController ? { signal: timeoutController.signal } : {}),
        headers,
      })
    } catch (error) {
      if (timeoutController?.signal.aborted) {
        const timeoutError = new Error(
          '请求超时，云端暂未完成分配。请检查网络后重试；系统会自动识别重复提交。',
        ) as Error & { cause?: unknown }
        timeoutError.cause = error
        throw timeoutError
      }
      throw error
    } finally {
      if (timeoutId !== null) window.clearTimeout(timeoutId)
    }

    let data: unknown
    try {
      data = await resp.json()
    } catch {
      data = { ok: false, message: '响应格式错误' }
    }

    if (!resp.ok) {
      throw new Error(responseMessage(data, '请求失败'))
    }

    return data as T
  }

  get<T = unknown>(path: string, opts?: ApiCallOptions) {
    return this.request<T>(path, opts)
  }

  post<T = unknown>(path: string, body?: unknown, opts?: ApiCallOptions) {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body), ...opts })
  }

  patch<T = unknown>(path: string, body?: unknown, opts?: ApiCallOptions) {
    return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body), ...opts })
  }

  put<T = unknown>(path: string, body?: unknown, opts?: ApiCallOptions) {
    return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body), ...opts })
  }

  delete<T = unknown>(path: string, opts?: ApiCallOptions) {
    return this.request<T>(path, { method: 'DELETE', ...opts })
  }

  // 文件下载(如 Excel 导出):带租户头 + 同源 cookie,从 Content-Disposition 取文件名,触发浏览器下载。
  async download(path: string, fallbackName = 'export.xlsx') {
    const headers: Record<string, string> = {}
    if (this.tenantId) headers['x-tenant-id'] = this.tenantId
    const resp = await fetch(`/api${path}`, { credentials: 'same-origin', headers })
    if (!resp.ok) {
      let msg = '导出失败'
      try { msg = responseMessage(await resp.json(), msg) } catch { /* ignore */ }
      throw new Error(msg)
    }
    const blob = await resp.blob()
    const cd = resp.headers.get('Content-Disposition') || ''
    let name = fallbackName
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd)
    if (m) { try { name = decodeURIComponent(m[1]) } catch { /* ignore */ } }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }
}

export const api = new ApiClient()
