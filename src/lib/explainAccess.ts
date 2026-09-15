import { NetworkPolicyInfo } from '@/types'

export type ExplainScope = 'service' | 'namespace' | 'both' | 'none'

export interface PolicyRef {
  name: string
  namespace: string
  policy_type: NetworkPolicyInfo['policy_type']
}

export type ExceptionKind = 'allow' | 'allow-namespace' | 'allow-egress' | 'allow-intranamespace' | 'cidr-ingress' | 'cidr-egress'

export interface ExplainExceptionEntry {
  kind: ExceptionKind
  policy: PolicyRef
  label: string
  scope: 'service' | 'namespace'
}

export interface ExplainResult {
  blocked: boolean
  scope: ExplainScope
  serviceRestrict?: PolicyRef
  namespaceRestrict?: PolicyRef
  exceptions: ExplainExceptionEntry[]
  headline: string
  detail: string[]
}

function toRef(p: NetworkPolicyInfo): PolicyRef {
  return { name: p.name, namespace: p.namespace, policy_type: p.policy_type }
}

const KIND_LABEL: Record<ExceptionKind, string> = {
  'allow': 'regra allow',
  'allow-namespace': 'allow de namespace',
  'allow-egress': 'regra allow',
  'allow-intranamespace': 'allow intra-namespace',
  'cidr-ingress': 'CIDR',
  'cidr-egress': 'CIDR',
}

export function explainAccess(
  name: string, ns: string,
  direction: 'ingress' | 'egress',
  policies: NetworkPolicyInfo[],
): ExplainResult {
  const restrictType = direction === 'ingress' ? 'restrict-ingress' : 'restrict-egress'

  const serviceRestrictPolicy = policies.find(p =>
    p.policy_type === restrictType && p.namespace === ns && p.dst_service === name)
  const namespaceRestrictPolicy = policies.find(p =>
    p.policy_type === restrictType && p.namespace === ns && p.dst_service === '')

  const exceptions: ExplainExceptionEntry[] = []

  if (direction === 'ingress') {
    for (const p of policies) {
      if ((p.policy_type === 'allow' || p.policy_type === 'allow-namespace') && p.namespace === ns && p.dst_service === name) {
        const label = p.policy_type === 'allow-namespace'
          ? `todo o namespace ${p.src_namespace}`
          : `${p.src_workload} (${p.src_namespace})`
        exceptions.push({ kind: p.policy_type, policy: toRef(p), label, scope: 'service' })
      }
      if (p.policy_type === 'cidr-ingress' && p.namespace === ns && (p.dst_service === name || p.dst_service === '')) {
        exceptions.push({ kind: 'cidr-ingress', policy: toRef(p), label: p.name, scope: p.dst_service === '' ? 'namespace' : 'service' })
      }
      if (p.policy_type === 'allow-intranamespace' && p.namespace === ns && p.policy_types.includes('Ingress')) {
        exceptions.push({ kind: 'allow-intranamespace', policy: toRef(p), label: 'pods do mesmo namespace', scope: 'namespace' })
      }
    }
  } else {
    for (const p of policies) {
      if (p.policy_type === 'allow-egress' && p.src_workload === name && p.src_namespace === ns) {
        exceptions.push({ kind: 'allow-egress', policy: toRef(p), label: `${p.dst_service} (${p.namespace})`, scope: 'service' })
      }
      if (p.policy_type === 'allow-egress' && p.src_workload === '' && p.namespace === ns) {
        exceptions.push({ kind: 'allow-egress', policy: toRef(p), label: p.dst_service || 'internet', scope: 'namespace' })
      }
      if (p.policy_type === 'cidr-egress' && p.namespace === ns && (p.dst_service === name || p.dst_service === '')) {
        exceptions.push({ kind: 'cidr-egress', policy: toRef(p), label: p.name, scope: p.dst_service === '' ? 'namespace' : 'service' })
      }
      if (p.policy_type === 'allow-intranamespace' && p.namespace === ns && p.policy_types.includes('Egress')) {
        exceptions.push({ kind: 'allow-intranamespace', policy: toRef(p), label: 'pods do mesmo namespace', scope: 'namespace' })
      }
    }
  }

  const scope: ExplainScope = serviceRestrictPolicy && namespaceRestrictPolicy
    ? 'both'
    : serviceRestrictPolicy ? 'service' : namespaceRestrictPolicy ? 'namespace' : 'none'

  const blocked = !!serviceRestrictPolicy || !!namespaceRestrictPolicy || exceptions.length > 0

  const { headline, detail } = buildNarrative(ns, scope, blocked, exceptions, serviceRestrictPolicy, namespaceRestrictPolicy)

  return {
    blocked,
    scope,
    serviceRestrict: serviceRestrictPolicy ? toRef(serviceRestrictPolicy) : undefined,
    namespaceRestrict: namespaceRestrictPolicy ? toRef(namespaceRestrictPolicy) : undefined,
    exceptions,
    headline,
    detail,
  }
}

function exceptionLines(exceptions: ExplainExceptionEntry[]): string[] {
  if (exceptions.length === 0) return []
  return exceptions.map(e => `${e.label} via ${KIND_LABEL[e.kind]} (${e.policy.name})`)
}

function buildNarrative(
  ns: string,
  scope: ExplainScope,
  blocked: boolean,
  exceptions: ExplainExceptionEntry[],
  serviceRestrictPolicy: NetworkPolicyInfo | undefined,
  namespaceRestrictPolicy: NetworkPolicyInfo | undefined,
): { headline: string; detail: string[] } {
  if (scope === 'none' && !blocked) {
    return { headline: 'Aberto: nenhuma restrição de rede nesta direção.', detail: [] }
  }

  if (scope === 'none' && blocked) {
    return {
      headline: 'Bloqueado implicitamente por regra(s) allow',
      detail: [
        'Não existe uma policy de restrict explícita, mas o Kubernetes já aplica default-deny quando alguma allow seleciona o pod.',
        ...exceptionLines(exceptions),
      ],
    }
  }

  if (scope === 'service') {
    return {
      headline: `Bloqueado por uma policy própria deste serviço (${serviceRestrictPolicy!.name})`,
      detail: exceptions.length > 0
        ? exceptionLines(exceptions)
        : ['Nenhuma exceção configurada: bloqueio total nesta direção.'],
    }
  }

  if (scope === 'namespace') {
    return {
      headline: `Bloqueado porque o namespace inteiro "${ns}" está isolado (${namespaceRestrictPolicy!.name}), não é algo configurado neste serviço`,
      detail: exceptions.length > 0
        ? exceptionLines(exceptions)
        : ['Nenhuma exceção: este serviço herda o bloqueio do namespace.'],
    }
  }

  // scope === 'both'
  return {
    headline: `Bloqueado nos dois níveis: policy própria do serviço (${serviceRestrictPolicy!.name}) E isolamento do namespace "${ns}" (${namespaceRestrictPolicy!.name})`,
    detail: [
      'A policy do serviço é redundante: o isolamento do namespace já cobre este serviço.',
      ...exceptionLines(exceptions),
    ],
  }
}
