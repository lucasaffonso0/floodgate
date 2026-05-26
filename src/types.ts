export interface ServiceInfo {
  name: string
  namespace: string
  selector: Record<string, string>
  ports: Array<{ port: number; target_port: number; protocol: string }>
  cluster_ip?: string
}

export interface NetworkPolicyInfo {
  name: string
  namespace: string
  src_workload: string
  src_namespace: string
  dst_service: string
  dst_port: number
  dst_ports: PortSpec[]
  policy_type: 'allow' | 'allow-egress' | 'allow-namespace' | 'allow-intranamespace' | 'restrict-ingress' | 'restrict-egress' | 'cidr-ingress' | 'cidr-egress' | 'external'
  managed: boolean
  adopted?: boolean
  policy_types: string[]
  pod_selector: Record<string, string>
  ingress_count: number
  egress_count: number
  created_at?: string
}

export interface PortSpec {
  port: number
  protocol: 'TCP' | 'UDP' | 'SCTP'
}

export interface CreatePolicyRequest {
  src_workload: string
  src_namespace: string
  dst_service: string
  dst_namespace: string
  dst_ports: PortSpec[]
}

export interface NamespaceIngressRequest {
  src_namespace: string
  dst_service: string
  dst_namespace: string
  dst_port: number
}

export interface RestrictPolicyRequest {
  service_name: string
  namespace: string
  direction: 'ingress' | 'egress'
}

export interface IsolateNamespaceRequest {
  namespace: string
  direction: 'ingress' | 'egress' | 'both'
  allow_intra_namespace: boolean
  allow_egress_internet: boolean
}

export interface Draft {
  id: string
  src_workload: string
  src_namespace: string
  dst_service: string
  dst_namespace: string
  dst_ports: PortSpec[]
  policy_direction: 'ingress' | 'egress' | 'both'
  src_cidr?: string
  dst_cidr?: string
  cidr_except?: string[]
}

export interface CidrPolicyRequest {
  namespace: string
  service_name?: string
  cidr: string
  except?: string[]
  dst_ports?: PortSpec[]
  direction: 'ingress' | 'egress'
}

export interface AppConfig {
  watched_namespaces: string[]
  ignored_namespaces: string[]
  approval_enabled: boolean
  approval_required_count: number
  approval_default_approvers: Array<{ id: string; username: string }>
  auto_default_deny_enabled: boolean
  auto_default_deny_direction: 'ingress' | 'egress' | 'both'
  autosync_enabled: boolean
  autosync_interval_s: number
  hubble_discovery_enabled: boolean
  hubble_flow_retention_days: number
}

export interface CiliumFlowSummary {
  id: string
  src_workload: string
  src_namespace: string
  dst_workload: string
  dst_namespace: string
  dst_port: number
  protocol: 'TCP' | 'UDP'
  verdict: 'FORWARDED' | 'DROPPED' | 'AUDIT'
  flow_count: number
  has_policy: boolean
  first_seen: string
  last_seen: string
}

export interface CiliumFlowsResponse {
  available: boolean
  streaming: boolean
  flows: CiliumFlowSummary[]
}

export interface AutosyncStatus {
  enabled: boolean
  interval_s: number
  desired_count: number
  drift: { missing: Array<{ namespace: string; name: string; policy_yaml?: string }>; timestamp: string } | null
  last_result: {
    checked: number
    fixed: number
    seeded: number
    drifted: Array<{ namespace: string; name: string }>
    timestamp: string
  } | null
}

export interface User {
  id: string
  username: string
  role: 'admin' | 'ns_admin' | 'viewer' | 'audit'
  allowed_namespaces: string[]
  must_change_password?: boolean
  created_at: string
}

export interface AuditLog {
  id: string
  username: string
  action: string
  resource_type: string
  resource_name: string
  namespace: string
  details: string
  created_at: string
}

export interface ApprovalRequest {
  id: string
  created_by: string
  created_by_username: string
  draft_data: Omit<Draft, 'id'>
  status: 'pending' | 'rejected' | 'applied'
  approvals_required: number
  approve_count: number
  reject_count: number
  allowed_approvers: Array<{ id: string; username: string }>
  votes: ApprovalVote[]
  created_at: string
  applied_at: string | null
  auto_apply_error?: string | null
}

export interface ApprovalVote {
  id: string
  request_id: string
  username: string
  decision: 'approve' | 'reject'
  comment: string
  created_at: string
}

export interface SecurityCoverage {
  namespace: string
  service_count: number
  has_deny_ingress: boolean
  has_deny_egress: boolean
  managed_policy_count: number
}

export interface NamespacePermission {
  id: string
  user_id: string
  username: string
  namespace: string
  created_at: string
}

export interface ServiceLayout {
  id: string
  namespace: string
  service_name: string
  x: number
  y: number
  locked: boolean
  updated_by: string
  updated_at: string
}
