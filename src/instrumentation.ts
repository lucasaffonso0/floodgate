// Starts the background scheduler (Hubble flow discovery, autosync, backup)
// as soon as the server boots, instead of waiting for someone to open the
// app. In production the K8s probes already hit /api/health within
// seconds; under `make dev` nothing did until the first page load.
//
// It pings /api/health (which imports the scheduler) rather than importing
// the scheduler here: instrumentation is compiled into its own bundle, so a
// direct import would run a second copy of every module (separate SSE
// client set and caches from the ones the routes use), and 'server-only'
// can't be imported from this bundle at all.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const url = `http://127.0.0.1:${process.env.PORT ?? '3000'}/api/health`
  const ping = async (attempt: number): Promise<void> => {
    try {
      if ((await fetch(url)).ok) return
    } catch { /* server not listening yet */ }
    if (attempt < 60) setTimeout(() => { void ping(attempt + 1) }, 1000)
  }
  setTimeout(() => { void ping(0) }, 1000)
}
