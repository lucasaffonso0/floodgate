import 'server-only'
import simpleGit, { type SimpleGit } from 'simple-git'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'fs'
import { dirname, join, relative } from 'path'
import { UserFacingError } from './api-helpers'
import { getGitOpsConnection, hasGitOpsCredentials as hasGitOpsCredentialsFromConfig } from './gitopsConfig'

const LOCAL_REPO_PATH = '/data/gitops-repo'
const SSH_KEY_PATH = '/data/.ssh/gitops_key'
const SSH_KNOWN_HOSTS_PATH = '/data/.ssh/gitops_known_hosts'
const MAX_PUSH_ATTEMPTS = 5

// Without this, a git subprocess that hangs (unreachable host, no route, or
// firewall silently dropping packets, with no SSH ConnectTimeout set since
// that would apply to every read too, which is deliberately network-free
// now) never resolves or rejects. That means commitPolicyFilesTracked's
// finally (k8s-gitops.ts) never runs: the pending-op row stays "aplicando"
// forever AND withGitLock's mutex stays held forever, blocking every
// subsequent write, not just the hung one. A bounded timeout turns "stuck
// forever" into "fails with a clear error," which the caller already
// handles (UserFacingError paths throughout this file).
const GIT_OP_TIMEOUT_MS = 60_000

export interface GitFileOp { action: 'write' | 'delete'; path: string; content?: string }

// Everything the low-level engine below needs, explicit: no hidden global
// state, no reach-back into gitopsConfig.ts. Keeps clone/commit/push/rebase
// testable against a throwaway local bare repo with zero SSH/DB involved
// (sshKeyPath/knownHostsPath omitted → plain local-path remote, no
// GIT_SSH_COMMAND set at all).
export interface GitOpsRepoConfig {
  localPath: string
  repoUrl: string
  branch: string
  repoSubpath: string
  authorName: string
  authorEmail: string
  sshKeyPath?: string
  knownHostsPath?: string
  // Overrides GIT_OP_TIMEOUT_MS: tests only, so a hang can be exercised in
  // milliseconds instead of the real 60s default. Omitted in production
  // config (buildRealConfig never sets it).
  timeoutMsOverride?: number
}

function buildGitSshCommand(sshKeyPath: string, knownHostsPath?: string): string {
  const hostKeyOpts = knownHostsPath
    ? `-o UserKnownHostsFile=${knownHostsPath} -o StrictHostKeyChecking=yes`
    : `-o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=accept-new`
  return `ssh -i ${sshKeyPath} ${hostKeyOpts}`
}

// GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL) env vars, not `user.name`/`user.email`
// config: a fresh container's `node` user has no global gitconfig (unlike
// this dev machine, where a real developer identity is already configured
// and silently made every commit here succeed during testing, verified by
// checking `git config --global user.name` on this box before trusting
// this at all). Without an identity from somewhere, `git commit` fails
// outright with "Please tell me who you are".
// `--author` alone does NOT supply the separately-required committer
// identity. Setting all four via env means every git operation gets a
// valid identity with zero on-disk config, in direct mode or gitops.
function gitFor(cfg: GitOpsRepoConfig): SimpleGit {
  // simple-git 3.33+ blocks setting GIT_SSH_COMMAND by default (a
  // supply-chain-injection guard against untrusted input reaching env) and
  // throws "not permitted without enabling allowUnsafeSshCommand" the
  // moment any command runs: this value is our own trusted config, built
  // from buildGitSshCommand() below, never user-supplied shell text, so
  // opting in here is the correct, documented escape hatch, not a bypass
  // of anything actually unsafe. Caught late (git.test.ts never sets
  // sshKeyPath, so this path went unexercised until a real SSH key was
  // configured end-to-end against a live repo).
  const git = simpleGit({
    baseDir: cfg.localPath,
    unsafe: { allowUnsafeSshCommand: true },
    timeout: { block: cfg.timeoutMsOverride ?? GIT_OP_TIMEOUT_MS },
  })
  // One call, one object: two separate .env() calls risk the second
  // silently replacing the first instead of merging, depending on
  // simple-git's internal accumulation behavior; safer not to rely on it.
  git.env({
    GIT_AUTHOR_NAME: cfg.authorName, GIT_AUTHOR_EMAIL: cfg.authorEmail,
    GIT_COMMITTER_NAME: cfg.authorName, GIT_COMMITTER_EMAIL: cfg.authorEmail,
    ...(cfg.sshKeyPath ? { GIT_SSH_COMMAND: buildGitSshCommand(cfg.sshKeyPath, cfg.knownHostsPath) } : {}),
  })
  return git
}

// Clones on first use; otherwise fetch + hard-reset to origin/<branch> so
// every operation starts from a known-clean state, even if the pod
// restarted mid-write or someone poked the clone by hand. Only used ahead
// of a WRITE (commitPolicyFiles) and by testGitOpsConnection(): a write
// must never commit on top of a stale base, and the connection test is the
// one place that's supposed to actually probe the network. See
// ensureRepoCloned() below for the read path, which deliberately does not
// do this network round trip on every call.
async function ensureRepoReady(cfg: GitOpsRepoConfig): Promise<SimpleGit> {
  if (!existsSync(join(cfg.localPath, '.git'))) {
    mkdirSync(cfg.localPath, { recursive: true })
    const git = gitFor(cfg)
    await git.clone(cfg.repoUrl, cfg.localPath, ['--branch', cfg.branch, '--origin', 'origin'])
    return git
  }
  const git = gitFor(cfg)
  await git.fetch('origin', cfg.branch)
  await git.checkout(cfg.branch).catch(() => git.checkout(['-B', cfg.branch, `origin/${cfg.branch}`]))

  // A prior write can strand a real commit here: `git commit` succeeded
  // (HEAD moved) but the process was killed (OOM, pod reschedule) before
  // `git push` finished: the on-disk clone survives that on the PVC with
  // the commit still sitting as HEAD, ahead of origin. The reset --hard
  // below is what would otherwise discard it, silently, the next time
  // ANY write runs (not necessarily the one that stranded it), with
  // nothing left anywhere pointing out that a policy someone thought they
  // created actually never made it. Try to push it forward first; only
  // fall back to discarding it if that still doesn't succeed.
  const aheadCount = (await git.raw(['rev-list', '--count', `origin/${cfg.branch}..HEAD`]).catch(() => '0')).trim()
  if (aheadCount && aheadCount !== '0') {
    try {
      await git.push('origin', cfg.branch)
      console.log(`[gitops] ensureRepoReady: recovered and pushed ${aheadCount} commit(s) stranded by a prior interrupted write`)
    } catch (e) {
      console.error(`[gitops] ensureRepoReady: ${aheadCount} commit(s) stranded by a prior interrupted write could not be recovered (push still fails), discarding to stay in sync with origin:`, e)
    }
  }

  await git.reset(['--hard', `origin/${cfg.branch}`])
  return git
}

// Read path: clones on first use (unavoidable: nothing on disk yet), but
// once a local clone exists, reuses it as-is with no fetch/reset: no
// network round trip. GitOps connectivity is meant to be validated once, at
// configuration time (the panel's "Salvar conexão GitOps" already runs
// testGitOpsConnection(), which does the real ensureRepoReady() probe).
// Every read (GET /api/networkpolicies' sync_status merge, GET
// /api/autosync's drift check) used to call the fetch+reset version above
// on every single call: page.tsx polls both every 15s, so an unreachable
// or slow repo host meant every poll (including the dashboard's very first
// load) blocked on a live network round trip before anything rendered.
// The trade-off: sync_status/drift can lag behind the real repo state
// between writes (a write's own ensureRepoReady() call re-syncs first) or
// until the pod restarts: acceptable, since this is a display of
// "roughly where things stand," not the write path itself.
async function ensureRepoCloned(cfg: GitOpsRepoConfig): Promise<SimpleGit> {
  const git = gitFor(cfg)
  if (!existsSync(join(cfg.localPath, '.git'))) {
    mkdirSync(cfg.localPath, { recursive: true })
    await git.clone(cfg.repoUrl, cfg.localPath, ['--branch', cfg.branch, '--origin', 'origin'])
  }
  return git
}

function listFilesRecursive(dir: string, base: string = dir): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, base))
    else if (entry.isFile()) out.push(relative(base, full))
  }
  return out
}

function applyFileOps(cfg: GitOpsRepoConfig, ops: GitFileOp[]): string[] {
  const root = join(cfg.localPath, cfg.repoSubpath)
  const touched: string[] = []
  for (const op of ops) {
    const full = join(root, op.path)
    const relPath = join(cfg.repoSubpath, op.path)
    if (op.action === 'write') {
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, op.content ?? '', 'utf8')
    } else if (existsSync(full)) {
      rmSync(full)
    } else {
      continue // nothing to delete, no point staging it
    }
    touched.push(relPath)
  }
  return touched
}

// Commits, then pushes with up to MAX_PUSH_ATTEMPTS retries on a
// non-fast-forward rejection: fetch + rebase (linear history, not merge)
// and try again. floodgate is the only writer under the module-level
// mutex below, so a rejection should only ever happen if someone pushed to
// the repo by hand: a real rebase conflict aborts cleanly and surfaces as
// a clear error instead of silently dropping the write.
async function commitAndPush(cfg: GitOpsRepoConfig, git: SimpleGit, message: string): Promise<string> {
  const result = await git.commit(message, ['--author', `${cfg.authorName} <${cfg.authorEmail}>`])
  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    try {
      await git.push('origin', cfg.branch)
      return result.commit
    } catch (pushErr) {
      if (attempt === MAX_PUSH_ATTEMPTS) {
        throw new UserFacingError(
          `Falha ao enviar mudanças para o repositório GitOps após ${MAX_PUSH_ATTEMPTS} tentativas: ${(pushErr as Error).message}`,
          500,
        )
      }
      await git.fetch('origin', cfg.branch)
      try {
        await git.rebase([`origin/${cfg.branch}`])
      } catch (rebaseErr) {
        // rebase() throws for two very different reasons: an actual
        // content conflict (git leaves conflict markers and reports
        // conflicted paths), or a transient failure (SSH hiccup, the
        // GIT_OP_TIMEOUT_MS block-timeout firing mid-rebase, disk
        // pressure) that has nothing to do with conflicting content.
        // Only the first is real data to discard: resetting --hard on a
        // transient failure would throw away the commit this call just
        // made, over something that would likely succeed on a plain
        // retry. git.status().conflicted is how simple-git surfaces which
        // case this is.
        const status = await git.status().catch(() => null)
        const hasRealConflict = !!status && status.conflicted.length > 0
        await git.rebase(['--abort']).catch(() => {})
        if (!hasRealConflict) {
          // rebase --abort alone already restored HEAD to our own
          // un-rebased commit, nothing discarded. Whether that commit
          // survives long-term is ensureRepoReady()'s job (see its own
          // stranded-commit recovery attempt), not this retry loop's.
          throw new UserFacingError(
            `Falha temporária ao sincronizar com o repositório GitOps (não foi um conflito de conteúdo). Tente novamente. Detalhe: ${(rebaseErr as Error).message}`,
            500,
          )
        }
        await git.reset(['--hard', `origin/${cfg.branch}`])
        throw new UserFacingError(
          `Conflito real no repositório GitOps ao tentar aplicar a mudança: outra escrita concorrente no mesmo arquivo fora do floodgate. Detalhe: ${(rebaseErr as Error).message}`,
          500,
        )
      }
    }
  }
  // Unreachable (loop above always returns or throws), kept for type-narrowing.
  throw new UserFacingError('Falha ao enviar mudanças para o repositório GitOps.', 500)
}

// Serializes every repo operation within this process. Single-pod
// deployment is already an established premise elsewhere (see sse.ts):
// a promise-chain mutex is enough, no Redis/DB lock table needed.
let chain: Promise<unknown> = Promise.resolve()
function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

function buildRealConfig(): GitOpsRepoConfig {
  const conn = getGitOpsConnection()
  if (!conn.repo_url || !conn.ssh_private_key) {
    throw new UserFacingError('GitOps ativo, mas o repositório não foi configurado. Configure em Config → GitOps.', 503)
  }
  mkdirSync(dirname(SSH_KEY_PATH), { recursive: true })
  const key = conn.ssh_private_key.endsWith('\n') ? conn.ssh_private_key : conn.ssh_private_key + '\n'
  writeFileSync(SSH_KEY_PATH, key, { mode: 0o600 })
  if (conn.ssh_known_hosts) writeFileSync(SSH_KNOWN_HOSTS_PATH, conn.ssh_known_hosts, 'utf8')
  return {
    localPath: LOCAL_REPO_PATH,
    repoUrl: conn.repo_url,
    branch: conn.repo_branch || 'main',
    repoSubpath: conn.repo_path || 'policies',
    authorName: conn.commit_author_name || 'floodgate-bot',
    authorEmail: conn.commit_author_email || 'floodgate@localhost',
    sshKeyPath: SSH_KEY_PATH,
    knownHostsPath: conn.ssh_known_hosts ? SSH_KNOWN_HOSTS_PATH : undefined,
  }
}

export function hasGitOpsCredentials(): boolean {
  return hasGitOpsCredentialsFromConfig()
}

// Surfaces a clear, specific error for bad repo URL/branch/credentials
// right when the admin saves the connection in the panel, instead of only
// discovering it the next time someone tries to create a policy. Reuses
// ensureRepoReady() (clone on first use, fetch+reset otherwise): cheap
// enough to run on every save, and idempotent against a repo that's
// already cloned and healthy.
export async function testGitOpsConnection(): Promise<{ ok: true } | { ok: false; error: string }> {
  return withGitLock(async () => {
    try {
      const cfg = buildRealConfig()
      await ensureRepoReady(cfg)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

// path (relative to repoSubpath) -> name of the author of the most recent
// commit that touched it. Populated only by refreshRepoInBackground()
// below (git log is only meaningful right after a fresh fetch+reset):
// reads never call this themselves, so this is the one place answering
// "who last touched this file" without adding cost to every request.
let _lastCommitAuthors = new Map<string, string>()

export function getLastKnownCommitAuthors(): Map<string, string> {
  return _lastCommitAuthors
}

// One git-log call, not one per file: --name-only lists every path each
// commit touched right after that commit's own header line, newest commit
// first, so the FIRST time a path is seen while walking top-to-bottom is
// its most recent author. \x01 is a delimiter unlikely to appear in a real
// author name, marking each commit's header line unambiguously from the
// path lines that follow it.
async function computeLastCommitAuthors(cfg: GitOpsRepoConfig, git: SimpleGit): Promise<Map<string, string>> {
  const raw = await git.raw(['log', '--name-only', '--pretty=format:%x01%an', '--', cfg.repoSubpath])
  const authors = new Map<string, string>()
  let currentAuthor: string | null = null
  const prefix = `${cfg.repoSubpath}/`
  for (const line of raw.split('\n')) {
    if (line.startsWith('\x01')) { currentAuthor = line.slice(1); continue }
    if (!line.trim() || currentAuthor === null) continue
    const rel = line.startsWith(prefix) ? line.slice(prefix.length) : line
    if (!authors.has(rel)) authors.set(rel, currentAuthor)
  }
  return authors
}

// Reads (ensureRepoCloned, above) never fetch on their own: the only
// thing keeping the read-side view of the repo (and sync_status computed
// from it) from drifting forever when someone edits the repo outside
// floodgate is this: a periodic background refresh, driven by
// scheduler.ts on its own longer interval, never by an individual
// request. Shares withGitLock with real writes, so it queues behind one
// in progress rather than racing it, and a stale/unreachable repo just
// logs and leaves the last-known state in place (same graceful-degradation
// stance the read functions already take) instead of throwing somewhere
// nothing is watching for it.
// Return value lets a manual trigger (POST /api/gitops-config/sync, the
// "Sincronizar agora" button) report success/failure to the admin who
// clicked it; the scheduler's own fire-and-forget call to this (every
// GIT_BACKGROUND_REFRESH_MS) just ignores it, same as before.
export async function refreshRepoInBackground(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!hasGitOpsCredentialsFromConfig()) return { ok: false, error: 'GitOps não configurado' }
  return withGitLock(async () => {
    try {
      const cfg = buildRealConfig()
      const git = await ensureRepoReady(cfg)
      _lastCommitAuthors = await computeLastCommitAuthors(cfg, git)
      return { ok: true }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error('[gitops] refreshRepoInBackground: falha ao atualizar o clone local em segundo plano:', e)
      return { ok: false, error }
    }
  })
}

// An idempotent retry (e.g. isolating a namespace that's already isolated)
// can rewrite a file back to byte-identical content: `git add` then stages
// nothing, and committing would fail with "nothing to commit" instead of
// the graceful no-op direct mode gets from a 409. Mirror that: treat
// "nothing actually changed" as success, not an error.
async function addAndCommitIfChanged(cfg: GitOpsRepoConfig, git: SimpleGit, touched: string[], commitMessage: string): Promise<string> {
  if (touched.length === 0) return (await git.revparse(['HEAD'])).trim()
  await git.add(touched)
  const status = await git.status()
  if (status.staged.length === 0) return (await git.revparse(['HEAD'])).trim()
  return commitAndPush(cfg, git, commitMessage)
}

export async function commitPolicyFiles(ops: GitFileOp[], commitMessage: string): Promise<{ commit: string }> {
  return withGitLock(async () => {
    const cfg = buildRealConfig()
    const git = await ensureRepoReady(cfg)
    const touched = applyFileOps(cfg, ops)
    const commit = await addAndCommitIfChanged(cfg, git, touched, commitMessage)
    return { commit }
  })
}

// NOT wrapped in withGitLock: that lock is for writes only (see the
// comment on withGitLock's definition above). This was the actual bug
// behind reports of the whole dashboard blanking out for several seconds
// after applying/removing a policy in GitOps mode: this function LOOKED
// separated from the write lock (ensureRepoCloned instead of
// ensureRepoReady, no fetch) but was still wrapped in the exact same
// withGitLock queue, so it kept waiting for an in-flight commit+push
// (several real seconds over SSH) before returning anything at all;
// confirmed live: a GET fired 0.3s after a DELETE returned in ~4.5s,
// matching the DELETE's own ~4.8s almost exactly.
export async function readPolicyFile(path: string): Promise<string | null> {
  const cfg = buildRealConfig()
  await ensureRepoCloned(cfg)
  const full = join(cfg.localPath, cfg.repoSubpath, path)
  return existsSync(full) ? readFileSync(full, 'utf8') : null
}

export async function listPolicyFiles(): Promise<string[]> {
  const cfg = buildRealConfig()
  await ensureRepoCloned(cfg)
  return listFilesRecursive(join(cfg.localPath, cfg.repoSubpath))
}

// listPolicyFiles() + readPolicyFile() per path, done one at a time, would
// mean one ensureRepoCloned() call per file: harmless once cloned (no
// network), but still redundant work. Read everything already on disk
// locally in one pass instead.
export async function listPolicyFilesWithContent(): Promise<Array<{ path: string; content: string }>> {
  const cfg = buildRealConfig()
  await ensureRepoCloned(cfg)
  const root = join(cfg.localPath, cfg.repoSubpath)
  return listFilesRecursive(root).map(path => ({ path, content: readFileSync(join(root, path), 'utf8') }))
}

// Exported for unit tests only: exercises the real clone/commit/push/
// rebase machinery against an explicit config (e.g. a throwaway local bare
// repo), bypassing gitopsConfig.ts/the DB and the SSH key file dance
// entirely. Not used by any application code path.
export const __testing = { ensureRepoReady, ensureRepoCloned, applyFileOps, commitAndPush, withGitLock, listFilesRecursive, addAndCommitIfChanged, computeLastCommitAuthors }
