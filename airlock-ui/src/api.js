const NODE = 'http://localhost:3000'
const PY = 'http://localhost:8000'
const MCP = 'http://localhost:8001'

async function req(url, opts = {}) {
  const res = await fetch(url, opts)
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!res.ok) {
    const msg = typeof body === 'object'
      ? (body.error || body.detail || `HTTP ${res.status}`)
      : (body || `HTTP ${res.status}`)
    const e = new Error(msg)
    e.status = res.status
    e.body = body
    throw e
  }
  return body
}

export const api = {
  register: (email, password) =>
    req(`${NODE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),

  login: (email, password) =>
    req(`${NODE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),

  listEnvironments: (token) =>
    req(`${NODE}/api/environments`, {
      headers: { Authorization: `Bearer ${token}` },
    }),

  createEnvironment: (token, env) =>
    req(`${NODE}/api/environments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(env),
    }),

  listPendingActions: (token) =>
    req(`${NODE}/api/actions/pending`, {
      headers: { Authorization: `Bearer ${token}` },
    }),

  discoverResources: (token, envId) =>
    req(`${MCP}/resources`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Environment-Id': envId,
      },
    }),

  invokeAgent: (token, prompt, envId) =>
    req(`${PY}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, environment_id: envId, user_token: token }),
    }),

  resumeAgent: (token, threadId, approvalStatus) =>
    req(`${PY}/resume/${threadId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approval_status: approvalStatus, user_token: token }),
    }),

  getThreadState: (threadId) => req(`${PY}/state/${threadId}`),
}