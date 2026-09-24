import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, type Server } from 'net'
import simpleGit from 'simple-git'

// 'server-only' isn't a real package outside Next's bundler; same stub
// k8s.test.ts already uses.
vi.mock('server-only', () => ({}))

const { __testing } = await import('./git')
const { ensureRepoReady, ensureRepoCloned, applyFileOps, commitAndPush, withGitLock, addAndCommitIfChanged, computeLastCommitAuthors } = __testing

// These tests exercise the real clone/commit/push/rebase machinery against
// a throwaway local bare repo (a plain directory works fine as a git remote
// over a file path, no SSH, no network, no DB/gitopsConfig.ts involved).
// sshKeyPath is omitted throughout, so gitFor() never sets GIT_SSH_COMMAND.

// git init --bare has no HEAD/branches until something is pushed; seed one
// so `git clone --branch main` (what ensureRepoReady does) works.
async function initBareRemoteWithMain(): Promise<string> {
  const remote = mkdtempSync(join(tmpdir(), 'floodgate-gitops-remote-'))
  await simpleGit(remote).init(['--bare', '--initial-branch=main'])
  const seed = mkdtempSync(join(tmpdir(), 'floodgate-gitops-seed-'))
  const seedGit = simpleGit(seed)
  await seedGit.init(['--initial-branch=main'])
  await seedGit.addConfig('user.email', 'seed@test.local')
  await seedGit.addConfig('user.name', 'seed')
  writeFileSync(join(seed, '.gitkeep'), '')
  await seedGit.add(['.gitkeep'])
  await seedGit.commit('seed')
  await seedGit.addRemote('origin', remote)
  await seedGit.push('origin', 'main')
  return remote
}

function config(remote: string, overrides: Partial<Parameters<typeof ensureRepoReady>[0]> = {}) {
  const localPath = mkdtempSync(join(tmpdir(), 'floodgate-gitops-local-'))
  return {
    localPath,
    repoUrl: remote,
    branch: 'main',
    repoSubpath: 'policies',
    authorName: 'floodgate-bot',
    authorEmail: 'floodgate@localhost',
    ...overrides,
  }
}

describe('git.ts (real local bare repo, no SSH/DB involved)', () => {
  it('clones on first use', async () => {
    const remote = await initBareRemoteWithMain()
    const cfg = config(remote)
    await ensureRepoReady(cfg)
    expect(existsSync(join(cfg.localPath, '.git'))).toBe(true)
    expect(existsSync(join(cfg.localPath, '.gitkeep'))).toBe(true)
  })

  // testGitOpsConnection() (git.ts's public API) is a thin try/catch around
  // exactly this call, used to surface a clear error when an admin saves a
  // bad repo URL/branch/key in the Config panel; not separately testable
  // here since it hardcodes /data/..., but the underlying rejection it
  // wraps is.
  it('rejects with a clear underlying error for a repo URL that does not exist', async () => {
    const cfg = config('/tmp/floodgate-this-path-does-not-exist-at-all')
    await expect(ensureRepoReady(cfg)).rejects.toThrow()
  })

  // Simulates a prior write that committed locally but was interrupted
  // (pod killed) before the push completed. The on-disk clone (same
  // localPath, as it would be on the PVC across a restart) still has that
  // commit sitting as HEAD, ahead of origin. The next call to
  // ensureRepoReady() (any write, not necessarily a retry of the same
  // one) must recover it by pushing before falling back to discarding it.
  it('recovers a commit stranded by a prior interrupted write instead of silently discarding it', async () => {
    const remote = await initBareRemoteWithMain()
    const cfg = config(remote)
    const git = await ensureRepoReady(cfg)

    // Commit locally, deliberately skip the push: this is the exact
    // state a crash between `git commit` and `git push` would leave.
    const touched = applyFileOps(cfg, [{ action: 'write', path: 'ns-i/stranded.yaml', content: 'e: 5\n' }])
    await git.add(touched)
    await git.commit('floodgate: stranded by a simulated crash before push')

    // A later, unrelated write reuses the same local clone path (as it
    // would after the pod restarts). ensureRepoReady() must push the
    // stranded commit forward, not just reset --hard over it.
    await ensureRepoReady(config(remote, { localPath: cfg.localPath }))

    const verify = config(remote)
    await ensureRepoReady(verify)
    expect(existsSync(join(verify.localPath, 'policies/ns-i/stranded.yaml'))).toBe(true)
  })

  // ensureRepoCloned() is the read path (listPolicyFiles/readPolicyFile/
  // listPolicyFilesWithContent): connectivity is meant to be validated
  // once, at config-save time (testGitOpsConnection, which uses
  // ensureRepoReady), not on every one of the dashboard's 15s polls. Once
  // cloned, a read must reuse the local clone with no fetch, proven here
  // by a commit landing on the remote AFTER our clone, which a real fetch
  // would pick up but ensureRepoCloned must not.
  it('ensureRepoCloned clones once, then never fetches again: a later remote commit stays invisible to it', async () => {
    const remote = await initBareRemoteWithMain()
    const cfg = config(remote)
    await ensureRepoCloned(cfg)
    expect(existsSync(join(cfg.localPath, '.gitkeep'))).toBe(true)

    // Someone else pushes a new file to the remote after our clone.
    const other = config(remote)
    const otherGit = await ensureRepoReady(other)
    applyFileOps(other, [{ action: 'write', path: 'ns-z/late.yaml', content: 'z: 1\n' }])
    await otherGit.add([join('policies', 'ns-z/late.yaml')])
    await commitAndPush(other, otherGit, 'someone else: add ns-z after our clone')

    // Calling ensureRepoCloned again on the same local path must not fetch
    // it in; the file stays absent locally.
    await ensureRepoCloned(cfg)
    expect(existsSync(join(cfg.localPath, 'policies/ns-z/late.yaml'))).toBe(false)

    // ensureRepoReady (the write path), by contrast, does pick it up.
    await ensureRepoReady(cfg)
    expect(existsSync(join(cfg.localPath, 'policies/ns-z/late.yaml'))).toBe(true)
  })

  it('commits multiple files in a single commit and pushes', async () => {
    const remote = await initBareRemoteWithMain()
    const cfg = config(remote)
    const git = await ensureRepoReady(cfg)
    const touched = applyFileOps(cfg, [
      { action: 'write', path: 'ns-a/allow-1.yaml', content: 'a: 1\n' },
      { action: 'write', path: 'ns-b/allow-2.yaml', content: 'b: 2\n' },
    ])
    await git.add(touched)
    const commit = await commitAndPush(cfg, git, 'floodgate: add two policies')

    // Clone fresh elsewhere and confirm both files landed in ONE commit.
    const verify = config(remote)
    const verifyGit = await ensureRepoReady(verify)
    expect(readFileSync(join(verify.localPath, 'policies/ns-a/allow-1.yaml'), 'utf8')).toBe('a: 1\n')
    expect(readFileSync(join(verify.localPath, 'policies/ns-b/allow-2.yaml'), 'utf8')).toBe('b: 2\n')
    const log = await verifyGit.log(['-1'])
    expect(log.latest?.hash).toBe(commit)
    expect(log.latest?.author_name).toBe('floodgate-bot')
  })

  it('retries a non-fast-forward push via rebase when a concurrent commit landed first', async () => {
    const remote = await initBareRemoteWithMain()
    const cfg = config(remote)
    const git = await ensureRepoReady(cfg)

    // A second, independent clone pushes a commit to a DIFFERENT file first:
    // simulates someone/something else writing to the repo between our
    // clone and our push.
    const other = config(remote)
    const otherGit = await ensureRepoReady(other)
    applyFileOps(other, [{ action: 'write', path: 'ns-c/other.yaml', content: 'c: 3\n' }])
    await otherGit.add([join('policies', 'ns-c/other.yaml')])
    await commitAndPush(other, otherGit, 'someone else: add ns-c')

    // Our own write, prepared against the now-stale local clone.
    const touched = applyFileOps(cfg, [{ action: 'write', path: 'ns-d/mine.yaml', content: 'd: 4\n' }])
    await git.add(touched)
    const commit = await commitAndPush(cfg, git, 'floodgate: add ns-d')

    // Both commits should be present in the remote afterward.
    const verify = config(remote)
    await ensureRepoReady(verify)
    expect(existsSync(join(verify.localPath, 'policies/ns-c/other.yaml'))).toBe(true)
    expect(existsSync(join(verify.localPath, 'policies/ns-d/mine.yaml'))).toBe(true)
    expect(commit).toBeTruthy()
  })

  it('surfaces a clear error and leaves the repo clean on a real rebase conflict', async () => {
    const remote = await initBareRemoteWithMain()
    const cfg = config(remote)
    const git = await ensureRepoReady(cfg)
    applyFileOps(cfg, [{ action: 'write', path: 'ns-e/shared.yaml', content: 'base\n' }])
    await git.add([join('policies', 'ns-e/shared.yaml')])
    await commitAndPush(cfg, git, 'floodgate: seed shared.yaml')

    // Two independent clones, BOTH taken before either pushes, editing the
    // SAME line of the SAME file differently: a real, unresolvable
    // conflict on rebase. (Cloning b after a's push would just hand b a's
    // change for free via fast-forward, no divergence, no conflict.)
    const a = config(remote)
    const aGit = await ensureRepoReady(a)
    const b = config(remote)
    const bGit = await ensureRepoReady(b)

    applyFileOps(a, [{ action: 'write', path: 'ns-e/shared.yaml', content: 'edited-by-a\n' }])
    await aGit.add([join('policies', 'ns-e/shared.yaml')])
    await commitAndPush(a, aGit, 'a: edit shared.yaml')

    applyFileOps(b, [{ action: 'write', path: 'ns-e/shared.yaml', content: 'edited-by-b\n' }])
    await bGit.add([join('policies', 'ns-e/shared.yaml')])

    await expect(commitAndPush(b, bGit, 'b: edit shared.yaml (conflicts)')).rejects.toThrow(/Conflito real/)

    // No leftover rebase state: a subsequent normal operation must work.
    const status = await bGit.status()
    expect(status.conflicted).toEqual([])
  })

  // The rebase step can fail for reasons that have nothing to do with
  // conflicting content (network hiccup, the write timeout firing
  // mid-rebase, disk pressure), those must not be treated the same as a
  // real conflict, which used to unconditionally reset --hard and throw
  // away the commit this call just made over what could just be a
  // retryable blip.
  it('a transient (non-conflict) rebase failure does not discard the just-made commit', async () => {
    const remote = await initBareRemoteWithMain()
    const cfg = config(remote)
    const git = await ensureRepoReady(cfg)

    // A genuine non-fast-forward situation (same setup as the retry test
    // above), but this time the rebase step itself is forced to fail for
    // an unrelated reason instead of being allowed to actually run.
    const other = config(remote)
    const otherGit = await ensureRepoReady(other)
    applyFileOps(other, [{ action: 'write', path: 'ns-g/other.yaml', content: 'c: 3\n' }])
    await otherGit.add([join('policies', 'ns-g/other.yaml')])
    await commitAndPush(other, otherGit, 'someone else: add ns-g')

    applyFileOps(cfg, [{ action: 'write', path: 'ns-h/mine.yaml', content: 'd: 4\n' }])
    await git.add([join('policies', 'ns-h/mine.yaml')])

    const rebaseSpy = vi.spyOn(git, 'rebase').mockRejectedValueOnce(new Error('simulated network hiccup, not a real conflict'))
    await expect(commitAndPush(cfg, git, 'floodgate: add ns-h')).rejects.toThrow(/Falha temporária/)
    rebaseSpy.mockRestore()

    // No content conflict was ever created; git.status() must be clean...
    const status = await git.status()
    expect(status.conflicted).toEqual([])
    // ...and, critically, our own commit must still be there as HEAD, not
    // discarded by a reset --hard that should never have run here.
    const log = await git.log(['-1'])
    expect(log.latest?.message).toBe('floodgate: add ns-h')
  })

  it('addAndCommitIfChanged is a no-op (not an error) when the rewritten content is byte-identical to HEAD', async () => {
    const remote = await initBareRemoteWithMain()
    const cfg = config(remote)
    const git = await ensureRepoReady(cfg)
    const touched = applyFileOps(cfg, [{ action: 'write', path: 'ns-f/idempotent.yaml', content: 'same\n' }])
    const first = await addAndCommitIfChanged(cfg, git, touched, 'floodgate: seed idempotent.yaml')
    expect(first).toBeTruthy()

    // Re-apply the exact same content: simulates isolateNamespace() being
    // called again on an already-isolated namespace (direct mode's 409 →
    // skip equivalent).
    const touchedAgain = applyFileOps(cfg, [{ action: 'write', path: 'ns-f/idempotent.yaml', content: 'same\n' }])
    const second = await addAndCommitIfChanged(cfg, git, touchedAgain, 'floodgate: seed idempotent.yaml again')
    expect(second).toBe(first) // same HEAD: no new (empty) commit created, and no thrown error
  })

  it('withGitLock serializes concurrent operations, never interleaving', async () => {
    const order: string[] = []
    const task = (label: string, delayMs: number) => withGitLock(async () => {
      order.push(`${label}:start`)
      await new Promise(r => setTimeout(r, delayMs))
      order.push(`${label}:end`)
    })

    await Promise.all([task('first', 20), task('second', 0)])

    // Regardless of scheduling, the mutex must keep each task's start/end
    // adjacent, never first:start, second:start, first:end, second:end.
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  // computeLastCommitAuthors() is the basis for the "editado fora do
  // floodgate" warning; must correctly attribute each path to whoever's
  // commit touched it MOST RECENTLY, not just the first author to ever
  // touch it, and must not confuse a path touched by one commit with an
  // unrelated path touched by another.
  it('computeLastCommitAuthors maps each path to its most recent author, across multiple authors and commits', async () => {
    const remote = await initBareRemoteWithMain()
    const cfg = config(remote)
    const git = await ensureRepoReady(cfg)

    async function commitAs(authorName: string, path: string, content: string, message: string) {
      const touched = applyFileOps(cfg, [{ action: 'write', path, content }])
      const g = simpleGit(cfg.localPath)
      g.env({ GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: `${authorName}@test.local`, GIT_COMMITTER_NAME: authorName, GIT_COMMITTER_EMAIL: `${authorName}@test.local` })
      await g.add(touched)
      await g.commit(message)
      await g.push('origin', 'main')
    }

    await commitAs('floodgate-bot', 'ns-a/first.yaml', 'v1\n', 'floodgate: create ns-a/first')
    await commitAs('someone-else', 'ns-a/second.yaml', 'v1\n', 'manual: unrelated file, different author')
    // Re-touch the FIRST file, as a different author: this must overwrite
    // its earlier attribution, since only the most recent commit matters.
    await commitAs('someone-else', 'ns-a/first.yaml', 'v2 edited manually\n', 'manual: edited ns-a/first directly')

    const authors = await computeLastCommitAuthors(cfg, git)
    expect(authors.get('ns-a/first.yaml')).toBe('someone-else') // most recent wins, not the original author
    expect(authors.get('ns-a/second.yaml')).toBe('someone-else')
  })

  // Without git.ts's own timeout config, a git subprocess talking to a host
  // that accepts the connection but never replies (unreachable-but-not-
  // refusing, a firewall silently dropping packets, ...) hangs forever:
  // the promise never resolves or rejects, which means callers relying on
  // it (commitPolicyFilesTracked's finally, withGitLock's mutex) would
  // never recover either. A raw TCP listener that accepts and goes silent
  // reproduces exactly that hang for the git:// protocol, deterministically
  // and without needing real network access.
  it('a hung git operation is killed by the configured timeout instead of hanging forever', async () => {
    const server: Server = createServer(socket => { /* accept, then never reply */ })
    const port = await new Promise<number>(resolve => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    })
    try {
      const cfg = config(`git://127.0.0.1:${port}/nonexistent.git`, { timeoutMsOverride: 300 })
      const start = Date.now()
      await expect(ensureRepoReady(cfg)).rejects.toThrow()
      // Generous upper bound (real timeout is 300ms): this only needs to
      // prove it fails fast, not hang for the test runner's own default
      // timeout (which would otherwise mask a regression as a slow pass).
      expect(Date.now() - start).toBeLessThan(5000)
    } finally {
      server.close()
    }
  }, 10_000)
})
