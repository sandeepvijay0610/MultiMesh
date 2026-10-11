import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { api } from './api.js'
const NODE = 'http://localhost:3000'

// =============================================================================
// Styling — inline, minimal. Structural borders, monospace for JSON.
// =============================================================================
const S = {
  page: { fontFamily: 'system-ui, sans-serif', padding: 16, maxWidth: 1180, margin: '0 auto' },
  section: { border: '1px solid #d0d0d0', padding: 12, marginBottom: 12, borderRadius: 4 },
  sectionHead: { margin: '0 0 8px 0', fontSize: 16 },
  row: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 6 },
  input: { padding: '4px 6px', border: '1px solid #bbb', borderRadius: 3, fontSize: 13 },
  btn: { padding: '4px 10px', border: '1px solid #888', background: '#f6f6f6', borderRadius: 3, cursor: 'pointer', fontSize: 13 },
  btnPrimary: { padding: '4px 12px', border: '1px solid #2c6', background: '#d4f4dd', borderRadius: 3, cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  btnDanger: { padding: '4px 12px', border: '1px solid #c33', background: '#ffe0e0', borderRadius: 3, cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  card: { border: '1px solid #ccc', borderRadius: 4, padding: 8, background: '#fafafa', cursor: 'pointer', marginBottom: 6 },
  cardSelected: { border: '2px solid #06c', background: '#eaf4ff' },
  pre: { background: '#f2f2f2', padding: 8, fontFamily: 'ui-monospace, monospace', fontSize: 12, overflow: 'auto', maxHeight: 260, margin: 0, border: '1px solid #e2e2e2', borderRadius: 3 },
  badge: { display: 'inline-block', padding: '1px 6px', borderRadius: 8, fontSize: 11, fontWeight: 600, marginLeft: 6 },
  tabs: { display: 'flex', gap: 4, marginBottom: 8, borderBottom: '1px solid #ddd' },
  tab: { padding: '6px 12px', border: '1px solid transparent', borderBottom: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13 },
  tabActive: { padding: '6px 12px', border: '1px solid #ddd', borderBottom: '1px solid #fff', background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, marginBottom: -1 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 },
  infoBox: { background: '#fff8e1', border: '1px solid #e0c060', padding: 8, borderRadius: 3, marginTop: 6, fontSize: 13 },
  errorBox: { background: '#ffe0e0', border: '1px solid #c33', padding: 8, borderRadius: 3, marginTop: 6, fontSize: 13 },
  okBox: { background: '#e6f7ea', border: '1px solid #2c6', padding: 8, borderRadius: 3, marginTop: 6, fontSize: 13 },
  stepper: { display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' },
  step: { flex: 1, minWidth: 140, padding: 8, border: '1px solid #ccc', borderRadius: 4, background: '#f7f7f7', fontSize: 12, textAlign: 'center' },
  stepActive: { flex: 1, minWidth: 140, padding: 8, border: '2px solid #06c', borderRadius: 4, background: '#eaf4ff', fontSize: 12, textAlign: 'center', fontWeight: 600 },
  stepAmber: { flex: 1, minWidth: 140, padding: 8, border: '2px solid #c90', borderRadius: 4, background: '#fff4d6', fontSize: 12, textAlign: 'center', fontWeight: 600 },
  stepGreen: { flex: 1, minWidth: 140, padding: 8, border: '2px solid #2c6', borderRadius: 4, background: '#d4f4dd', fontSize: 12, textAlign: 'center', fontWeight: 600 },
  stepRed: { flex: 1, minWidth: 140, padding: 8, border: '2px solid #c33', borderRadius: 4, background: '#ffe0e0', fontSize: 12, textAlign: 'center', fontWeight: 600 },
  kv: { display: 'grid', gridTemplateColumns: '150px 1fr', gap: '4px 8px', fontSize: 12, fontFamily: 'ui-monospace, monospace' },
  kvKey: { color: '#666' },
  log: { background: '#f6f6f6', border: '1px solid #e2e2e2', borderRadius: 3, padding: 6, maxHeight: 200, overflow: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: 11 },
}

function Section({ title, children, right }) {
  return (
    <div style={S.section}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={S.sectionHead}>{title}</h3>
        {right}
      </div>
      {children}
    </div>
  )
}

// =============================================================================
// Risk classification
// =============================================================================
function classifyRisk(toolName) {
  if (!toolName) return { level: 'UNKNOWN', color: '#888', bg: '#eee' }
  if (['terminate_ec2_instance', 'delete_s3_bucket'].includes(toolName)) {
    return { level: 'CRITICAL (Irreversible)', color: '#fff', bg: '#c33' }
  }
  if (toolName.startsWith('stop_') || toolName.startsWith('reboot_') || toolName.startsWith('restart_')) {
    return { level: 'MEDIUM (State Disruption)', color: '#3a2a00', bg: '#ffcc55' }
  }
  if (toolName.startsWith('start_') || toolName.startsWith('create_') || toolName === 'invoke_lambda_function') {
    return { level: 'LOW', color: '#083', bg: '#c8ecd4' }
  }
  return { level: 'UNKNOWN', color: '#333', bg: '#ddd' }
}

function stateBadgeColor(state) {
  const s = String(state || '').toLowerCase()
  if (['running', 'active', 'available', 'created', 'pending', 'starting'].includes(s)) return '#2c6'
  if (['stopped', 'stopping', 'rebooting', 'shutting-down', 'failed'].includes(s)) return '#c33'
  return '#888'
}

// =============================================================================
// Subcomponents
// =============================================================================
function PipelineStepper({ invokeInFlight, interrupted, approvalStatus, resumeInFlight, hasToolResult }) {
  const steps = [
    { label: '1. LLM Planner', active: invokeInFlight },
    { label: '2. Airlock HITL Gate', amber: interrupted && approvalStatus === 'PENDING' },
    { label: '3. MCP Vault & Dispatch', active: resumeInFlight },
    {
      label: '4. Completed / Aborted',
      green: approvalStatus === 'APPROVED' && hasToolResult,
      red: approvalStatus === 'REJECTED' || approvalStatus === 'FAILED',
    },
  ]
  return (
    <div style={S.stepper}>
      {steps.map((s, i) => {
        const style = s.green ? S.stepGreen : s.red ? S.stepRed : s.amber ? S.stepAmber : s.active ? S.stepActive : S.step
        return <div key={i} style={style}>{s.label}</div>
      })}
    </div>
  )
}

function ResourceCard({ resource, selected, onClick }) {
  const border = selected ? S.cardSelected : S.card
  const st = resource.state || resource.status
  return (
    <div style={border} onClick={onClick}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <b style={{ fontSize: 13 }}>{resource.name || resource.id || resource.bucket_name}</b>
        {st && (
          <span style={{ ...S.badge, background: stateBadgeColor(st), color: '#fff' }}>{st}</span>
        )}
      </div>
      <div style={{ fontSize: 11, color: '#666', fontFamily: 'ui-monospace, monospace', marginTop: 4 }}>
        {resource.id && <div>id: {resource.id}</div>}
        {resource.type && <div>type: {resource.type}</div>}
        {resource.class && <div>class: {resource.class}</div>}
        {resource.engine && <div>engine: {resource.engine}</div>}
        {resource.runtime && <div>runtime: {resource.runtime}</div>}
        {resource.az && <div>az: {resource.az}</div>}
        {resource.public_ip && <div>public_ip: {resource.public_ip}</div>}
        {resource.creation_date && <div>created: {resource.creation_date}</div>}
        {resource.last_modified && <div>modified: {resource.last_modified}</div>}
      </div>
    </div>
  )
}

function MCPTelemetryCard({ msg }) {
  let data
  try { data = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content }
  catch { return <pre style={S.pre}>{String(msg.content)}</pre> }

  const rows = [
    ['Provider', data.provider],
    ['Service', data.service],
    ['Operation', data.operation],
    ['Resource ID', data.instance_id || data.db_instance_identifier || data.bucket_name || data.function_name],
    ['New State', data.state],
    ['Execution Mode', data.dry_run === true ? 'DRY RUN' : data.dry_run === false ? 'LIVE CLOUD' : '—'],
    ['AWS Request ID', data.request_id],
    ['AWS Error Code', data.aws_error_code],
    ['Error', data.error],
    ['Advisory', data.advisory],
    ['Lambda Status Code', data.status_code],
    ['Response Payload', data.response_payload],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '')

  return (
    <div style={{ border: '1px solid #ccc', borderRadius: 4, padding: 8, background: '#f9f9f9', marginBottom: 8 }}>
      <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center' }}>
        <b style={{ fontSize: 13 }}>MCP Cloud Telemetry</b>
        <span style={{
          ...S.badge,
          background: data.dry_run === false ? '#c8ecd4' : '#ffe0b2',
          color: data.dry_run === false ? '#083' : '#7a4a00',
        }}>
          {data.dry_run === false ? 'LIVE CLOUD' : 'DRY RUN'}
        </span>
      </div>
      <div style={S.kv}>
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <div style={S.kvKey}>{k}</div>
            <div style={{ wordBreak: 'break-all' }}>{String(v)}</div>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

// =============================================================================
// Main App
// =============================================================================
export default function App() {
  // ----- auth -----
  const [email, setEmail] = useState('alice@example.com')
  const [password, setPassword] = useState('hunter2hunter2')
  const [token, setToken] = useState(() => localStorage.getItem('airlock_token') || '')
  const [user, setUser] = useState(() => {
    const raw = localStorage.getItem('airlock_user')
    return raw ? JSON.parse(raw) : null
  })
  const [authMsg, setAuthMsg] = useState('')

  // ----- environments -----
  const [environments, setEnvironments] = useState([])
  const [selectedEnv, setSelectedEnv] = useState(null)
  const [newEnv, setNewEnv] = useState({ provider: 'AWS', alias: '', accessKey: '', secretKey: '' })
  const [showNewEnv, setShowNewEnv] = useState(false)

  // ----- resources -----
  const [resources, setResources] = useState(null)   // raw response
  const [activeTab, setActiveTab] = useState('ec2')
  const [resLoading, setResLoading] = useState(false)
  const [resErr, setResErr] = useState('')
  const [selectedResource, setSelectedResource] = useState(null)

  // ----- agent -----
  const [prompt, setPrompt] = useState('start it')
  const [threadId, setThreadId] = useState('')
  const [actionId, setActionId] = useState('')
  const [approvalStatus, setApprovalStatus] = useState('')
  const [interrupted, setInterrupted] = useState(false)
  const [lastMessage, setLastMessage] = useState('')
  const [messages, setMessages] = useState([])
  const [agentMsg, setAgentMsg] = useState('')
  const [invokeInFlight, setInvokeInFlight] = useState(false)
  const [resumeInFlight, setResumeInFlight] = useState(false)

  // ----- HITL -----
  const [pendingActions, setPendingActions] = useState([])
  const [eventLog, setEventLog] = useState([])
  const [socketConnected, setSocketConnected] = useState(false)

  const socketRef = useRef(null)

  // ---- localStorage persistence ----
  useEffect(() => {
    if (token && user) {
      localStorage.setItem('airlock_token', token)
      localStorage.setItem('airlock_user', JSON.stringify(user))
    } else {
      localStorage.removeItem('airlock_token')
      localStorage.removeItem('airlock_user')
    }
  }, [token, user])

  // ---- socket lifecycle ----
  useEffect(() => {
    if (!token) {
      if (socketRef.current) { socketRef.current.disconnect(); socketRef.current = null }
      setSocketConnected(false)
      return
    }
    const s = io(NODE, { auth: { token }, transports: ['websocket', 'polling'] })
    socketRef.current = s
    const log = (line) => setEventLog((l) => [...l, `[${new Date().toLocaleTimeString()}] ${line}`])

    s.on('connect', () => { setSocketConnected(true); log('socket connected') })
    s.on('disconnect', (r) => { setSocketConnected(false); log(`socket disconnected: ${r}`) })
    s.on('connect_error', (e) => { setSocketConnected(false); log(`socket error: ${e.message}`) })
    s.on('actionStateChanged', (a) => {
      log(`actionStateChanged: ${a.id} -> ${a.status} (${a.toolName || '?'})`)
      if (token) api.listPendingActions(token).then((r) => setPendingActions(r.actions || [])).catch(() => {})
    })
    return () => s.disconnect()
  }, [token])

  // ---- initial load ----
  useEffect(() => {
    if (!token) return
    refreshEnvironments()
    refreshPending()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  // ---- auto-discover when selectedEnv changes ----
  useEffect(() => {
    if (token && selectedEnv) refreshResources()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEnv, token])

  // ==========================================================================
  // Data loaders
  // ==========================================================================
  async function refreshEnvironments() {
    try {
      const r = await api.listEnvironments(token)
      setEnvironments(r.environments || [])
      if (!selectedEnv && r.environments?.[0]) setSelectedEnv(r.environments[0])
    } catch (e) { console.error('listEnvironments', e) }
  }

  async function refreshPending() {
    try {
      const r = await api.listPendingActions(token)
      setPendingActions(r.actions || [])
    } catch (e) { console.error('listPendingActions', e) }
  }

  async function refreshResources() {
    if (!token || !selectedEnv) return
    setResLoading(true); setResErr('')
    try {
      const envId = selectedEnv.id || selectedEnv._id
      const r = await api.discoverResources(token, envId)
      setResources(r)
    } catch (e) {
      setResErr(e.body?.error || e.message)
      setResources(null)
    } finally { setResLoading(false) }
  }

  async function loadThreadState(tid) {
    try {
      const r = await api.getThreadState(tid)
      setMessages(r.values?.messages || [])
      setInterrupted(Array.isArray(r.next) && r.next.length > 0)
      if (r.values?.approval_status) setApprovalStatus(r.values.approval_status)
    } catch (e) { console.error('getState', e) }
  }

  // ==========================================================================
  // Auth handlers
  // ==========================================================================
  async function handleLogin() {
    setAuthMsg('')
    try {
      const r = await api.login(email, password)
      setToken(r.token); setUser(r.user); setAuthMsg(`logged in as ${r.user.email}`)
    } catch (e) { setAuthMsg(`login failed: ${e.body?.error || e.message}`) }
  }

  async function handleRegister() {
    setAuthMsg('')
    try {
      const r = await api.register(email, password)
      setToken(r.token); setUser(r.user); setAuthMsg(`registered as ${r.user.email}`)
    } catch (e) { setAuthMsg(`register failed: ${e.body?.error || e.message}`) }
  }

  function handleLogout() {
    setToken(''); setUser(null)
    setEnvironments([]); setSelectedEnv(null); setResources(null); setSelectedResource(null)
    setThreadId(''); setActionId(''); setMessages([]); setPendingActions([]); setEventLog([])
    setAuthMsg(''); setAgentMsg('')
  }

  // ==========================================================================
  // Environment handlers
  // ==========================================================================
  async function handleCreateEnv() {
    try {
      await api.createEnvironment(token, newEnv)
      setNewEnv({ provider: 'AWS', alias: '', accessKey: '', secretKey: '' })
      setShowNewEnv(false)
      await refreshEnvironments()
    } catch (e) { alert(`create env failed: ${e.body?.error || e.message}`) }
  }

  // ==========================================================================
  // Agent handlers
  // ==========================================================================
  function buildPromptWithTarget(base, res) {
    if (!res) return base
    if (base.includes(res.id)) return base
    const stateStr = res.state || 'unknown'
    return `${base} [Target ${res.kind}: id=${res.id}, name=${res.name || ''}, current_state=${stateStr}]`
  }

  async function handleSendPrompt() {
    setAgentMsg('')
    if (!selectedEnv) { setAgentMsg('select an environment first'); return }
    const envId = selectedEnv.id || selectedEnv._id
    const outgoing = buildPromptWithTarget(prompt, selectedResource)

    setInvokeInFlight(true)
    setThreadId(''); setActionId(''); setApprovalStatus(''); setInterrupted(false)
    setMessages([]); setLastMessage('')
    try {
      const r = await api.invokeAgent(token, outgoing, envId)
      setThreadId(r.thread_id || '')
      setActionId(r.action_id || '')
      setApprovalStatus(r.approval_status || '')
      setInterrupted(!!r.interrupted)
      setLastMessage(r.message || '')
      if (r.thread_id) await loadThreadState(r.thread_id)
      await refreshPending()
    } catch (e) {
      setAgentMsg(`invoke failed: ${e.body?.detail || e.body?.error || e.message}`)
    } finally {
      setInvokeInFlight(false)
    }
  }

  async function handleResume(status) {
    if (!threadId) return
    setResumeInFlight(true)
    try {
      const r = await api.resumeAgent(token, threadId, status)
      setApprovalStatus(r.approval_status || '')
      setInterrupted(!!r.interrupted)
      setLastMessage(r.message || '')
      await loadThreadState(threadId)
      await refreshPending()
      // After live execution, refresh inventory so card state updates
      await refreshResources()
    } catch (e) {
      setAgentMsg(`resume failed: ${e.body?.detail || e.body?.error || e.message}`)
    } finally {
      setResumeInFlight(false)
    }
  }

  function quickAction(verb, resource) {
    setSelectedResource(resource)
    setPrompt(`${verb} it`)
  }

  // ==========================================================================
  // Derived
  // ==========================================================================
  const hasToolResult = useMemo(
    () => messages.some((m) => m.type === 'tool'),
    [messages]
  )

  const proposedTool = useMemo(() => {
    // Prefer the AI message's tool_calls; fallback to pending actions
    const ai = [...messages].reverse().find((m) => m.type === 'ai' && m.tool_calls?.length)
    if (ai) return { name: ai.tool_calls[0].name, args: ai.tool_calls[0].args || {} }
    const p = pendingActions.find((a) => a.id === actionId)
    if (p) return { name: p.toolName, args: p.parameters || {} }
    return null
  }, [messages, pendingActions, actionId])

  const resourceCounts = useMemo(() => {
    const r = resources?.resources || {}
    return {
      ec2: r.ec2_instances?.length || 0,
      rds: r.rds_instances?.length || 0,
      s3: r.s3_buckets?.length || 0,
      lambda: r.lambda_functions?.length || 0,
    }
  }, [resources])

  const isCreatingEC2 = proposedTool?.name === 'create_ec2_instance' ||
    String(prompt).toLowerCase().includes('create ec2') ||
    String(prompt).toLowerCase().includes('create a new ec2')

  // ==========================================================================
  // Render
  // ==========================================================================
  return (
    <div style={S.page}>
      <h1 style={{ marginTop: 0 }}>MultiMesh Airlock</h1>

      {/* 1. AUTH + ENV BAR */}
      <Section
        title="1. Auth & Environment Vault"
        right={user && <span style={{ fontSize: 12, color: socketConnected ? '#2a2' : '#a33' }}>
          ● socket {socketConnected ? 'connected' : 'disconnected'}
        </span>}
      >
        {user ? (
          <div>
            <div style={S.row}>
              <span>Signed in as <b>{user.email}</b></span>
              <button style={S.btn} onClick={handleLogout}>Logout</button>
            </div>

            <div style={S.row}>
              <label><b>Active Environment:</b></label>
              <select
                style={S.input}
                value={selectedEnv?.id || ''}
                onChange={(e) => {
                  const env = environments.find((x) => x.id === e.target.value)
                  setSelectedEnv(env || null)
                  setSelectedResource(null)
                }}
              >
                <option value="">— select —</option>
                {environments.map((env) => (
                  <option key={env.id} value={env.id}>{env.provider} — {env.alias}</option>
                ))}
              </select>
              <button style={S.btn} onClick={() => setShowNewEnv((s) => !s)}>
                {showNewEnv ? 'Cancel' : '+ New Environment'}
              </button>
            </div>

            {showNewEnv && (
              <div style={{ borderTop: '1px dashed #ccc', paddingTop: 8, marginTop: 6 }}>
                <div style={S.row}>
                  <select style={S.input} value={newEnv.provider}
                    onChange={(e) => setNewEnv({ ...newEnv, provider: e.target.value })}>
                    <option>AWS</option><option>GCP</option><option>AZURE</option>
                  </select>
                  <input style={S.input} placeholder="alias" value={newEnv.alias}
                    onChange={(e) => setNewEnv({ ...newEnv, alias: e.target.value })} />
                  <input style={S.input} placeholder="accessKey (AKIA...)" value={newEnv.accessKey}
                    onChange={(e) => setNewEnv({ ...newEnv, accessKey: e.target.value })} />
                  <input style={{ ...S.input, width: 240 }} type="password" placeholder="secretKey"
                    value={newEnv.secretKey}
                    onChange={(e) => setNewEnv({ ...newEnv, secretKey: e.target.value })} />
                  <button style={S.btn} onClick={handleCreateEnv}
                    disabled={!newEnv.alias || !newEnv.accessKey || !newEnv.secretKey}>
                    Save
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div>
            <div style={S.row}>
              <input style={S.input} placeholder="email" value={email}
                onChange={(e) => setEmail(e.target.value)} />
              <input style={S.input} type="password" placeholder="password" value={password}
                onChange={(e) => setPassword(e.target.value)} />
              <button style={S.btnPrimary} onClick={handleLogin}>Login</button>
              <button style={S.btn} onClick={handleRegister}>Register</button>
            </div>
            {authMsg && <div style={{ fontSize: 12, color: authMsg.includes('failed') ? '#a33' : '#2a2' }}>{authMsg}</div>}
          </div>
        )}
      </Section>

      {user && (
        <>
          {/* 2. LIVE RESOURCE DISCOVERY */}
          <Section
            title="2. Live Cloud Resource Discovery"
            right={
              <div>
                <span style={{ marginRight: 8, fontSize: 12 }}>
                  {resLoading && '⏳ loading...'}
                  {resources && !resLoading && (
                    <>
                      <b>{resourceCounts.ec2}</b> EC2 · <b>{resourceCounts.rds}</b> RDS ·{' '}
                      <b>{resourceCounts.s3}</b> S3 · <b>{resourceCounts.lambda}</b> Lambda
                      {resources.dry_run ? ' · DRY RUN' : ' · LIVE'}
                    </>
                  )}
                </span>
                <button style={S.btn} onClick={refreshResources} disabled={!selectedEnv || resLoading}>
                  Refresh Inventory
                </button>
              </div>
            }
          >
            {!selectedEnv && <div style={{ color: '#666' }}>Select an environment above to discover its resources.</div>}
            {resErr && <div style={S.errorBox}>Discovery error: {resErr}</div>}

            {resources && (
              <>
                {/* IAM warnings */}
                {Object.entries(resources.errors || {}).length > 0 && (
                  <div style={S.infoBox}>
                    <b>Some services could not be queried (IAM permissions):</b>
                    <ul style={{ margin: '4px 0 0 16px' }}>
                      {Object.entries(resources.errors).map(([svc, msg]) => (
                        <li key={svc}><b>{svc}:</b> {msg}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Tabs */}
                <div style={S.tabs}>
                  {[
                    ['ec2', `EC2 (${resourceCounts.ec2})`],
                    ['rds', `RDS (${resourceCounts.rds})`],
                    ['s3', `S3 (${resourceCounts.s3})`],
                    ['lambda', `Lambda (${resourceCounts.lambda})`],
                  ].map(([k, label]) => (
                    <button key={k} style={activeTab === k ? S.tabActive : S.tab}
                      onClick={() => setActiveTab(k)}>{label}</button>
                  ))}
                </div>

                {/* Tab body */}
                {activeTab === 'ec2' && (
                  <div style={S.grid}>
                    {(resources.resources.ec2_instances || []).map((r) => {
                      const res = { kind: 'EC2', id: r.id, name: r.name || r.id, state: r.state, raw: r }
                      const selected = selectedResource?.kind === 'EC2' && selectedResource.id === r.id
                      return <ResourceCard key={r.id} resource={r} selected={selected}
                        onClick={() => setSelectedResource(res)} />
                    })}
                    {resourceCounts.ec2 === 0 && <div style={{ color: '#666' }}>No EC2 instances.</div>}
                  </div>
                )}

                {activeTab === 'rds' && (
                  <div style={S.grid}>
                    {(resources.resources.rds_instances || []).map((r) => {
                      const res = { kind: 'RDS', id: r.id, name: r.id, state: r.status, raw: r }
                      const selected = selectedResource?.kind === 'RDS' && selectedResource.id === r.id
                      return <ResourceCard key={r.id} resource={r} selected={selected}
                        onClick={() => setSelectedResource(res)} />
                    })}
                    {resourceCounts.rds === 0 && <div style={{ color: '#666' }}>No RDS instances.</div>}
                  </div>
                )}

                {activeTab === 's3' && (
                  <div style={S.grid}>
                    {(resources.resources.s3_buckets || []).map((r) => {
                      const res = { kind: 'S3', id: r.name, name: r.name, state: 'bucket', raw: r }
                      const selected = selectedResource?.kind === 'S3' && selectedResource.id === r.name
                      return <ResourceCard key={r.name} resource={r} selected={selected}
                        onClick={() => setSelectedResource(res)} />
                    })}
                    {resourceCounts.s3 === 0 && <div style={{ color: '#666' }}>No S3 buckets.</div>}
                  </div>
                )}

                {activeTab === 'lambda' && (
                  <div style={S.grid}>
                    {(resources.resources.lambda_functions || []).map((r) => {
                      const res = { kind: 'Lambda', id: r.name, name: r.name, state: r.state, raw: r }
                      const selected = selectedResource?.kind === 'Lambda' && selectedResource.id === r.name
                      return <ResourceCard key={r.name} resource={r} selected={selected}
                        onClick={() => setSelectedResource(res)} />
                    })}
                    {resourceCounts.lambda === 0 && <div style={{ color: '#666' }}>No Lambda functions.</div>}
                  </div>
                )}

                {/* Selected target bar */}
                {selectedResource && (
                  <div style={{ ...S.okBox, display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                    <div>
                      <b>Target:</b> {selectedResource.kind} · <code>{selectedResource.id}</code>
                      {selectedResource.name && selectedResource.name !== selectedResource.id && ` · ${selectedResource.name}`}
                      {selectedResource.state && ` · ${selectedResource.state}`}
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {selectedResource.kind === 'EC2' && (
                        <>
                          <button style={S.btn} onClick={() => quickAction('start', selectedResource)}>Start</button>
                          <button style={S.btn} onClick={() => quickAction('stop', selectedResource)}>Stop</button>
                          <button style={S.btn} onClick={() => quickAction('reboot', selectedResource)}>Reboot</button>
                          <button style={S.btnDanger} onClick={() => quickAction('terminate', selectedResource)}>Terminate</button>
                        </>
                      )}
                      {selectedResource.kind === 'RDS' && (
                        <>
                          <button style={S.btn} onClick={() => quickAction('start', selectedResource)}>Start</button>
                          <button style={S.btn} onClick={() => quickAction('stop', selectedResource)}>Stop</button>
                          <button style={S.btn} onClick={() => quickAction('restart', selectedResource)}>Reboot</button>
                        </>
                      )}
                      {selectedResource.kind === 'Lambda' && (
                        <button style={S.btn} onClick={() => quickAction('invoke', selectedResource)}>Invoke</button>
                      )}
                      <button style={S.btn} onClick={() => setSelectedResource(null)}>Clear Target</button>
                    </div>
                  </div>
                )}

                {/* Create new EC2 shortcut */}
                <div style={{ marginTop: 8 }}>
                  <button style={S.btn} onClick={() => { setSelectedResource(null); setPrompt('Create a new EC2 instance named airlock-ui-demo of type t3.micro') }}>
                    + Create New EC2 (t3.micro)
                  </button>
                </div>
              </>
            )}
          </Section>

          {/* 3. AGENT CONSOLE */}
          <Section title="3. LangGraph Agent Console">
            <PipelineStepper
              invokeInFlight={invokeInFlight}
              interrupted={interrupted}
              approvalStatus={approvalStatus}
              resumeInFlight={resumeInFlight}
              hasToolResult={hasToolResult}
            />

            {selectedResource && (
              <div style={{ ...S.infoBox, marginBottom: 8 }}>
                <b>Active target:</b> {selectedResource.kind} <code>{selectedResource.id}</code>
                {' '}— the ID will be auto-injected into your prompt.
              </div>
            )}

            <div style={S.row}>
              <input
                style={{ ...S.input, width: 640 }}
                placeholder='e.g. "start it", "stop it", "reboot this database"'
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSendPrompt() }}
              />
              <button style={S.btnPrimary} onClick={handleSendPrompt} disabled={!selectedEnv || invokeInFlight}>
                {invokeInFlight ? 'Sending...' : 'Send to Agent'}
              </button>
            </div>

            {agentMsg && <div style={S.errorBox}>{agentMsg}</div>}

            {/* EC2 creation advisory */}
            {isCreatingEC2 && (
              <div style={S.infoBox}>
                <b>Advisory:</b> Provisioning EC2 instances via the AWS Console or Terraform/IaC is
                recommended for custom VPC, Subnet, Security Group, and KeyPair setups. Approving this
                action will launch a default Free-Tier <code>t3.micro</code> Amazon Linux 2023 instance.
              </div>
            )}

            <div style={{ fontSize: 12, color: '#666', marginTop: 8 }}>
              <div>thread_id: <code>{threadId || '—'}</code></div>
              <div>action_id: <code>{actionId || '—'}</code></div>
              <div>approval_status: <code>{approvalStatus || '—'}</code></div>
              <div>interrupted: <code>{String(interrupted)}</code></div>
            </div>
          </Section>

          {/* 4. HITL APPROVAL */}
          <Section title="4. Human-in-the-Loop Airlock Gate">
            {interrupted && approvalStatus === 'PENDING' && proposedTool && (
              <div style={{ border: '2px solid #c90', background: '#fff8e1', padding: 12, borderRadius: 6, marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <b style={{ fontSize: 15 }}>Approval Required</b>
                  {(() => {
                    const r = classifyRisk(proposedTool.name)
                    return <span style={{ ...S.badge, background: r.bg, color: r.color }}>{r.level}</span>
                  })()}
                </div>

                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 12, color: '#666' }}>Proposed tool</div>
                  <code style={{ fontSize: 14, fontWeight: 600 }}>{proposedTool.name}</code>
                </div>

                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Target arguments</div>
                  <div style={S.kv}>
                    {Object.entries(proposedTool.args || {}).map(([k, v]) => (
                      <Fragment key={k}>
                        <div style={S.kvKey}>{k}</div>
                        <div style={{ wordBreak: 'break-all' }}>{String(v)}</div>
                      </Fragment>
                    ))}
                    {Object.keys(proposedTool.args || {}).length === 0 && (
                      <div style={{ gridColumn: '1 / -1', color: '#888' }}>(no arguments)</div>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={S.btnPrimary} onClick={() => handleResume('APPROVED')} disabled={resumeInFlight}>
                    {resumeInFlight ? 'Executing...' : '✓ APPROVE EXECUTION'}
                  </button>
                  <button style={S.btnDanger} onClick={() => handleResume('REJECTED')} disabled={resumeInFlight}>
                    ✕ REJECT
                  </button>
                </div>
              </div>
            )}

            {approvalStatus === 'APPROVED' && hasToolResult && (
              <div style={S.okBox}><b>Execution complete</b> — see telemetry below.</div>
            )}
            {approvalStatus === 'REJECTED' && (
              <div style={S.errorBox}><b>Action rejected</b> — no cloud API was called.</div>
            )}

            <div style={{ marginTop: 8, marginBottom: 8 }}>
              <b style={{ fontSize: 13 }}>Pending actions on Node:</b>
              {pendingActions.length === 0
                ? <span style={{ color: '#666', fontSize: 13 }}> (none)</span>
                : <ul style={{ margin: '4px 0 0 16px', fontSize: 12 }}>
                    {pendingActions.map((a) => (
                      <li key={a.id}><code>{a.id}</code> · {a.toolName} · [{a.status}]</li>
                    ))}
                  </ul>
              }
            </div>

            <div>
              <b style={{ fontSize: 13 }}>Live event log (socket.io):</b>
              <div style={{ ...S.log, marginTop: 4 }}>
                {eventLog.length === 0 ? '(no events yet)' : eventLog.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            </div>
          </Section>

          {/* 5. TELEMETRY */}
          <Section title="5. MCP Telemetry & Audit Timeline">
            {messages.length === 0 && <div style={{ color: '#666' }}>No agent run yet.</div>}

            {messages.map((m, i) => {
              if (m.type === 'tool') return <MCPTelemetryCard key={i} msg={m} />
              if (m.type === 'ai' && m.tool_calls?.length) {
                return (
                  <div key={i} style={{ fontSize: 12, color: '#444', marginBottom: 6 }}>
                    <b>LLM proposed:</b> {m.tool_calls.map((tc) => tc.name).join(', ')}
                  </div>
                )
              }
              if (m.type === 'ai' && m.content) {
                return (
                  <div key={i} style={{ ...S.infoBox, marginBottom: 6 }}>
                    <b>Assistant:</b> {typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}
                  </div>
                )
              }
              return null
            })}

            {lastMessage && messages.every((m) => m.type !== 'ai' || m.content !== lastMessage) && (
              <div style={{ ...S.infoBox, marginTop: 6 }}>
                <b>Latest:</b> {lastMessage}
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  )
}