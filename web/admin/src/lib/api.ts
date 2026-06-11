class ApiClient {
  private tenantId = ''

  setTenant(id: string) {
    this.tenantId = id
  }

  getTenant() {
    return this.tenantId
  }

  async request<T = any>(path: string, options: RequestInit & { skipTenant?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    }
    if (!options.skipTenant && this.tenantId) {
      headers['x-tenant-id'] = this.tenantId
    }

    const { skipTenant, ...fetchOptions } = options

    const resp = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      ...fetchOptions,
      headers,
    })

    let data: any
    try {
      data = await resp.json()
    } catch {
      data = { ok: false, message: '响应格式错误' }
    }

    if (!resp.ok) {
      throw new Error(data.message || data.error || '请求失败')
    }

    return data as T
  }

  get<T = any>(path: string, opts?: { skipTenant?: boolean }) {
    return this.request<T>(path, opts)
  }

  post<T = any>(path: string, body?: unknown, opts?: { skipTenant?: boolean }) {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body), ...opts })
  }

  patch<T = any>(path: string, body?: unknown, opts?: { skipTenant?: boolean }) {
    return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body), ...opts })
  }

  put<T = any>(path: string, body?: unknown, opts?: { skipTenant?: boolean }) {
    return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body), ...opts })
  }

  delete<T = any>(path: string, opts?: { skipTenant?: boolean }) {
    return this.request<T>(path, { method: 'DELETE', ...opts })
  }
}

export const api = new ApiClient()
