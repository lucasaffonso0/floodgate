// Minimal "--key value" / "--flag" parser shared by the perf scripts, so they
// stay dependency-free. Unknown keys are accepted; defaults fill the rest.
export function parseArgs(defaults = {}) {
  const out = { ...defaults }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i++
    }
  }
  return out
}
