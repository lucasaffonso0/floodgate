import axios from 'axios'
import type {
  ServiceInfo, NetworkPolicyInfo, CreatePolicyRequest, NamespaceIngressRequest,
  PortSpec, AppConfig, User, AuditLog, ApprovalRequest, SecurityCoverage, NamespacePermission,
  ServiceLayout, AutosyncStatus, CiliumFlowsResponse, CiliumFlowSummary, CidrPolicyRequest,
} from '@/types'

const api = axios.create({ baseURL: '/api' })

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401 && typeof window !== 'undefined') {
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

// ── Services & Policies ────────────────────────────────────────────────────
export const getServices = (): Promise<ServiceInfo[]> =>
  api.get('/services').then(r => r.data)

export const getNetworkPolicies = (): Promise<NetworkPolicyInfo[]> =>
  api.get('/networkpolicies').then(r => r.data)

export const getAllNetworkPolicies = (): Promise<NetworkPolicyInfo[]> =>
  api.get('/networkpolicies?all=true').then(r => r.data)

export const createNetworkPolicy = (req: CreatePolicyRequest): Promise<NetworkPolicyInfo> =>
  api.post('/networkpolicies', req).then(r => r.data)

export const createEgressNetworkPolicy = (req: CreatePolicyRequest): Promise<NetworkPolicyInfo> =>
  api.post('/networkpolicies/egress', req).then(r => r.data)

export const createNamespaceIngressPolicy = (req: NamespaceIngressRequest): Promise<NetworkPolicyInfo> =>
  api.post('/networkpolicies/namespace-ingress', req).then(r => r.data)

export const deleteNetworkPolicy = (namespace: string, name: string): Promise<void> =>
  api.delete(`/networkpolicies/${namespace}/${name}`)

export const patchNetworkPolicyPort = (namespace: string, name: string, dst_ports: PortSpec[]): Promise<NetworkPolicyInfo> =>
  api.patch(`/networkpolicies/${namespace}/${name}`, { dst_ports }).then(r => r.data)

export const restrictService = (req: { service_name: string; namespace: string; direction: 'ingress' | 'egress' }): Promise<NetworkPolicyInfo> =>
  api.post('/networkpolicies/restrict', req).then(r => r.data)

export const createCidrPolicy = (req: CidrPolicyRequest): Promise<NetworkPolicyInfo> =>
  api.post('/networkpolicies/cidr', req).then(r => r.data)

// ── Config ─────────────────────────────────────────────────────────────────
export const getConfig = (): Promise<AppConfig> =>
  api.get('/config').then(r => r.data)

export const updateConfig = (cfg: AppConfig): Promise<AppConfig> =>
  api.put('/config', cfg).then(r => r.data)

// ── Auth & Users ───────────────────────────────────────────────────────────
export const getMe = (): Promise<User> =>
  api.get('/auth/me').then(r => r.data)

export const logout = (): Promise<void> =>
  api.post('/auth/logout')

export const listUsers = (): Promise<User[]> =>
  api.get('/users').then(r => r.data)

export const createUser = (u: { username: string; password: string; role: 'admin' | 'viewer' | 'audit' }): Promise<User> =>
  api.post('/users', u).then(r => r.data)

export const deleteUser = (id: string): Promise<void> =>
  api.delete(`/users/${id}`)

export const updateUserRole = (id: string, role: 'admin' | 'ns_admin' | 'viewer' | 'audit'): Promise<User> =>
  api.patch(`/users/${id}`, { role }).then(r => r.data)

export const updateUserPassword = (id: string, password: string, currentPassword?: string): Promise<User> =>
  api.patch(`/users/${id}`, { password, ...(currentPassword ? { current_password: currentPassword } : {}) }).then(r => r.data)

// ── Audit ──────────────────────────────────────────────────────────────────
export const getAuditLogs = (params?: { limit?: number; offset?: number; namespace?: string; action?: string }): Promise<{ logs: AuditLog[]; total: number }> =>
  api.get('/audit', { params }).then(r => r.data)

// ── Approval workflow ──────────────────────────────────────────────────────
export const getApprovalRequests = (status = 'pending'): Promise<ApprovalRequest[]> =>
  api.get('/approval-requests', { params: { status } }).then(r => r.data)

export const createApprovalRequest = (draft: object, allowedApprovers?: Array<{ id: string; username: string }>): Promise<ApprovalRequest> =>
  api.post('/approval-requests', { ...draft, allowed_approvers: allowedApprovers ?? [] }).then(r => r.data)

export const voteApprovalRequest = (id: string, decision: 'approve' | 'reject', comment?: string): Promise<ApprovalRequest> =>
  api.patch(`/approval-requests/${id}`, { action: 'vote', decision, comment }).then(r => r.data)

export const applyApprovalRequest = (id: string): Promise<ApprovalRequest> =>
  api.patch(`/approval-requests/${id}`, { action: 'apply' }).then(r => r.data)

export const cancelApprovalRequest = (id: string): Promise<void> =>
  api.delete(`/approval-requests/${id}`)

export const getApprovalRequestYAML = (id: string): Promise<string> =>
  api.get(`/approval-requests/${id}`, { params: { yaml: '1' } }).then(r => r.data)

// ── Security coverage ──────────────────────────────────────────────────────
export const getSecurityCoverage = (): Promise<SecurityCoverage[]> =>
  api.get('/security-coverage').then(r => r.data)

export const applyDefaultDeny = (namespace: string, direction: 'ingress' | 'egress' | 'both'): Promise<NetworkPolicyInfo[]> =>
  api.post('/security-coverage', { namespace, direction }).then(r => r.data)

export const isolateNamespace = (req: { namespace: string; direction: 'ingress' | 'egress' | 'both'; allow_intra_namespace: boolean; allow_egress_internet: boolean }): Promise<{ created: number; skipped: number }> =>
  api.post('/networkpolicies/namespace-isolate', req).then(r => r.data)

export const adoptPolicy = (namespace: string, name: string, policyType?: string): Promise<{ ok: boolean }> =>
  api.post('/networkpolicies/adopt', { namespace, name, policy_type: policyType }).then(r => r.data)

export const unadoptPolicy = (namespace: string, name: string): Promise<{ ok: boolean }> =>
  api.delete('/networkpolicies/adopt', { data: { namespace, name } }).then(r => r.data)

// ── Namespace permissions ──────────────────────────────────────────────────
export const getNamespacePermissions = (): Promise<NamespacePermission[]> =>
  api.get('/namespace-permissions').then(r => r.data)

export const grantNamespacePermission = (user_id: string, namespace: string): Promise<NamespacePermission> =>
  api.post('/namespace-permissions', { user_id, namespace }).then(r => r.data)

export const revokeNamespacePermission = (id: string): Promise<void> =>
  api.delete(`/namespace-permissions/${id}`)

// ── Pause / Resume all policies ────────────────────────────────────────────
export const getPausedPolicies = (): Promise<{ id: string; name: string; namespace: string; policy_yaml: string; saved_at: string }[]> =>
  api.get('/networkpolicies/pause').then(r => r.data)

export const pauseAllPolicies = (): Promise<{ paused: number }> =>
  api.post('/networkpolicies/pause').then(r => r.data)

export const pausePolicy = (namespace: string, name: string): Promise<{ paused: number }> =>
  api.post('/networkpolicies/pause', { namespace, name }).then(r => r.data)

export const resumeAllPolicies = (): Promise<{ resumed: number }> =>
  api.post('/networkpolicies/resume').then(r => r.data)

export const resumePolicy = (id: string): Promise<{ resumed: number }> =>
  api.post('/networkpolicies/resume', { id }).then(r => r.data)

// ── Service layout / namespace locks ──────────────────────────────────────
export const getServiceLayout = (): Promise<{
  layouts: ServiceLayout[]
  namespace_locks: Array<{ namespace: string; locked: boolean; x: number | null; y: number | null; updated_by: string; updated_at: string }>
  namespaces: string[]
  layout_meta: { saved_by: string; saved_at: string } | null
  global_locked: boolean
}> => api.get('/service-layout').then(r => r.data)

export const saveServicePosition = (req: { namespace: string; service_name: string; x: number; y: number }): Promise<ServiceLayout> =>
  api.post('/service-layout', req).then(r => r.data)

export const setNamespaceLayoutLock = (namespace: string, locked: boolean): Promise<{ updated: boolean }> =>
  api.patch('/service-layout', { scope: 'namespace', namespace, locked }).then(r => r.data)

export const setAllNamespacesLayoutLock = (locked: boolean): Promise<{ updated: boolean }> =>
  api.patch('/service-layout', { scope: 'all', locked }).then(r => r.data)

export const saveAllLayout = (data: {
  services: Array<{ namespace: string; service_name: string; x: number; y: number }>
  namespaces: Array<{ namespace: string; x: number; y: number }>
}): Promise<{ ok: boolean; saved_by: string; saved_at: string }> =>
  api.patch('/service-layout', { scope: 'save-all', ...data }).then(r => r.data)

export const setGlobalLayoutLock = (locked: boolean): Promise<{ ok: boolean; locked: boolean }> =>
  api.patch('/service-layout', { scope: 'global-lock', locked }).then(r => r.data)

// ── Autosync ───────────────────────────────────────────────────────────────
export const getAutosyncStatus = (): Promise<AutosyncStatus> =>
  api.get('/autosync').then(r => r.data)

export const triggerAutosync = (): Promise<AutosyncStatus['last_result']> =>
  api.post('/autosync').then(r => r.data)

// ── Cilium Auto-Discover ───────────────────────────────────────────────────
export const getCiliumFlows = (): Promise<CiliumFlowsResponse> =>
  api.get('/cilium/flows').then(r => r.data)

export const clearCiliumFlows = (): Promise<void> =>
  api.delete('/cilium/flows').then(() => undefined)

export const checkHubble = (): Promise<{ available: boolean }> =>
  api.get('/cilium/flows/check').then(r => r.data)

export const getNetworkPolicyYaml = (namespace: string, name: string): Promise<string> =>
  api.get(`/networkpolicies/${namespace}/${name}`, { headers: { Accept: 'application/yaml' } }).then(r => r.data)

export const previewDiscoveryPolicyYAML = (
  flow: CiliumFlowSummary,
  direction: 'ingress' | 'egress' | 'both' = 'ingress',
): Promise<string> =>
  api.post('/networkpolicies/preview', {
    src_workload: flow.src_workload,
    src_namespace: flow.src_namespace,
    dst_service: flow.dst_workload,
    dst_namespace: flow.dst_namespace,
    dst_ports: [{ port: flow.dst_port, protocol: flow.protocol }],
    direction,
  }, { responseType: 'text' }).then(r => r.data as string)
