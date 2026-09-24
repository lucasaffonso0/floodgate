import 'server-only'
import type { WriteMode } from '@/types'

// Deploy-time only (Helm configmap → env var), never a runtime toggle.
// Read fresh each call (cheap env lookup) rather than cached at module
// load, so tests can flip
// process.env.WRITE_MODE between cases without reimporting the module.
export function getWriteMode(): WriteMode {
  return process.env.WRITE_MODE === 'gitops' ? 'gitops' : 'direct'
}
