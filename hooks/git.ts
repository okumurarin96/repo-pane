import type { Branch, ChangedFile, Commit, RemoteBranch, RemoteUrl, Stash, Tag, WorktreeStatus } from '../types'

export type WorktreeEntry = { path: string; isBare: boolean }

const MAX_FILES = 300

/** Parses `git worktree list --porcelain`. */
export function parseWorktreeList(out: string): WorktreeEntry[] {
  const list: WorktreeEntry[] = []
  for (const line of out.split('\n')) {
    const last = list[list.length - 1]
    if (line.startsWith('worktree ')) list.push({ path: line.slice(9), isBare: false })
    else if (line === 'bare' && last) last.isBare = true
  }
  return list
}

function changed(code: string, path: string): ChangedFile {
  const x = code[0] ?? ' '
  const y = code[1] ?? ' '
  const isUntracked = code === '??'
  const isConflicted = code === 'UU' || code === 'AA' || code === 'DD' || x === 'U' || y === 'U'
  return {
    code,
    path,
    isUntracked,
    isConflicted,
    isStaged: !isUntracked && !isConflicted && x !== ' ',
    isUnstaged: !isUntracked && !isConflicted && y !== ' ',
  }
}

/** Parses `git status --porcelain=v2 --branch` into counts and the changed files. */
export function parseStatus(out: string, path: string, label: string): WorktreeStatus {
  const s: WorktreeStatus = {
    path, label, branch: '?', isDetached: false, upstream: null,
    ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0, files: [], error: null,
  }
  let oid = ''
  const add = (f: ChangedFile) => {
    if (s.files.length < MAX_FILES) s.files.push(f)
  }
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.oid ')) {
      oid = line.slice(13, 21)
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice(14)
      s.isDetached = head === '(detached)'
      s.branch = head
    } else if (line.startsWith('# branch.upstream ')) {
      s.upstream = line.slice(18)
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) { s.ahead = Number(m[1]); s.behind = Number(m[2]) }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      if (line[2] !== '.') s.staged++
      if (line[3] !== '.') s.modified++
      // `1 XY sub mH mI mW hH hI path`, `2 XY sub mH mI mW hH hI Xscore path\torig`
      const rest = line.split(' ').slice(line.startsWith('1 ') ? 8 : 9).join(' ')
      add(changed(line.slice(2, 4).replace(/\./g, ' '), rest.split('\t')[0] ?? rest))
    } else if (line.startsWith('u ')) {
      s.conflicted++
      add(changed(line.slice(2, 4), line.split(' ').slice(10).join(' ')))
    } else if (line.startsWith('? ')) {
      s.untracked++
      add(changed('??', line.slice(2)))
    }
  }
  if (s.isDetached) s.branch = `detached @${oid}`
  return s
}

// The unit separator between fields: `git log` / `stash list` spell it %x1f, `for-each-ref` spells it %1f.
const SEP = '%x1f'
const REF_SEP = '%1f'
export const LOG_FORMAT = `--format=%H${SEP}%h${SEP}%an${SEP}%cr${SEP}%D${SEP}%s`

/** Parses `git log` printed with LOG_FORMAT. */
export function parseLog(out: string): Commit[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [hash = '', short = '', author = '', when = '', refs = '', ...subject] = line.split('\x1f')
      return { hash, short, author, when, refs, subject: subject.join('\x1f') }
    })
}

export const BRANCH_FORMAT = `--format=%(refname:short)${REF_SEP}%(upstream:short)${REF_SEP}%(upstream:track)${REF_SEP}%(committerdate:relative)${REF_SEP}%(subject)${REF_SEP}%(HEAD)`

export function parseBranches(out: string): Branch[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name = '', upstream = '', track = '', when = '', subject = '', head = ''] = line.split('\x1f')
      return { name, upstream, track, when, subject, isHead: head === '*' }
    })
}

export const REMOTE_BRANCH_FORMAT = `--format=%(refname:short)${REF_SEP}%(committerdate:relative)${REF_SEP}%(subject)${REF_SEP}%(symref)`

export function parseRemoteBranches(out: string): RemoteBranch[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => line.split('\x1f'))
    // `origin/HEAD` is a pointer, and `origin` alone is how some gits shorten it
    .filter(([name = '', , , symref = '']) => name.includes('/') && !symref && !name.endsWith('/HEAD'))
    .map(([name = '', when = '', subject = '']) => ({ name, when, subject }))
}

export const STASH_FORMAT = `--format=%gd${SEP}%cr${SEP}%gs`

export function parseStashes(out: string): Stash[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [ref = '', when = '', message = ''] = line.split('\x1f')
      return { ref, when, message }
    })
}

export const TAG_FORMAT = `--format=%(refname:short)${REF_SEP}%(creatordate:relative)${REF_SEP}%(subject)`

export function parseTags(out: string): Tag[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name = '', when = '', subject = ''] = line.split('\x1f')
      return { name, when, subject }
    })
}

/** Parses `git remote -v` into one entry per remote. */
export function parseRemotes(remoteV: string): RemoteUrl[] {
  const byName = new Map<string, RemoteUrl>()
  for (const line of remoteV.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim())
    if (!m) continue
    const [, name = '', url = '', kind] = m
    const r = byName.get(name) ?? { name, fetchUrl: '', pushUrl: '' }
    if (kind === 'fetch') r.fetchUrl = url
    else r.pushUrl = url
    byName.set(name, r)
  }
  return [...byName.values()]
}

/** `{ host, path }` of an https, `ssh://` or `git@host:path` remote URL. */
export function parseRemoteUrl(url: string): { host: string; path: string } | null {
  const u = url.trim()
  const m =
    /^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(u) ??
    /^[^@\s]+@([^:\s]+):(.+?)(?:\.git)?\/?$/.exec(u)
  return m ? { host: (m[1] ?? '').toLowerCase(), path: m[2] ?? '' } : null
}

/** `host/owner/repo` of a remote URL, lowercased: what local and remote repos are matched on. */
export function remoteKey(url: string): string | null {
  const p = parseRemoteUrl(url)
  return p ? `${p.host}/${p.path}`.toLowerCase() : null
}

/**
 * `-c url.git@<host>:.insteadOf=<https prefix>` for each https remote in `git remote -v`:
 * the command then talks SSH, while the repo's own remote stays https (SourceTree keeps working).
 */
export function sshRewriteArgs(remoteV: string): string[] {
  const rewrites = new Map<string, string>()
  for (const line of remoteV.split('\n')) {
    const url = line.split(/\s+/)[1] ?? ''
    const m = /^(https:\/\/(?:[^@/]+@)?([^/:]+)\/)/.exec(url)
    if (m?.[1] && m[2]) rewrites.set(m[1], `git@${m[2]}:`)
  }
  return [...rewrites].flatMap(([prefix, ssh]) => ['-c', `url.${ssh}.insteadOf=${prefix}`])
}

/**
 * `-c url.https://<gitUser>@<host>/.insteadOf=<prefix>` for each https remote whose host has a signed-in
 * account sending another user name: git then asks the credential store for the account's saved secret
 * (an OAuth token is saved under `x-token-auth` / `oauth2`), while the repo's own remote is left as it is.
 */
export type NetAccount = { host: string; gitUser: string; method: 'oauth' | 'token' | 'ssh'; protocol: 'https' | 'ssh'; sshKey: string }

/** The account git uses for a host: one set to SSH first when asked for, else OAuth, else any. */
export function accountForHost<A extends NetAccount>(accounts: readonly A[], host: string): A | undefined {
  const h = host.toLowerCase()
  const on = accounts.filter(a => a.host === h)
  return on.find(a => a.protocol === 'ssh') ?? on.find(a => a.method === 'oauth') ?? on[0]
}

export function credentialRewriteArgs(remoteV: string, accounts: readonly NetAccount[]): string[] {
  const rewrites = new Map<string, string>()
  for (const line of remoteV.split('\n')) {
    const url = line.split(/\s+/)[1] ?? ''
    const m = /^(https:\/\/(?:([^@/]+)@)?([^/:]+)\/)/.exec(url)
    if (!m?.[1] || !m[3]) continue
    const host = m[3].toLowerCase()
    const user = m[2] ? decodeURIComponent(m[2]) : ''
    const account = accountForHost(accounts, host)
    if (!account) continue
    // an account set to SSH sends this host's https remotes over SSH
    if (account.protocol === 'ssh') {
      rewrites.set(m[1], `git@${host}:`)
      continue
    }
    if (user === account.gitUser) continue
    rewrites.set(m[1], `https://${encodeURIComponent(account.gitUser)}@${host}/`)
  }
  return [...rewrites].flatMap(([prefix, to]) => ['-c', `url.${to}.insteadOf=${prefix}`])
}

/**
 * `-c` flags that let git only read saved credentials: the configured helpers are replaced, for this command,
 * by one that answers `get` through `git credential fill` (the configured helpers, e.g. the macOS Keychain) and
 * ignores `store` and `erase`. Git erases a credential the server refused; with this, a failed sign-in never
 * deletes the token the person saved.
 */
export const READ_ONLY_CREDENTIALS = [
  '-c', 'credential.helper=',
  '-c', 'credential.helper=!f() { test "$1" = get || exit 0; env -u GIT_CONFIG_PARAMETERS git credential fill; }; f',
]

/**
 * Where a provider says a remote went: GitHub's "This repository moved. Please use the new location: <url>",
 * or git's own "warning: redirecting to <url>" after an http redirect (GitLab, GitHub, Bitbucket alike).
 */
export function parseMovedNotice(stderr: string): string | null {
  const moved = /This repository moved\.\s*Please use the new location:\s*(?:remote:\s*)*(\S+)/i.exec(stderr)
  const redirect = /warning: redirecting to (\S+)/i.exec(stderr)
  const url = moved?.[1] ?? redirect?.[1]
  if (!url) return null
  // a redirect names the smart-http endpoint; the repo is what comes before it
  return url.replace(/\/(info\/refs.*|git-upload-pack.*|git-receive-pack.*)$/, '').replace(/\/+$/, '')
}

/** A new location written the way the old remote was: SSH stays SSH, an https user name is kept. */
export function rewriteRemoteUrl(oldUrl: string, newUrl: string): string | null {
  const next = parseRemoteUrl(newUrl)
  if (!next) return null
  const path = next.path.replace(/\.git$/, '')
  const old = oldUrl.trim()
  if (/^(git@|ssh:\/\/)/.test(old)) return `git@${next.host}:${path}.git`
  const user = /^https?:\/\/([^@/]+)@/.exec(old)?.[1]
  return `https://${user ? `${user}@` : ''}${next.host}/${path}.git`
}

/** Whether a fetch error means the remote repo is gone or out of reach (renamed, transferred, deleted, no access). */
export function isRemoteGone(text: string): boolean {
  return /Repository not found|repository .* not found|does not exist|You may not have access|Could not read from remote|HTTP 404|not found|không có quyền truy cập repo/i.test(text)
}

/**
 * The user name a plugin-saved token is stored and sent under. It is the plugin's own, so other git tools
 * (an editor's auto-fetch, SourceTree, a terminal) never find it under the remote's user name, and never
 * erase it when the provider refuses them. Bitbucket API tokens take the fixed name
 * `x-bitbucket-api-token-auth`; GitHub accepts any name with a token.
 */
export function tokenGitUser(provider: 'bitbucket' | 'github' | 'gitlab', username: string): string {
  if (provider === 'bitbucket') return 'x-bitbucket-api-token-auth'
  if (provider === 'github') return `repo-pane-${username}`
  return username
}

/** The hosts a repo's remotes point at. */
export function remoteHosts(remoteV: string): string[] {
  const hosts = new Set<string>()
  for (const line of remoteV.split('\n')) {
    const p = parseRemoteUrl(line.split(/\s+/)[1] ?? '')
    if (p) hosts.add(p.host)
  }
  return [...hosts]
}

/** The ssh argv: never prompting, and with the account's own key when it has one. */
export function sshArgv(key: string, acceptNewHost = false): string[] {
  const parts = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15']
  if (acceptNewHost) parts.push('-o', 'StrictHostKeyChecking=accept-new')
  if (key) parts.push('-i', key, '-o', 'IdentitiesOnly=yes')
  return parts
}

/** The same as GIT_SSH_COMMAND, which git runs through a shell: each part single-quoted. */
export function sshCommand(key: string): string {
  return sshArgv(key).map(s => (/^[\w./=:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)).join(' ')
}

/** What `ssh -T git@<host>` says: whether the key got in, and the username when the host names it. */
export function sshGreeting(text: string): { ok: boolean; username: string } {
  const gh = /Hi ([^!\s]+)! You've successfully authenticated/.exec(text)
  if (gh?.[1]) return { ok: true, username: gh[1] }
  const gl = /Welcome to GitLab, @([^!\s]+)!/.exec(text)
  if (gl?.[1]) return { ok: true, username: gl[1] }
  const bb = /logged in as (\S+?)\.?\s/.exec(text)
  if (bb?.[1]) return { ok: true, username: bb[1] }
  return { ok: /authenticated via ssh key|successfully authenticated/i.test(text), username: '' }
}

/** Parses `ssh-keygen -lf <key>.pub`: `256 SHA256:... comment (ED25519)`. */
export function parseKeyFingerprint(line: string): { fingerprint: string; comment: string } {
  const m = /^\d+\s+(\S+)\s+(.*?)\s*\(([A-Z0-9-]+)\)\s*$/.exec(line.trim())
  return m ? { fingerprint: m[1] ?? '', comment: `${m[2] ?? ''} (${m[3] ?? ''})`.trim() } : { fingerprint: '', comment: line.trim() }
}

/** A remote URL git can use: https, ssh (`git@host:path` or `ssh://`), or a local path. */
export function isValidRemoteUrl(url: string): boolean {
  const u = url.trim()
  return /^(https?:\/\/|ssh:\/\/|git@[^:\s]+:)\S+$/.test(u) || /^\/\S+$/.test(u)
}

/** The repo name a clone lands in: the slug, safe as one folder name. */
export function cloneFolder(slug: string): string | null {
  return /^[a-z0-9._-]+$/i.test(slug) && slug !== '.' && slug !== '..' ? slug : null
}

/** A branch name as a folder name for a new worktree. */
export function worktreeFolder(branch: string): string {
  return branch.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'worktree'
}

export function isAuthError(text: string): boolean {
  return /could not read (Password|Username)|Authentication failed|terminal prompts disabled|HTTP Basic: Access denied|Invalid username or password/i.test(text)
}

export function explainNetworkError(text: string): string {
  if (/You may not have access|Could not read from remote|Repository not found|ERROR: Repository/i.test(text)) {
    return 'không có quyền truy cập repo'
  }
  if (isAuthError(text)) return 'chưa đăng nhập tài khoản cho host này (tab Tài khoản)'
  return text
}

/** `git diff` output reduced to its hunks, which is what a diff `Code` element draws. */
export function diffHunks(out: string, maxLines = 600): string {
  const lines = out.split('\n')
  const start = lines.findIndex(l => l.startsWith('@@'))
  if (start < 0) return ''
  const hunks = lines.slice(start).filter(l => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(l))
  return hunks.slice(0, maxLines).join('\n').replace(/\n+$/, '')
}

export function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n')
  return lines.length > maxLines ? `${lines.slice(0, maxLines).join('\n')}\n… (${lines.length - maxLines} dòng nữa)` : text
}

export function worktreeLabel(repoPath: string, wtPath: string): string {
  if (wtPath === repoPath) return 'main'
  return wtPath.startsWith(repoPath + '/') ? wtPath.slice(repoPath.length + 1) : wtPath
}

export function isClean(w: WorktreeStatus): boolean {
  return w.staged + w.modified + w.untracked + w.conflicted === 0
}

export function ago(at: number | null, now: number): string {
  if (at == null) return 'chưa'
  const sec = Math.max(0, Math.round((now - at) / 1000))
  if (sec < 60) return `${sec}s trước`
  if (sec < 3600) return `${Math.round(sec / 60)} phút trước`
  return `${Math.round(sec / 3600)} giờ trước`
}

export function shortDate(iso: string): string {
  return iso ? iso.slice(0, 10) : ''
}

export type LocalGroup<R, A> = { key: string; account: A | null; host: string; repos: R[] }

/**
 * Watched repos gathered by the signed-in account they belong to, in the accounts' order: the account whose
 * remote list holds the repo, else the one named like the repo's owner on that host, else the host's account.
 * Then repos on hosts with no account (one group per host), then repos with no remote.
 */
export function groupReposByAccount<R extends { name: string; remote: string | null }, A extends NetAccount & { id: string; username: string }>(
  repos: readonly R[],
  accounts: readonly A[],
  seen: Readonly<Record<string, readonly string[]>>,
): LocalGroup<R, A>[] {
  const byKey = new Map<string, LocalGroup<R, A>>()
  for (const a of accounts) byKey.set(a.id, { key: a.id, account: a, host: a.host, repos: [] })
  const hostOnly: LocalGroup<R, A>[] = []
  const none: LocalGroup<R, A> = { key: '', account: null, host: '', repos: [] }
  for (const repo of repos) {
    const parts = repo.remote ? repo.remote.split('/') : []
    const host = parts.length >= 3 ? parts[0] ?? '' : ''
    if (!host || !repo.remote) {
      none.repos.push(repo)
      continue
    }
    const owner = parts.slice(1, -1).join('/')
    const onHost = accounts.filter(a => a.host === host)
    const holders = onHost.filter(a => seen[a.id]?.includes(repo.remote ?? ''))
    const named = (list: readonly A[]) => list.find(a => a.username.toLowerCase() === owner)
    const a = named(holders) ?? holders[0] ?? named(onHost) ?? accountForHost(onHost, host)
    if (a) {
      byKey.get(a.id)?.repos.push(repo)
      continue
    }
    const key = `host:${host}`
    let hg = hostOnly.find(x => x.key === key)
    if (!hg) hostOnly.push((hg = { key, account: null, host, repos: [] }))
    hg.repos.push(repo)
  }
  const groups = [...byKey.values(), ...hostOnly.sort((x, y) => x.host.localeCompare(y.host)), none].filter(x => x.repos.length > 0)
  for (const x of groups) x.repos.sort((p, q) => p.name.localeCompare(q.name))
  return groups
}
