import { checkTrafficImpact } from './client'
import { impactMessage } from '@/lib/impactSummary'
import type { Draft } from '@/types'

// Asks before applying a change that can cut traffic, outside Modo Rascunho:
// the server checks the change (described as the drafts Modo Rascunho would
// stage) against what Descoberta has seen. Resolves true to go ahead.
// - Something observed would break, history is short, Descoberta is off, or
//   the check failed: a confirm() saying so.
// - Nothing to report: true without asking, unless the action already had a
//   question of its own (`base`), which is then asked with the impact added.
// Never blocks the action: it's always the user's call.
export async function confirmTrafficImpact(action: string, drafts: Array<Omit<Draft, 'id'>>, base?: string): Promise<boolean> {
  const impact = await checkTrafficImpact(drafts).catch(() => null)
  const message = impactMessage(action, impact, new Date(), base)
  return message === null ? true : window.confirm(message)
}

const EMPTY_CONNECTION = { src_workload: '', src_namespace: '', dst_service: '', dst_namespace: '', dst_ports: [] }

// The change "delete these policies", as a draft.
export function removeDraft(namespace: string, names: string[]): Omit<Draft, 'id'> {
  return { ...EMPTY_CONNECTION, kind: 'remove', remove_namespace: namespace, remove_policy_names: names, policy_direction: 'both' }
}
