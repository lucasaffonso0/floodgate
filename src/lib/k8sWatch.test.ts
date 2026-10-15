import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const { __testing } = await import('./k8sWatch')

describe('asTyped', () => {
  it('turns a watch event object into the client-deserialized shape', () => {
    const raw = {
      metadata: { name: 'p', namespace: 'ns', creationTimestamp: '2026-01-01T00:00:00Z' },
      spec: { podSelector: {}, ingress: [{ from: [{ podSelector: { matchLabels: { app: 'a' } } }] }] },
    }
    const typed = __testing.asTyped('networkpolicies', raw as unknown as Parameters<typeof __testing.asTyped>[1]) as unknown as { metadata: { creationTimestamp: unknown }; spec: { ingress: Array<{ _from?: unknown; from?: unknown }> } }
    expect(typed.metadata.creationTimestamp).toBeInstanceOf(Date)
    expect(typed.spec.ingress[0]._from).toEqual([{ podSelector: { matchLabels: { app: 'a' } } }])
    expect(typed.spec.ingress[0].from).toBeUndefined()
    expect(raw.metadata.creationTimestamp).toBe('2026-01-01T00:00:00Z') // input left untouched
  })

  it('leaves objects from the initial (already deserialized) list alone', () => {
    const listed = { metadata: { name: 'p', creationTimestamp: new Date() } }
    expect(__testing.asTyped('services', listed as Parameters<typeof __testing.asTyped>[1])).toBe(listed)
  })
})
