import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  Account, AccountForm, ChangedFile, Confirm, DiffView, FetchInfo, FlowConfig, FlowKind, OAuthApp, OAuthProgress,
  GitProtocol, OpState, Panel, Provider, RemoteList, RemoteRepo, RepoSettings, RepoStatus, RepoTab, Result, ScanResult,
  Selection, SignInMethod, SshState, View, WorktreeStatus,
} from '../types'
import { FLOW_KINDS, finishSteps, flowBase, flowConfigArgs, flowDefaults, flowKindOf, parseFlowConfig } from './flow'
import type { FlowStep } from './flow'
import {
  BRANCH_FORMAT, LOG_FORMAT, REMOTE_BRANCH_FORMAT, STASH_FORMAT, TAG_FORMAT, accountForHost, ago, cloneFolder,
  credentialRewriteArgs, parseKeyFingerprint, remoteHosts, sshArgv, sshCommand, sshGreeting,
  diffHunks, explainNetworkError, isAuthError, isClean, isValidRemoteUrl, parseBranches, parseLog, parseRemoteBranches,
  parseRemoteUrl, parseRemotes, parseStashes, parseStatus, parseTags, parseWorktreeList, remoteKey, shortDate,
  sshRewriteArgs, truncateLines, worktreeFolder, worktreeLabel,
} from './git'
import { GRAPH_FORMAT, graphSvg, parseGraphLog } from './graph'
import {
  BITBUCKET_WORKSPACES_URL, OAUTH_REDIRECT, PROVIDERS, apiError, createRepoRequest, ownersUrl, parseCreatedRepo,
  parseOwners, parseWorkspacePage, repoSlug, authHeaders, authorizeUrl, defaultHost, deviceCodeRequest, deviceTokenRequest,
  httpsWithUser, loginOf, matchesQuery, oauthAppHint, oauthAppPage, oauthGitUser, parseCreatedPr, parseDeviceCode,
  parsePrs, parseRepoPage, parseTokenResponse, pkceChallenge, prCreateRequest, prListUrl, providerForHost,
  providerLabel, randomToken, repoListUrls, sshKeysPage, tokenHint, tokenPageUrl, tokenRequest, userUrl, verifyUrl,
} from './providers'
import type { TokenSet } from './providers'

const PANE = 'repo-pane'
const TITLE = 'Repo Pane'
const MAX_REMOTE_ROWS = 80
const MAX_LIST = 120
// an SVG may carry at most 131072 characters: about 100 graph rows
const GRAPH_ROWS = 90

const repos = atom({ plugin: 'repo-pane', key: 'repos' } as const, [] as RepoStatus[])
const fetchInfo = atom({ plugin: 'repo-pane', key: 'fetch' } as const, { at: null, isRunning: false, failed: 0 } as FetchInfo)
const refreshedAt = atom({ plugin: 'repo-pane', key: 'refreshedAt' } as const, null as number | null)
const view = atom({ plugin: 'repo-pane', key: 'view' } as const, 'repos' as View)
const selected = atom({ plugin: 'repo-pane', key: 'selected' } as const, null as Selection | null)
const panel = atom({ plugin: 'repo-pane', key: 'panel' } as const, null as Panel | null)
const settings = atom({ plugin: 'repo-pane', key: 'settings' } as const, {} as Record<string, RepoSettings>)
const busy = atom({ plugin: 'repo-pane', key: 'busy' } as const, {} as Record<string, string>)
const drafts = atom({ plugin: 'repo-pane', key: 'drafts' } as const, {} as Record<string, string>)
const flags = atom({ plugin: 'repo-pane', key: 'flags' } as const, {} as Record<string, boolean>)
const confirm = atom({ plugin: 'repo-pane', key: 'confirm' } as const, null as Confirm | null)
const result = atom({ plugin: 'repo-pane', key: 'result' } as const, null as Result | null)
const diff = atom({ plugin: 'repo-pane', key: 'diff' } as const, null as DiffView | null)
const remote = atom({ plugin: 'repo-pane', key: 'remote' } as const, { isLoading: false, at: null, errors: [], repos: [], onDisk: [] } as RemoteList)
const accounts = atom({ plugin: 'repo-pane', key: 'accounts' } as const, [] as Account[])
const accountForm = atom({ plugin: 'repo-pane', key: 'accountForm' } as const, {
  provider: 'bitbucket', host: 'bitbucket.org', method: 'oauth', protocol: 'https', sshKey: '', username: '', email: '', scopes: '',
} as AccountForm)
const ssh = atom({ plugin: 'repo-pane', key: 'ssh' } as const, { keys: [], test: null, isTesting: false } as SshState)
const oauthApps = atom({ plugin: 'repo-pane', key: 'oauthApps' } as const, [] as OAuthApp[])
const oauth = atom({ plugin: 'repo-pane', key: 'oauth' } as const, null as OAuthProgress | null)
const scan = atom({ plugin: 'repo-pane', key: 'scan' } as const, { isLoading: false, root: '', found: [] } as ScanResult)
const owners = atom({ plugin: 'repo-pane', key: 'owners' } as const, {} as Record<string, string[]>)

// No prompts from git: a command that needs credentials fails instead of hanging.
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15',
}
const SEP = '\x1f'

type SharedApp = { provider: Provider; host: string; clientId: string; secret: string }
type Config = { repos: string[]; cloneDir: string; useSsh: boolean; home: string; apps: SharedApp[] }
type Run = { exitCode: number; stdout: string; stderr: string }

let cfg: Config = { repos: [], cloneDir: '', useSsh: true, home: '', apps: [] }
/** Repos cloned or watched from the pane, kept across sessions in the plugin's store. */
let extraRepos: string[] = []
let isRefreshing = false

function allPaths(): string[] {
  return [...cfg.repos, ...extraRepos.filter(p => !cfg.repos.includes(p))]
}

function lastLine(text: string): string {
  return text.trim().split('\n').pop()?.slice(0, 200) ?? ''
}

function output(r: Run): string {
  return truncateLines([r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n'), 40)
}

function splitList(value: unknown): string[] {
  return String(value ?? '').split(',').map(p => p.trim().replace(/\/+$/, '')).filter(Boolean)
}

function repoOf(list: readonly RepoStatus[], path: string): RepoStatus | undefined {
  return list.find(r => r.path === path)
}

// ── running git ────────────────────────────────────────────────────────────

async function git($: EngineInterface, cwd: string, args: string[], timeoutMs = 20_000, stdin?: string, env?: Record<string, string>): Promise<Run> {
  try {
    return await $.process.run(['git', '--no-optional-locks', ...args], { cwd, env: { ...GIT_ENV, ...env }, timeoutMs, stdin })
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: String(err) }
  }
}

/**
 * A network command: over https with the signed-in account's saved secret (OAuth tokens refreshed first),
 * and once more over SSH when https still has no credentials.
 */
async function gitNet($: EngineInterface, cwd: string, args: string[], timeoutMs = 120_000): Promise<Run> {
  await refreshExpiring($)
  const remoteV = (await git($, cwd, ['remote', '-v'])).stdout
  const list = await read($, accounts)
  const creds = credentialRewriteArgs(remoteV, list)
  const env = sshEnvFor(list, remoteHosts(remoteV))
  const first = await git($, cwd, [...creds, ...args], timeoutMs, undefined, env)
  if (first.exitCode === 0 || !cfg.useSsh || !isAuthError(first.stderr)) return first
  const rewrite = sshRewriteArgs(remoteV)
  return rewrite.length ? git($, cwd, [...rewrite, ...args], timeoutMs, undefined, env) : first
}

/** GIT_SSH_COMMAND carrying the key of the account for one of these hosts, when it has its own key. */
function sshEnvFor(list: readonly Account[], hosts: readonly string[]): Record<string, string> | undefined {
  for (const host of hosts) {
    const a = accountForHost(list, host)
    if (a?.sshKey) return { GIT_SSH_COMMAND: sshCommand(a.sshKey) }
  }
  return undefined
}

async function setBusy($: EngineInterface, key: string, what: string | null) {
  await update($, busy, b => {
    const next = { ...b }
    if (what) next[key] = what
    else delete next[key]
    return next
  })
}

async function report($: EngineInterface, label: string, r: Run, okText?: string) {
  const ok = r.exitCode === 0
  const text = ok ? output(r) : explainNetworkError(output(r) || `exit ${r.exitCode}`)
  await update($, result, () => ({ label, ok, text, at: Date.now() }))
  void $.ui.toast(ok ? okText ?? `${label}: xong` : `${label}: lỗi — ${lastLine(text)}`)
}

/**
 * Runs one git action in a worktree: marks it busy, reports the outcome, then re-reads that repo
 * and the open panel. One action per worktree at a time.
 */
async function act($: EngineInterface, cwd: string, label: string, args: string[], opts: { net?: boolean; stdin?: string; okText?: string } = {}) {
  const b = await read($, busy)
  if (b[cwd]) {
    void $.ui.toast(`Đang chạy "${b[cwd]}", chờ xong đã`)
    return false
  }
  await setBusy($, cwd, label)
  try {
    const r = opts.net ? await gitNet($, cwd, args) : await git($, cwd, args, 120_000, opts.stdin)
    await report($, label, r, opts.okText)
    return r.exitCode === 0
  } finally {
    await setBusy($, cwd, null)
    await refreshFor($, cwd)
  }
}

// ── reading repos ──────────────────────────────────────────────────────────

async function readWorktree($: EngineInterface, repoPath: string, wtPath: string): Promise<WorktreeStatus> {
  const label = worktreeLabel(repoPath, wtPath)
  const r = await git($, wtPath, ['status', '--porcelain=v2', '--branch'])
  if (r.exitCode !== 0) return { ...parseStatus('', wtPath, label), error: lastLine(r.stderr) || 'git status lỗi' }
  return parseStatus(r.stdout, wtPath, label)
}

async function readRepo($: EngineInterface, path: string, fetchError: string | null): Promise<RepoStatus> {
  const name = path.split('/').pop() || path
  const [list, origin] = await Promise.all([
    git($, path, ['worktree', 'list', '--porcelain']),
    git($, path, ['remote', 'get-url', 'origin']),
  ])
  const key = origin.exitCode === 0 ? remoteKey(origin.stdout) : null
  if (list.exitCode !== 0) {
    return { name, path, remote: key, worktrees: [], fetchError, error: lastLine(list.stderr) || 'không phải git repo' }
  }
  const entries = parseWorktreeList(list.stdout).filter(w => !w.isBare)
  const worktrees = await Promise.all(entries.map(w => readWorktree($, path, w.path)))
  return { name, path, remote: key, worktrees, fetchError, error: null }
}

async function refresh($: EngineInterface) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const prev = await read($, repos)
    const fetchErrors = new Map(prev.map(r => [r.path, r.fetchError]))
    const list = await Promise.all(allPaths().map(p => readRepo($, p, fetchErrors.get(p) ?? null)))
    await update($, repos, () => list)
    await update($, refreshedAt, () => Date.now())
    if ((await read($, view)) === 'repo') await loadPanel($, false)
  } finally {
    isRefreshing = false
  }
}

/** Re-reads the repo a worktree belongs to, and the open panel. */
async function refreshFor($: EngineInterface, cwd: string) {
  const list = await read($, repos)
  const owner = list.find(r => r.path === cwd || r.worktrees.some(w => w.path === cwd))
  if (!owner) {
    await refresh($)
    return
  }
  const fresh = await readRepo($, owner.path, owner.fetchError)
  await update($, repos, cur => cur.map(r => (r.path === owner.path ? fresh : r)))
  const sel = await read($, selected)
  if (sel?.repo === owner.path) {
    // the open worktree may be gone (worktree removed): fall back to the main one
    if (!fresh.worktrees.some(w => w.path === sel.worktree)) {
      await update($, selected, s => (s ? { ...s, worktree: fresh.worktrees[0]?.path ?? s.repo } : s))
    }
    await loadPanel($, false)
  }
}

async function opStateOf($: EngineInterface, cwd: string): Promise<OpState> {
  const has = async (ref: string) => (await git($, cwd, ['rev-parse', '-q', '--verify', ref])).exitCode === 0
  const isDir = async (name: string) => {
    const p = await git($, cwd, ['rev-parse', '--git-path', name])
    if (p.exitCode !== 0) return false
    const t = await $.process.run(['test', '-d', p.stdout.trim()], { cwd }).catch(() => ({ exitCode: 1 }))
    return t.exitCode === 0
  }
  if ((await isDir('rebase-merge')) || (await isDir('rebase-apply'))) return 'rebase'
  if (await has('MERGE_HEAD')) return 'merge'
  if (await has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (await has('REVERT_HEAD')) return 'revert'
  return null
}

/** Reads what the open repo's tabs show, for the selected worktree. */
async function loadPanel($: EngineInterface, withPrs: boolean) {
  const sel = await read($, selected)
  if (!sel) return
  const cwd = sel.worktree
  const d = await read($, drafts)
  const f = await read($, flags)
  const q = (d[`logq:${cwd}`] ?? '').trim()
  const logArgs = ['log', '-n', String(MAX_LIST), LOG_FORMAT]
  if (q.startsWith('@')) logArgs.push(`--author=${q.slice(1)}`, '-i')
  else if (q) logArgs.push(`--grep=${q}`, '-i')

  await update($, panel, p => (p && p.worktree === cwd ? { ...p, isLoading: true } : {
    worktree: cwd, branches: [], remoteBranches: [], log: [], graph: [], graphText: '', remoteNames: [], stashes: [],
    tags: [], submodules: '', opState: null, flow: null, prs: [], prError: null, isLoading: true,
  }))
  const graphScope = f.graphCurrent ? ['HEAD'] : ['--all']
  const [branches, remoteBranches, log, stashes, tags, submodules, opState, repoSettings] = await Promise.all([
    git($, cwd, ['for-each-ref', '--sort=-committerdate', BRANCH_FORMAT, 'refs/heads']),
    git($, cwd, ['for-each-ref', '--sort=-committerdate', REMOTE_BRANCH_FORMAT, 'refs/remotes']),
    git($, cwd, logArgs),
    git($, cwd, ['stash', 'list', STASH_FORMAT]),
    git($, cwd, ['for-each-ref', '--sort=-creatordate', `--count=${MAX_LIST}`, TAG_FORMAT, 'refs/tags']),
    git($, cwd, ['submodule', 'status', '--recursive']),
    opStateOf($, cwd),
    readSettings($, sel.repo),
  ])
  const [graph, graphText, remoteNames, flowCfg] = await Promise.all([
    f.graph ? git($, cwd, ['log', '--date-order', '-n', String(GRAPH_ROWS), GRAPH_FORMAT, ...graphScope]) : Promise.resolve(null),
    f.graph ? git($, cwd, ['log', '--graph', '--oneline', '--decorate', '-n', String(GRAPH_ROWS), ...graphScope]) : Promise.resolve(null),
    git($, cwd, ['remote']),
    git($, cwd, ['config', '--get-regexp', '^gitflow\\.']),
  ])
  await update($, settings, s => ({ ...s, [sel.repo]: repoSettings }))
  await update($, panel, p => ({
    worktree: cwd,
    branches: parseBranches(branches.stdout),
    remoteBranches: parseRemoteBranches(remoteBranches.stdout),
    log: parseLog(log.stdout),
    graph: graph ? parseGraphLog(graph.stdout) : [],
    graphText: graphText?.stdout ?? '',
    remoteNames: remoteNames.stdout.split('\n').filter(Boolean),
    stashes: parseStashes(stashes.stdout),
    tags: parseTags(tags.stdout),
    submodules: submodules.stdout.trim(),
    opState,
    flow: parseFlowConfig(flowCfg.stdout),
    prs: p && p.worktree === cwd ? p.prs : [],
    prError: p && p.worktree === cwd ? p.prError : null,
    isLoading: false,
  }))
  if (withPrs) await loadPrs($)
}

async function configValue($: EngineInterface, cwd: string, scope: string[], key: string): Promise<string> {
  const r = await git($, cwd, ['config', ...scope, '--get', key])
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

async function readSettings($: EngineInterface, path: string): Promise<RepoSettings> {
  const [remoteV, localName, localEmail, name, email] = await Promise.all([
    git($, path, ['remote', '-v']),
    configValue($, path, ['--local'], 'user.name'),
    configValue($, path, ['--local'], 'user.email'),
    configValue($, path, [], 'user.name'),
    configValue($, path, [], 'user.email'),
  ])
  return { remotes: parseRemotes(remoteV.stdout), localName, localEmail, name, email }
}

// ── fetch / pull / push ────────────────────────────────────────────────────

async function fetchRepo($: EngineInterface, path: string): Promise<string | null> {
  const r = await gitNet($, path, ['fetch', '--all', '--prune', '--quiet'])
  return r.exitCode === 0 ? null : explainNetworkError(lastLine(r.stderr) || `exit ${r.exitCode}`)
}

async function fetchAll($: EngineInterface) {
  const info = await read($, fetchInfo)
  if (info.isRunning) return
  await update($, fetchInfo, f => ({ ...f, isRunning: true }))
  const paths = allPaths()
  const results = await Promise.all(paths.map(p => fetchRepo($, p)))
  const errors = new Map(paths.map((p, i) => [p, results[i]]))
  const failed = results.filter(Boolean).length
  await update($, repos, list => list.map(r => (errors.has(r.path) ? { ...r, fetchError: errors.get(r.path) ?? null } : r)))
  await update($, fetchInfo, () => ({ at: Date.now(), isRunning: false, failed }))
  await refresh($)
  if (failed > 0) void $.ui.toast(`git fetch lỗi ở ${failed} repo`)
}

async function fetchOne($: EngineInterface, repoPath: string) {
  await act($, repoPath, 'Fetch', ['fetch', '--all', '--prune'], { net: true })
}

async function pullFf($: EngineInterface, cwd: string) {
  return act($, cwd, 'Pull', ['pull', '--ff-only'], { net: true })
}

async function pullMode($: EngineInterface, cwd: string, mode: 'merge' | 'rebase') {
  await act($, cwd, mode === 'rebase' ? 'Pull (rebase)' : 'Pull (merge)', ['pull', mode === 'rebase' ? '--rebase' : '--no-rebase'], { net: true })
}

/** Pulls every worktree that is behind its upstream, one at a time. */
async function pullAll($: EngineInterface) {
  const targets = (await read($, repos)).flatMap(r => r.worktrees).filter(w => w.upstream && w.behind > 0)
  if (targets.length === 0) {
    void $.ui.toast('Không có worktree nào cần pull')
    return
  }
  let failed = 0
  for (const w of targets) if (!(await pullFf($, w.path))) failed++
  void $.ui.toast(failed ? `Pull lỗi ${failed}/${targets.length} worktree` : `Đã pull ${targets.length} worktree`)
}

async function push($: EngineInterface, cwd: string, force = false) {
  const st = (await read($, repos)).flatMap(r => r.worktrees).find(w => w.path === cwd)
  const args = st?.upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD']
  if (force) args.push('--force-with-lease')
  await act($, cwd, force ? 'Push (force-with-lease)' : 'Push', args, { net: true })
}

// ── navigation ─────────────────────────────────────────────────────────────

async function openRepo($: EngineInterface, repoPath: string, worktree?: string) {
  const r = repoOf(await read($, repos), repoPath)
  const wt = worktree ?? r?.worktrees[0]?.path ?? repoPath
  const prev = await read($, selected)
  await update($, selected, () => ({ repo: repoPath, worktree: wt, tab: prev?.repo === repoPath ? prev.tab : 'changes' }))
  await update($, view, () => 'repo' as View)
  await update($, diff, () => null)
  await update($, confirm, () => null)
  await loadPanel($, false)
}

async function selectWorktree($: EngineInterface, wt: string) {
  await update($, selected, s => (s ? { ...s, worktree: wt } : s))
  await update($, diff, () => null)
  await loadPanel($, (await read($, selected))?.tab === 'prs')
}

async function setTab($: EngineInterface, tab: RepoTab) {
  await update($, selected, s => (s ? { ...s, tab } : s))
  await update($, confirm, () => null)
  if (tab === 'prs') await loadPrs($)
}

async function showView($: EngineInterface, next: View) {
  await update($, view, () => next)
  await update($, confirm, () => null)
  if (next === 'remote' && (await read($, remote)).at == null) await loadRemote($)
  if (next === 'accounts') await loadSshKeys($)
}

async function setDraft($: EngineInterface, key: string, value: string) {
  await update($, drafts, d => ({ ...d, [key]: value }))
}

async function toggleFlag($: EngineInterface, key: string) {
  await update($, flags, f => ({ ...f, [key]: !f[key] }))
  if (key === 'graph') await loadPanel($, false)
}

async function closeDiff($: EngineInterface) {
  await update($, diff, () => null)
}

async function closeResult($: EngineInterface) {
  await update($, result, () => null)
}

// ── confirmations ──────────────────────────────────────────────────────────

/** Asks before a destructive action; `key` is `action<SEP>arg<SEP>arg`, run by `confirmed`. */
async function ask($: EngineInterface, key: string, label: string, detail: string) {
  await update($, confirm, () => ({ key, label, detail }))
}

async function cancelConfirm($: EngineInterface) {
  await update($, confirm, () => null)
}

async function askClean($: EngineInterface, cwd: string) {
  const dry = await git($, cwd, ['clean', '-nd'])
  const list = dry.stdout.trim()
  if (!list) {
    void $.ui.toast('Không có file nào chưa theo dõi')
    return
  }
  await ask($, ['clean', cwd].join(SEP), 'Xoá các file chưa theo dõi?', truncateLines(list, 20))
}

async function confirmed($: EngineInterface) {
  const c = await read($, confirm)
  await update($, confirm, () => null)
  if (!c) return
  const [action = '', a = '', b = '', c3 = ''] = c.key.split(SEP)
  switch (action) {
    case 'discard-file': return discardPath($, a, b, c3 === 'untracked')
    case 'discard-all': return act($, a, 'Bỏ mọi thay đổi', ['restore', '--staged', '--worktree', '--source=HEAD', '--', '.'])
    case 'clean': return act($, a, 'Xoá file chưa theo dõi', ['clean', '-fd'])
    case 'delete-branch': return act($, a, `Xoá branch ${b}`, ['branch', c3 === 'force' ? '-D' : '-d', '--', b])
    case 'delete-remote-branch': return act($, a, `Xoá ${b} trên remote`, ['push', c3, '--delete', b], { net: true })
    case 'merge': return act($, a, `Merge ${b}`, ['merge', '--no-edit', b])
    case 'rebase': return act($, a, `Rebase lên ${b}`, ['rebase', b])
    case 'cherry-pick': return act($, a, `Cherry-pick ${b.slice(0, 8)}`, ['cherry-pick', b])
    case 'revert': return act($, a, `Revert ${b.slice(0, 8)}`, ['revert', '--no-edit', b])
    case 'reset': return act($, a, `Reset --${c3} về ${b.slice(0, 12)}`, ['reset', `--${c3}`, b])
    case 'stash-drop': return act($, a, `Xoá ${b}`, ['stash', 'drop', b])
    case 'tag-delete': return act($, a, `Xoá tag ${b}`, ['tag', '-d', b])
    case 'tag-delete-remote': return act($, a, `Xoá tag ${b} trên remote`, ['push', 'origin', '--delete', `refs/tags/${b}`], { net: true })
    case 'force-push': return push($, a, true)
    case 'pull-merge': return pullMode($, a, 'merge')
    case 'pull-rebase': return pullMode($, a, 'rebase')
    case 'worktree-remove': return removeWorktree($, a, b)
    case 'remote-remove': return act($, a, `Xoá remote ${b}`, ['remote', 'remove', b])
    case 'abort': return act($, a, `Huỷ ${b}`, [b, '--abort'])
    case 'logout': return logout($, a)
    case 'unwatch': return unwatch($, a)
    case 'flow-finish': return flowFinish($, a, b)
    case 'oauth-app-remove': return removeOAuthApp($, a as Provider, b)
    case 'publish': return publishFromDrafts($, a)
    default: return undefined
  }
}

// ── changes ────────────────────────────────────────────────────────────────

async function stage($: EngineInterface, cwd: string, path: string) {
  await act($, cwd, `Stage ${path}`, ['add', '--', path])
}

async function unstage($: EngineInterface, cwd: string, path: string) {
  await act($, cwd, `Unstage ${path}`, ['restore', '--staged', '--', path])
}

async function stageAll($: EngineInterface, cwd: string) {
  await act($, cwd, 'Stage tất cả', ['add', '-A'])
}

async function unstageAll($: EngineInterface, cwd: string) {
  await act($, cwd, 'Unstage tất cả', ['restore', '--staged', '--', '.'])
}

async function discardPath($: EngineInterface, cwd: string, path: string, isUntracked: boolean) {
  if (isUntracked) await act($, cwd, `Xoá ${path}`, ['clean', '-f', '--', path])
  else await act($, cwd, `Bỏ thay đổi ${path}`, ['restore', '--staged', '--worktree', '--source=HEAD', '--', path])
}

async function resolve($: EngineInterface, cwd: string, path: string, side: 'ours' | 'theirs') {
  const r = await git($, cwd, ['checkout', `--${side}`, '--', path])
  if (r.exitCode !== 0) {
    await report($, `Chọn ${side} cho ${path}`, r)
    return
  }
  await act($, cwd, `Dùng bản ${side === 'ours' ? 'của mình' : 'của họ'}: ${path}`, ['add', '--', path])
}

async function markResolved($: EngineInterface, cwd: string, path: string) {
  await act($, cwd, `Đánh dấu đã xử lý ${path}`, ['add', '--', path])
}

async function showFileDiff($: EngineInterface, cwd: string, f: ChangedFile, staged: boolean) {
  const r = f.isUntracked
    ? await git($, cwd, ['diff', '--no-index', '--', '/dev/null', f.path])
    : await git($, cwd, ['diff', ...(staged ? ['--cached'] : []), '--', f.path])
  const hunks = diffHunks(r.stdout)
  await update($, diff, () => ({
    title: `${f.path}${staged ? ' (đã stage)' : ''}`,
    source: hunks || 'Không có thay đổi dạng văn bản (file nhị phân hoặc chỉ đổi quyền).',
    format: hunks ? 'diff' : 'source',
  }))
}

async function commit($: EngineInterface, cwd: string) {
  const d = await read($, drafts)
  const f = await read($, flags)
  const message = (d[`commit:${cwd}`] ?? '').trim()
  if (!message && !f.amend) {
    void $.ui.toast('Nhập commit message trước')
    return
  }
  const args = ['commit', ...(f.amend ? ['--amend'] : []), ...(message ? ['-F', '-'] : ['--no-edit'])]
  const ok = await act($, cwd, f.amend ? 'Amend commit' : 'Commit', args, { stdin: message || undefined })
  if (!ok) return
  await setDraft($, `commit:${cwd}`, '')
  if (f.amend) await update($, flags, x => ({ ...x, amend: false }))
  if (f.pushAfterCommit) await push($, cwd)
}

// ── branches ───────────────────────────────────────────────────────────────

async function validBranchName($: EngineInterface, cwd: string, name: string): Promise<boolean> {
  const r = await git($, cwd, ['check-ref-format', '--branch', name])
  if (r.exitCode !== 0 || name.startsWith('-')) {
    void $.ui.toast(`Tên branch không hợp lệ: ${name}`)
    return false
  }
  return true
}

async function checkout($: EngineInterface, cwd: string, name: string) {
  await act($, cwd, `Checkout ${name}`, ['switch', '--', name])
}

async function checkoutRemote($: EngineInterface, cwd: string, remoteName: string) {
  const local = remoteName.split('/').slice(1).join('/')
  const p = await read($, panel)
  if (p?.branches.some(b => b.name === local)) await act($, cwd, `Checkout ${local}`, ['switch', '--', local])
  else await act($, cwd, `Checkout ${remoteName}`, ['switch', '--track', remoteName])
}

async function createBranch($: EngineInterface, cwd: string, from?: string) {
  const d = await read($, drafts)
  const name = `${d[`prefix:${cwd}`] ?? ''}${(d[`branch:${cwd}`] ?? '').trim()}`
  if (!name || !(await validBranchName($, cwd, name))) return
  const ok = await act($, cwd, `Tạo branch ${name}`, ['switch', '-c', name, ...(from ? [from] : [])])
  if (ok) await setDraft($, `branch:${cwd}`, '')
}

async function pushBranch($: EngineInterface, cwd: string, name: string) {
  await act($, cwd, `Push ${name}`, ['push', '-u', 'origin', `${name}:${name}`], { net: true })
}

async function renameBranch($: EngineInterface, cwd: string, name: string) {
  const d = await read($, drafts)
  const to = (d[`rename:${cwd}`] ?? '').trim()
  if (!to || !(await validBranchName($, cwd, to))) return
  const ok = await act($, cwd, `Đổi tên ${name} → ${to}`, ['branch', '-m', name, to])
  if (ok) await setDraft($, `rename:${cwd}`, '')
}

async function addWorktree($: EngineInterface, repoPath: string, cwd: string, branch: string) {
  const target = `${repoPath}/.worktrees/${worktreeFolder(branch)}`
  const ok = await act($, cwd, `Tạo worktree cho ${branch}`, ['worktree', 'add', target, branch], { okText: `Đã tạo worktree ${target}` })
  if (ok) await openRepo($, repoPath, target)
}

async function removeWorktree($: EngineInterface, repoPath: string, wt: string) {
  await act($, repoPath, `Xoá worktree ${wt}`, ['worktree', 'remove', wt])
}

// ── history ────────────────────────────────────────────────────────────────

async function showCommit($: EngineInterface, cwd: string, hash: string) {
  const [stat, patch] = await Promise.all([
    git($, cwd, ['show', '--stat', '--format=%H%n%an <%ae>%n%cd%n%n%B', hash]),
    git($, cwd, ['show', '--format=', '--patch', hash]),
  ])
  const hunks = diffHunks(patch.stdout, 800)
  await update($, diff, () => ({
    title: `Commit ${hash.slice(0, 10)}`,
    source: `${truncateLines(stat.stdout.trim(), 60)}${hunks ? `\n\n${hunks}` : ''}`,
    format: 'source',
  }))
}

/** Opens a commit: its content in the diff box, and its actions under its row. */
async function pickCommit($: EngineInterface, cwd: string, hash: string) {
  await setDraft($, `open:${cwd}`, hash)
  await showCommit($, cwd, hash)
}

async function tagAt($: EngineInterface, cwd: string, hash: string) {
  const d = await read($, drafts)
  const name = (d[`tag:${cwd}`] ?? '').trim()
  const message = (d[`tagmsg:${cwd}`] ?? '').trim()
  if (!name) {
    void $.ui.toast('Nhập tên tag trước (tab Tag)')
    return
  }
  const check = await git($, cwd, ['check-ref-format', `refs/tags/${name}`])
  if (check.exitCode !== 0 || name.startsWith('-')) {
    void $.ui.toast(`Tên tag không hợp lệ: ${name}`)
    return
  }
  const ok = await act($, cwd, `Tạo tag ${name}`, message ? ['tag', '-a', name, '-F', '-', hash] : ['tag', name, hash], { stdin: message || undefined })
  if (ok) {
    await setDraft($, `tag:${cwd}`, '')
    await setDraft($, `tagmsg:${cwd}`, '')
  }
}

async function branchAt($: EngineInterface, cwd: string, hash: string) {
  await createBranch($, cwd, hash)
}

// ── stash ──────────────────────────────────────────────────────────────────

async function stashSave($: EngineInterface, cwd: string) {
  const d = await read($, drafts)
  const f = await read($, flags)
  const message = (d[`stash:${cwd}`] ?? '').trim()
  const ok = await act($, cwd, 'Stash', ['stash', 'push', ...(f.stashUntracked ? ['-u'] : []), ...(message ? ['-m', message] : [])])
  if (ok) await setDraft($, `stash:${cwd}`, '')
}

async function stashApply($: EngineInterface, cwd: string, ref: string, pop: boolean) {
  await act($, cwd, `${pop ? 'Pop' : 'Apply'} ${ref}`, ['stash', pop ? 'pop' : 'apply', ref])
}

async function showStash($: EngineInterface, cwd: string, ref: string) {
  const r = await git($, cwd, ['stash', 'show', '-p', '--include-untracked', ref])
  const fallback = r.exitCode === 0 ? r : await git($, cwd, ['stash', 'show', '-p', ref])
  const hunks = diffHunks(fallback.stdout, 800)
  await update($, diff, () => ({ title: ref, source: hunks || '(trống)', format: hunks ? 'diff' : 'source' }))
}

// ── tags ───────────────────────────────────────────────────────────────────

async function createTag($: EngineInterface, cwd: string) {
  await tagAt($, cwd, 'HEAD')
}

async function pushTag($: EngineInterface, cwd: string, name: string) {
  await act($, cwd, `Push tag ${name}`, ['push', 'origin', `refs/tags/${name}`], { net: true })
}

async function pushAllTags($: EngineInterface, cwd: string) {
  await act($, cwd, 'Push mọi tag', ['push', 'origin', '--tags'], { net: true })
}

// ── advanced ───────────────────────────────────────────────────────────────

async function continueOp($: EngineInterface, cwd: string, op: string) {
  const env = { ...GIT_ENV, GIT_EDITOR: 'true' }
  await setBusy($, cwd, `${op} --continue`)
  try {
    const r = await $.process.run(['git', op, '--continue'], { cwd, env, timeoutMs: 120_000 })
    await report($, `Tiếp tục ${op}`, r)
  } catch (err) {
    await report($, `Tiếp tục ${op}`, { exitCode: 1, stdout: '', stderr: String(err) })
  } finally {
    await setBusy($, cwd, null)
    await refreshFor($, cwd)
  }
}

async function submoduleUpdate($: EngineInterface, cwd: string) {
  await act($, cwd, 'Cập nhật submodule', ['submodule', 'update', '--init', '--recursive'], { net: true })
}

async function pruneWorktrees($: EngineInterface, repoPath: string) {
  await act($, repoPath, 'Dọn worktree đã mất', ['worktree', 'prune', '-v'])
}

async function openIn($: EngineInterface, path: string, app: 'finder' | 'terminal' | 'vscode' | 'sourcetree') {
  const argv = app === 'finder' ? ['open', path]
    : app === 'terminal' ? ['open', '-a', 'Terminal', path]
      : app === 'vscode' ? ['open', '-a', 'Visual Studio Code', path]
        : ['open', '-a', 'Sourcetree', path]
  const r = await $.process.run(argv).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  if (r.exitCode !== 0) void $.ui.toast(`Không mở được: ${lastLine(r.stderr)}`)
}

async function openUrl($: EngineInterface, url: string) {
  if (!/^https:\/\//.test(url)) return
  const r = await $.process.run(['open', url]).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  if (r.exitCode !== 0) void $.ui.toast(`Không mở được trình duyệt: ${lastLine(r.stderr)}`)
}

// ── settings ───────────────────────────────────────────────────────────────

async function setRemoteUrl($: EngineInterface, repoPath: string, name: string, url: string) {
  const value = url.trim()
  if (!isValidRemoteUrl(value)) {
    void $.ui.toast(`URL không hợp lệ: ${value}`)
    return
  }
  await act($, repoPath, `Đổi ${name} → ${value}`, ['remote', 'set-url', name, value])
}

async function addRemote($: EngineInterface, repoPath: string) {
  const d = await read($, drafts)
  const name = (d[`remotename:${repoPath}`] ?? '').trim()
  const url = (d[`remoteurl:${repoPath}`] ?? '').trim()
  if (!/^[a-z0-9._-]+$/i.test(name) || !isValidRemoteUrl(url)) {
    void $.ui.toast('Tên remote hoặc URL không hợp lệ')
    return
  }
  const ok = await act($, repoPath, `Thêm remote ${name}`, ['remote', 'add', name, url])
  if (ok) {
    await setDraft($, `remotename:${repoPath}`, '')
    await setDraft($, `remoteurl:${repoPath}`, '')
  }
}

async function setIdentity($: EngineInterface, repoPath: string, key: 'user.name' | 'user.email', value: string) {
  const v = value.trim()
  if (key === 'user.email' && v && !/^[^\s@]+@[^\s@]+$/.test(v)) {
    void $.ui.toast(`Email không hợp lệ: ${v}`)
    return
  }
  const r = v ? await git($, repoPath, ['config', '--local', key, v]) : await git($, repoPath, ['config', '--local', '--unset', key])
  // exit 5 on --unset: the key was not set, which is what was asked
  await report($, v ? `Đặt ${key} = ${v}` : `${key} dùng lại global`, r.exitCode === 5 && !v ? { ...r, exitCode: 0 } : r)
  await refreshFor($, repoPath)
}

// ── watched repos ──────────────────────────────────────────────────────────

async function saveExtra($: EngineInterface) {
  await $.store.set('extraRepos', extraRepos)
}

async function watch($: EngineInterface, path: string) {
  if (!allPaths().includes(path)) {
    extraRepos = [...extraRepos, path]
    await saveExtra($)
  }
  await refresh($)
  await markOnDisk($)
}

async function unwatch($: EngineInterface, path: string) {
  extraRepos = extraRepos.filter(p => p !== path)
  await saveExtra($)
  if ((await read($, selected))?.repo === path) {
    await update($, selected, () => null)
    await update($, view, () => 'repos' as View)
  }
  await refresh($)
}

// ── accounts ───────────────────────────────────────────────────────────────

/** Accounts saved by an earlier version lack the sign-in method: they were token accounts. */
function normalizeAccount(a: Partial<Account>): Account {
  return {
    id: a.id ?? '',
    provider: a.provider ?? 'bitbucket',
    host: a.host ?? '',
    method: a.method ?? 'token',
    protocol: a.protocol ?? (a.method === 'ssh' ? 'ssh' : 'https'),
    sshKey: a.sshKey ?? '',
    username: a.username ?? '',
    gitUser: a.gitUser ?? a.username ?? '',
    expiresAt: a.expiresAt ?? null,
    email: a.email ?? '',
    scopes: a.scopes ?? [],
    verifiedAt: a.verifiedAt ?? null,
    error: a.error ?? null,
  }
}

async function loadAccounts($: EngineInterface) {
  const stored = await $.store.get('accounts')
  const list = Array.isArray(stored)
    ? (stored as Partial<Account>[]).filter(a => a && typeof a.id === 'string').map(normalizeAccount)
    : []
  await update($, accounts, () => list)
}

async function saveAccounts($: EngineInterface, list: Account[]) {
  await $.store.set('accounts', list)
  await update($, accounts, () => list)
}

// Secrets live in git's credential store (the macOS Keychain through credential.helper), fed on stdin.
function credentialInput(host: string, user: string, password?: string): string {
  return `protocol=https\nhost=${host}\nusername=${user}\n${password ? `password=${password}\n` : ''}\n`
}

async function readSecret($: EngineInterface, host: string, user: string): Promise<string | null> {
  const r = await git($, '/', ['credential', 'fill'], 15_000, credentialInput(host, user))
  if (r.exitCode !== 0) return null
  return /^password=(.*)$/m.exec(r.stdout)?.[1] ?? null
}

async function saveSecret($: EngineInterface, host: string, user: string, secret: string): Promise<boolean> {
  return (await git($, '/', ['credential', 'approve'], 15_000, credentialInput(host, user, secret))).exitCode === 0
}

async function dropSecret($: EngineInterface, host: string, user: string) {
  await git($, '/', ['credential', 'reject'], 15_000, credentialInput(host, user))
}

// Refresh tokens and app secrets are kept under hosts of their own, so git never sends them anywhere.
function refreshHost(host: string): string {
  return `refresh-token.${host}.repo-pane.invalid`
}

function appSecretHost(host: string): string {
  return `oauth-app.${host}.repo-pane.invalid`
}

/** The account's token (an OAuth one refreshed first when it is about to run out), or null. */
async function tokenOf($: EngineInterface, a: Account): Promise<string | null> {
  await refreshExpiring($)
  return readSecret($, a.host, a.gitUser)
}

async function setForm($: EngineInterface, field: keyof AccountForm, value: string) {
  await update($, accountForm, f => {
    if (field === 'provider') return { ...f, provider: value as Provider, host: defaultHost(value as Provider) }
    // an SSH-only sign-in can only talk SSH
    if (field === 'method') return { ...f, method: value as SignInMethod, protocol: value === 'ssh' ? 'ssh' : f.protocol }
    if (field === 'protocol') return { ...f, protocol: f.method === 'ssh' ? 'ssh' : (value as GitProtocol) }
    return { ...f, [field]: value }
  })
  if ((field === 'method' && value === 'ssh') || (field === 'protocol' && value === 'ssh')) await loadSshKeys($)
}

// ── OAuth ──────────────────────────────────────────────────────────────────

/**
 * A one-shot local web server for the OAuth redirect: it binds 127.0.0.1, opens the sign-in page,
 * answers the browser once the provider sends it back, and prints `{"code": ...}` or `{"error": ...}`.
 */
const CALLBACK_SERVER = [
  'import sys, json, time, html, webbrowser, urllib.parse',
  'from http.server import BaseHTTPRequestHandler, HTTPServer',
  'port, state, url = int(sys.argv[1]), sys.argv[2], sys.argv[3]',
  'result = {}',
  'class H(BaseHTTPRequestHandler):',
  '    def do_GET(self):',
  '        u = urllib.parse.urlparse(self.path)',
  "        if u.path != '/callback':",
  '            self.send_response(404); self.end_headers(); return',
  '        q = urllib.parse.parse_qs(u.query)',
  "        if q.get('state', [''])[0] != state:",
  "            result['error'] = 'state không khớp'",
  "        elif 'code' in q:",
  "            result['code'] = q['code'][0]",
  '        else:',
  "            result['error'] = q.get('error_description', q.get('error', ['bị từ chối']))[0]",
  "        msg = 'Đăng nhập xong. Quay lại Claude.' if 'code' in result else 'Đăng nhập lỗi: ' + html.escape(result['error'])",
  "        body = ('<!doctype html><meta charset=utf-8><body style=\"font:16px system-ui;padding:48px\"><h2>' + msg + '</h2>').encode()",
  '        self.send_response(200)',
  "        self.send_header('Content-Type', 'text/html; charset=utf-8')",
  "        self.send_header('Content-Length', str(len(body)))",
  '        self.end_headers(); self.wfile.write(body)',
  '    def log_message(self, *a): pass',
  'try:',
  "    srv = HTTPServer(('127.0.0.1', port), H)",
  'except OSError as e:',
  "    print(json.dumps({'error': 'cổng %d đang bận: %s' % (port, e)})); sys.exit(0)",
  'srv.timeout = 5',
  'webbrowser.open(url)',
  'deadline = time.time() + 300',
  'while not result and time.time() < deadline:',
  '    srv.handle_request()',
  "print(json.dumps(result or {'error': 'hết 5 phút chờ đăng nhập'}))",
].join('\n')

type DevicePoll = { host: string; clientId: string; deviceCode: string; interval: number; until: number }
let devicePoll: DevicePoll | null = null
let isRefreshingTokens = false

async function loadOAuthApps($: EngineInterface) {
  const stored = await $.store.get('oauthApps')
  const fromPane = Array.isArray(stored) ? (stored as OAuthApp[]).filter(a => a && typeof a.clientId === 'string') : []
  const shared: OAuthApp[] = cfg.apps.map(a => ({
    provider: a.provider, host: a.host, clientId: a.clientId, hasSecret: a.provider !== 'bitbucket' || Boolean(a.secret), source: 'settings',
  }))
  // an app set in the plugin's settings (shared with a team) wins over one saved from the pane
  const merged = [...shared, ...fromPane.filter(p => !shared.some(s => s.provider === p.provider && s.host === p.host))]
  await update($, oauthApps, () => merged)
}

/** The OAuth app for a provider and host, with its secret (Bitbucket) read from settings or the Keychain. */
async function appFor($: EngineInterface, provider: Provider, host: string): Promise<{ clientId: string; secret: string } | null> {
  const shared = cfg.apps.find(a => a.provider === provider && a.host === host)
  if (shared) return { clientId: shared.clientId, secret: shared.secret }
  const app = (await read($, oauthApps)).find(a => a.provider === provider && a.host === host)
  if (!app) return null
  const secret = provider === 'bitbucket' ? (await readSecret($, appSecretHost(host), app.clientId)) ?? '' : ''
  return { clientId: app.clientId, secret }
}

function oauthHostFor(provider: Provider, form: AccountForm): string {
  if (provider === 'bitbucket') return 'bitbucket.org'
  return (form.provider === provider && form.host ? form.host : defaultHost(provider)).trim().toLowerCase()
}

/** Saves the OAuth app typed in the pane; a Bitbucket consumer's secret is read from the clipboard. */
async function saveOAuthApp($: EngineInterface, provider: Provider) {
  const d = await read($, drafts)
  const form = await read($, accountForm)
  const host = oauthHostFor(provider, form)
  const clientId = (d[`oauthid:${provider}`] ?? '').trim()
  if (!/^[\w.-]{6,200}$/.test(clientId)) {
    void $.ui.toast('Client ID / Key không hợp lệ')
    return
  }
  if (provider === 'bitbucket') {
    const clip = await $.process.run(['pbpaste']).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))
    const secret = clip.stdout.trim()
    if (!/^[\x21-\x7e]{8,512}$/.test(secret)) {
      void $.ui.toast('Copy Secret của consumer vào clipboard rồi bấm lại')
      return
    }
    if (!(await saveSecret($, appSecretHost(host), clientId, secret))) {
      void $.ui.toast('Không lưu được secret vào Keychain')
      return
    }
    await $.process.run(['pbcopy'], { stdin: '' }).catch(() => undefined)
  }
  const stored = await $.store.get('oauthApps')
  const list = (Array.isArray(stored) ? (stored as OAuthApp[]) : []).filter(a => !(a.provider === provider && a.host === host))
  await $.store.set('oauthApps', [...list, { provider, host, clientId, hasSecret: provider !== 'bitbucket' || true, source: 'pane' }])
  await setDraft($, `oauthid:${provider}`, '')
  await update($, flags, f => ({ ...f, [`oauthSetup:${provider}`]: false }))
  await loadOAuthApps($)
  void $.ui.toast(`Đã lưu OAuth app ${providerLabel(provider)} (${host})`)
}

async function removeOAuthApp($: EngineInterface, provider: Provider, host: string) {
  const stored = await $.store.get('oauthApps')
  const list = Array.isArray(stored) ? (stored as OAuthApp[]) : []
  const gone = list.find(a => a.provider === provider && a.host === host)
  if (gone && provider === 'bitbucket') await dropSecret($, appSecretHost(host), gone.clientId)
  await $.store.set('oauthApps', list.filter(a => a !== gone))
  await loadOAuthApps($)
}

/** The Bitbucket workspace most watched repos live in, for the consumer page. */
function guessWorkspace(list: readonly RepoStatus[]): string {
  const counts = new Map<string, number>()
  for (const r of list) {
    const m = /^bitbucket\.org\/([^/]+)\//.exec(r.remote ?? '')
    if (m?.[1]) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

async function openOAuthAppPage($: EngineInterface, provider: Provider) {
  const d = await read($, drafts)
  const form = await read($, accountForm)
  const ws = (d.oauthws ?? '').trim() || guessWorkspace(await read($, repos))
  await openUrl($, oauthAppPage(provider, oauthHostFor(provider, form), ws))
}

async function oauthFailed($: EngineInterface, provider: Provider, message: string) {
  devicePoll = null
  await update($, oauth, () => null)
  await update($, result, () => ({ label: `Đăng nhập ${providerLabel(provider)}`, ok: false, text: message, at: Date.now() }))
  void $.ui.toast(`Đăng nhập ${providerLabel(provider)} lỗi: ${message}`)
}

async function cancelOAuth($: EngineInterface) {
  devicePoll = null
  await update($, oauth, () => null)
}

/** One click: the browser signs in and comes back (Bitbucket, GitLab), or a device code (GitHub). */
async function oauthLogin($: EngineInterface, provider: Provider) {
  if (await read($, oauth)) {
    void $.ui.toast('Đang có một lần đăng nhập dở, huỷ nó trước')
    return
  }
  const form = await read($, accountForm)
  const host = oauthHostFor(provider, form)
  const app = await appFor($, provider, host)
  if (!app || (provider === 'bitbucket' && !app.secret)) {
    await update($, flags, f => ({ ...f, [`oauthSetup:${provider}`]: true }))
    void $.ui.toast(`Chưa cấu hình OAuth app cho ${providerLabel(provider)} (${host})`)
    return
  }
  if (provider === 'github') {
    await deviceLogin($, host, app.clientId)
    return
  }
  const state = randomToken(16)
  const verifier = randomToken(48)
  const url = authorizeUrl(provider, host, app.clientId, state, provider === 'gitlab' ? await pkceChallenge(verifier) : '')
  await update($, oauth, () => ({
    provider, host, stage: 'browser', userCode: '', verifyUrl: url, message: 'Đã mở trình duyệt: đăng nhập và cho phép truy cập, rồi quay lại đây.',
  }))
  const r = await $.process.run(['python3', '-I', '-c', CALLBACK_SERVER, String(53682), state, url], { timeoutMs: 330_000 })
    .catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  if (!(await read($, oauth))) return // cancelled meanwhile
  let got: { code?: string; error?: string }
  try {
    got = JSON.parse(r.stdout.trim().split('\n').pop() || '{}') as { code?: string; error?: string }
  } catch {
    got = { error: lastLine(r.stderr) || 'không nhận được phản hồi từ trình duyệt (cần python3)' }
  }
  if (!got.code) {
    await oauthFailed($, provider, got.error ?? 'không nhận được mã đăng nhập')
    return
  }
  await update($, oauth, o => (o ? { ...o, stage: 'exchange', message: 'Đang lấy token…' } : o))
  const req = tokenRequest(provider, host, app, { code: got.code, verifier })
  try {
    const res = await $.http.fetch(req.url, { method: 'POST', headers: req.headers, body: req.body })
    const tok = parseTokenResponse(res.text)
    if ('error' in tok) {
      await oauthFailed($, provider, tok.error)
      return
    }
    await completeOAuth($, provider, host, tok)
  } catch (err) {
    await oauthFailed($, provider, String(err))
  }
}

async function deviceLogin($: EngineInterface, host: string, clientId: string) {
  const req = deviceCodeRequest(host, clientId)
  try {
    const res = await $.http.fetch(req.url, { method: 'POST', headers: req.headers, body: req.body })
    const dc = parseDeviceCode(res.text)
    if ('error' in dc) {
      await oauthFailed($, 'github', `${dc.error} (OAuth app đã bật "Enable Device Flow" chưa?)`)
      return
    }
    await $.process.run(['pbcopy'], { stdin: dc.userCode }).catch(() => undefined)
    await update($, oauth, () => ({
      provider: 'github', host, stage: 'device', userCode: dc.userCode, verifyUrl: dc.verifyUrl,
      message: 'Mã đã được copy: dán vào trang vừa mở rồi bấm Authorize. Pane tự nhận khi xong.',
    }))
    await openUrl($, dc.verifyUrl)
    devicePoll = { host, clientId, deviceCode: dc.deviceCode, interval: dc.interval, until: Date.now() + dc.expiresIn * 1000 }
    $.clock.after(dc.interval * 1000, () => void pollDevice($))
  } catch (err) {
    await oauthFailed($, 'github', String(err))
  }
}

async function pollDevice($: EngineInterface) {
  const p = devicePoll
  if (!p) return
  if (Date.now() > p.until) {
    await oauthFailed($, 'github', 'mã đã hết hạn, bấm đăng nhập lại')
    return
  }
  const req = deviceTokenRequest(p.host, p.clientId, p.deviceCode)
  let text = ''
  try {
    text = (await $.http.fetch(req.url, { method: 'POST', headers: req.headers, body: req.body })).text
  } catch {
    $.clock.after(p.interval * 1000, () => void pollDevice($))
    return
  }
  const v = (() => {
    try {
      return JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
    } catch {
      return { error: 'phản hồi không đọc được' }
    }
  })()
  if (devicePoll !== p) return // cancelled meanwhile
  if (v.access_token) {
    devicePoll = null
    await completeOAuth($, 'github', p.host, { accessToken: v.access_token, refreshToken: v.refresh_token ?? '', expiresIn: v.expires_in ?? null })
    return
  }
  if (v.error === 'authorization_pending' || v.error === 'slow_down') {
    if (v.error === 'slow_down') p.interval += 5
    $.clock.after(p.interval * 1000, () => void pollDevice($))
    return
  }
  await oauthFailed($, 'github', v.error_description ?? v.error ?? 'bị từ chối')
}

/** Asks who the token belongs to, saves it for git and the API, and records the account. */
async function completeOAuth($: EngineInterface, provider: Provider, host: string, tok: TokenSet) {
  const probe = { provider, method: 'oauth' as const, email: '' }
  let username = ''
  try {
    const res = await $.http.fetch(userUrl(provider, host), { headers: authHeaders(probe, tok.accessToken) })
    if (!res.ok) {
      await oauthFailed($, provider, `không đọc được tài khoản: ${apiError(res.status, res.text)}`)
      return
    }
    username = loginOf(provider, res.text)
  } catch (err) {
    await oauthFailed($, provider, String(err))
    return
  }
  if (!username) {
    await oauthFailed($, provider, 'không đọc được username của tài khoản')
    return
  }
  const form = await read($, accountForm)
  const account: Account = {
    id: `${provider}:${host}:${username}`,
    provider,
    host,
    method: 'oauth',
    protocol: form.provider === provider ? form.protocol : 'https',
    sshKey: form.provider === provider && form.protocol === 'ssh' ? form.sshKey : '',
    username,
    gitUser: oauthGitUser(provider, username),
    expiresAt: tok.expiresIn ? Date.now() + tok.expiresIn * 1000 : null,
    email: '',
    scopes: form.provider === provider ? splitList(form.scopes) : [],
    verifiedAt: Date.now(),
    error: null,
  }
  const saved = await saveSecret($, host, account.gitUser, tok.accessToken)
  if (tok.refreshToken) await saveSecret($, refreshHost(host), username, tok.refreshToken)
  if (!saved) {
    await oauthFailed($, provider, 'không lưu được token vào Keychain')
    return
  }
  const list = (await read($, accounts)).filter(x => x.id !== account.id)
  await saveAccounts($, [...list, account])
  await update($, oauth, () => null)
  await update($, result, () => ({
    label: `Đăng nhập ${providerLabel(provider)}`,
    ok: true,
    text: `${username}@${host} — token đã lưu vào Keychain${account.expiresAt ? ', tự làm mới khi sắp hết hạn' : ''}.`,
    at: Date.now(),
  }))
  void $.ui.toast(`Đã đăng nhập ${username}@${host}`)
  void fetchAll($)
}

/** Refreshes every OAuth token that runs out within ten minutes, for git and the API alike. */
async function refreshExpiring($: EngineInterface) {
  if (isRefreshingTokens) return
  const due = (await read($, accounts)).filter(a => a.method === 'oauth' && a.expiresAt && a.expiresAt - Date.now() < 10 * 60_000)
  if (due.length === 0) return
  isRefreshingTokens = true
  try {
    for (const a of due) await refreshAccount($, a)
  } finally {
    isRefreshingTokens = false
  }
}

async function refreshAccount($: EngineInterface, a: Account): Promise<boolean> {
  const mark = async (error: string | null, expiresAt?: number | null) => {
    const list = (await read($, accounts)).map(x => (x.id === a.id ? { ...x, error, expiresAt: expiresAt === undefined ? x.expiresAt : expiresAt } : x))
    await saveAccounts($, list)
  }
  const app = await appFor($, a.provider, a.host)
  const refreshToken = await readSecret($, refreshHost(a.host), a.username)
  if (!app || !refreshToken) {
    await mark('phiên OAuth hết hạn, đăng nhập lại')
    return false
  }
  const req = tokenRequest(a.provider, a.host, app, { refreshToken })
  try {
    const res = await $.http.fetch(req.url, { method: 'POST', headers: req.headers, body: req.body })
    const tok = parseTokenResponse(res.text)
    if ('error' in tok) {
      await mark(`làm mới token lỗi: ${tok.error} — đăng nhập lại`)
      return false
    }
    await saveSecret($, a.host, a.gitUser, tok.accessToken)
    if (tok.refreshToken) await saveSecret($, refreshHost(a.host), a.username, tok.refreshToken)
    await mark(null, tok.expiresIn ? Date.now() + tok.expiresIn * 1000 : null)
    return true
  } catch (err) {
    await mark(`làm mới token lỗi: ${String(err)}`)
    return false
  }
}

async function openTokenPage($: EngineInterface) {
  const f = await read($, accountForm)
  await openUrl($, tokenPageUrl(f.provider, f.host || defaultHost(f.provider)))
}

async function verifyToken($: EngineInterface, a: Account, token: string): Promise<{ ok: boolean; login: string; error: string | null }> {
  try {
    const res = await $.http.fetch(verifyUrl(a), { headers: authHeaders(a, token) })
    if (!res.ok) {
      const hint = res.status === 401 ? ' — token, username hoặc email chưa đúng' : res.status === 403 ? ' — token thiếu quyền' : ''
      return { ok: false, login: '', error: `${apiError(res.status, res.text)}${hint}` }
    }
    return { ok: true, login: loginOf(a.provider, res.text), error: null }
  } catch (err) {
    return { ok: false, login: '', error: `Không gọi được ${a.host}: ${String(err)}` }
  }
}

/**
 * Signs in with the token the person copied: it is read from the clipboard (never typed or shown in the pane),
 * checked against the provider, saved to git's credential store, and the clipboard is cleared.
 */
async function login($: EngineInterface) {
  const f = await read($, accountForm)
  const host = (f.host || defaultHost(f.provider)).trim().toLowerCase()
  const username = f.username.trim()
  if (!/^[a-z0-9.-]+$/.test(host) || !username || /[\s\n]/.test(username)) {
    void $.ui.toast('Nhập host và username hợp lệ')
    return
  }
  if (f.provider === 'bitbucket' && !/^[^\s@]+@[^\s@]+$/.test(f.email.trim())) {
    void $.ui.toast('Bitbucket cần email Atlassian để gọi API')
    return
  }
  const clip = await $.process.run(['pbpaste']).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))
  const token = clip.stdout.trim()
  if (clip.exitCode !== 0 || !/^[\x21-\x7e]{8,4096}$/.test(token)) {
    void $.ui.toast('Clipboard chưa có token (copy token rồi bấm lại)')
    return
  }
  const draft: Account = {
    id: `${f.provider}:${host}:${username}`,
    provider: f.provider,
    host,
    method: 'token',
    protocol: f.protocol,
    sshKey: f.protocol === 'ssh' ? f.sshKey : '',
    username,
    gitUser: username,
    expiresAt: null,
    email: f.email.trim(),
    scopes: splitList(f.scopes),
    verifiedAt: null,
    error: null,
  }
  await setBusy($, 'login', 'Đăng nhập')
  try {
    const check = await verifyToken($, draft, token)
    if (!check.ok) {
      await update($, result, () => ({ label: `Đăng nhập ${providerLabel(f.provider)}`, ok: false, text: check.error ?? '', at: Date.now() }))
      void $.ui.toast(`Đăng nhập lỗi: ${check.error}`)
      return
    }
    // GitHub and GitLab answer the token's own login: that is the name git must send
    const name = f.provider !== 'bitbucket' && check.login ? check.login : username
    const account: Account = { ...draft, username: name, gitUser: name, verifiedAt: Date.now() }
    account.id = `${account.provider}:${account.host}:${account.username}`
    if (!(await saveSecret($, account.host, account.gitUser, token))) {
      void $.ui.toast('Không lưu được token vào Keychain')
      return
    }
    await $.process.run(['pbcopy'], { stdin: '' }).catch(() => undefined)
    const list = (await read($, accounts)).filter(x => x.id !== account.id)
    await saveAccounts($, [...list, account])
    await update($, accountForm, x => ({ ...x, username: '', email: '' }))
    await update($, result, () => ({
      label: `Đăng nhập ${providerLabel(account.provider)}`,
      ok: true,
      text: `${account.username}@${account.host} — token đã lưu vào Keychain qua git credential, clipboard đã được xoá.`,
      at: Date.now(),
    }))
    void $.ui.toast(`Đã đăng nhập ${account.username}@${account.host}`)
    void fetchAll($)
  } finally {
    await setBusy($, 'login', null)
  }
}

async function verifyAccount($: EngineInterface, id: string) {
  const a = (await read($, accounts)).find(x => x.id === id)
  if (!a) return
  if (a.method === 'ssh') {
    const t = await testSsh($, a.host, a.sshKey)
    const list = (await read($, accounts)).map(x => (x.id === id ? { ...x, verifiedAt: t.ok ? Date.now() : x.verifiedAt, error: t.ok ? null : 'SSH key không vào được' } : x))
    await saveAccounts($, list)
    return
  }
  const token = await tokenOf($, a)
  const check = token ? await verifyToken($, a, token) : { ok: false, login: '', error: 'Không thấy token trong Keychain' }
  const list = (await read($, accounts)).map(x => (x.id === id ? { ...x, verifiedAt: check.ok ? Date.now() : x.verifiedAt, error: check.error } : x))
  await saveAccounts($, list)
  void $.ui.toast(check.ok ? `${a.username}@${a.host}: token còn dùng được` : `${a.username}@${a.host}: ${check.error}`)
}

async function logout($: EngineInterface, id: string) {
  const a = (await read($, accounts)).find(x => x.id === id)
  if (!a) return
  await dropSecret($, a.host, a.gitUser)
  if (a.method === 'oauth') await dropSecret($, refreshHost(a.host), a.username)
  await saveAccounts($, (await read($, accounts)).filter(x => x.id !== id))
  void $.ui.toast(`Đã đăng xuất ${a.username}@${a.host}`)
}

// ── SSH keys ───────────────────────────────────────────────────────────────

/** The key pairs in ~/.ssh (each private key beside its .pub), with fingerprints and comments. */
async function loadSshKeys($: EngineInterface) {
  if (!cfg.home) return
  const r = await $.process.run(['find', `${cfg.home}/.ssh`, '-maxdepth', '1', '-name', '*.pub']).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))
  const pubs = r.stdout.split('\n').filter(Boolean).sort()
  const keys = await Promise.all(pubs.map(async pub => {
    const fp = await $.process.run(['ssh-keygen', '-lf', pub]).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))
    return { path: pub.replace(/\.pub$/, ''), ...parseKeyFingerprint(fp.stdout) }
  }))
  await update($, ssh, s => ({ ...s, keys }))
}

/** A new ed25519 key in ~/.ssh, never over an existing one; it becomes the form's key and its public half is copied. */
async function generateSshKey($: EngineInterface) {
  const form = await read($, accountForm)
  const host = (form.host || defaultHost(form.provider)).toLowerCase()
  const who = (form.username.trim() || 'me').replace(/[^\w.-]+/g, '-')
  const path = `${cfg.home}/.ssh/${form.provider}-${who}-${host.replace(/[^\w.-]+/g, '-')}`
  const exists = await $.process.run(['test', '-e', path]).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))
  if (exists.exitCode === 0) {
    void $.ui.toast(`Đã có ${path}: chọn key đó trong danh sách`)
    await update($, accountForm, f => ({ ...f, sshKey: path }))
    return
  }
  await $.process.run(['mkdir', '-p', '-m', '700', `${cfg.home}/.ssh`]).catch(() => undefined)
  const r = await $.process.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', `${who}@${host} (repo-pane)`, '-f', path])
    .catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  if (r.exitCode !== 0) {
    void $.ui.toast(`Tạo key lỗi: ${lastLine(r.stderr)}`)
    return
  }
  await update($, accountForm, f => ({ ...f, sshKey: path }))
  await loadSshKeys($)
  await copyPublicKey($, path)
}

/** Copies a public key and opens the provider's page for adding it. */
async function copyPublicKey($: EngineInterface, keyPath: string) {
  const form = await read($, accountForm)
  const pub = await $.process.run(['cat', `${keyPath}.pub`]).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))
  if (pub.exitCode !== 0 || !pub.stdout.trim()) {
    void $.ui.toast(`Không đọc được ${keyPath}.pub`)
    return
  }
  await $.process.run(['pbcopy'], { stdin: pub.stdout.trim() }).catch(() => undefined)
  void $.ui.toast('Đã copy public key: dán vào trang vừa mở rồi lưu')
  await openUrl($, sshKeysPage(form.provider, (form.host || defaultHost(form.provider)).toLowerCase()))
}

/** `ssh -T git@<host>` with the key (or ~/.ssh/config): whether it gets in, and the name the host gives. */
async function testSsh($: EngineInterface, host: string, key: string): Promise<{ ok: boolean; username: string }> {
  await update($, ssh, s => ({ ...s, isTesting: true }))
  // accept-new records a host seen for the first time, so later git commands in BatchMode get through
  const r = await $.process.run([...sshArgv(key, true), '-T', `git@${host}`], { timeoutMs: 30_000 })
    .catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  const text = [r.stdout, r.stderr].join('\n').trim()
  const g = sshGreeting(text)
  await update($, ssh, s => ({ ...s, isTesting: false, test: { host, key, ok: g.ok, text: text.slice(0, 300) || `exit ${r.exitCode}` } }))
  return g
}

async function testFormSsh($: EngineInterface) {
  const form = await read($, accountForm)
  await testSsh($, (form.host || defaultHost(form.provider)).toLowerCase(), form.sshKey)
}

/** Adds an account that reaches git over SSH only: the key must get in first. */
async function sshLogin($: EngineInterface) {
  const form = await read($, accountForm)
  const host = (form.host || defaultHost(form.provider)).trim().toLowerCase()
  const t = await testSsh($, host, form.sshKey)
  if (!t.ok) {
    void $.ui.toast(`SSH key chưa vào được ${host}: thêm public key vào tài khoản rồi thử lại`)
    return
  }
  const username = t.username || form.username.trim() || 'ssh'
  const account: Account = {
    id: `${form.provider}:${host}:${username}:ssh`,
    provider: form.provider,
    host,
    method: 'ssh',
    protocol: 'ssh',
    sshKey: form.sshKey,
    username,
    gitUser: 'git',
    expiresAt: null,
    email: '',
    scopes: [],
    verifiedAt: Date.now(),
    error: null,
  }
  await saveAccounts($, [...(await read($, accounts)).filter(x => x.id !== account.id), account])
  void $.ui.toast(`Đã thêm ${username}@${host} (SSH)`)
  void fetchAll($)
}

/** Switches how git reaches an account's host: https with the saved token, or SSH with a key. */
async function setAccountProtocol($: EngineInterface, id: string, protocol: GitProtocol) {
  const form = await read($, accountForm)
  const list = (await read($, accounts)).map(a => (a.id === id ? { ...a, protocol, sshKey: protocol === 'ssh' ? a.sshKey || form.sshKey : a.sshKey } : a))
  await saveAccounts($, list)
  void $.ui.toast(`Git sẽ dùng ${protocol.toUpperCase()} cho tài khoản này`)
}

async function setAccountKey($: EngineInterface, id: string, key: string) {
  await saveAccounts($, (await read($, accounts)).map(a => (a.id === id ? { ...a, sshKey: key } : a)))
}

// ── remote repos ───────────────────────────────────────────────────────────

async function markOnDisk($: EngineInterface) {
  const r = await $.process.run(['ls', '-1', cfg.cloneDir]).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))
  const onDisk = r.exitCode === 0 ? r.stdout.split('\n').filter(Boolean).map(n => n.toLowerCase()) : []
  await update($, remote, cur => ({ ...cur, onDisk }))
}

/** The workspaces a Bitbucket account belongs to, or why they could not be read. */
async function bitbucketWorkspaces($: EngineInterface, a: Account, token: string): Promise<string[] | string> {
  const slugs: string[] = []
  let url: string | null = BITBUCKET_WORKSPACES_URL
  for (let page = 0; url && page < 10; page++) {
    try {
      const res = await $.http.fetch(url, { headers: authHeaders(a, token) })
      if (!res.ok) {
        const hint = res.status === 403 ? ' — token cần quyền read:workspace' : ''
        return `không đọc được danh sách workspace (${apiError(res.status, res.text)}${hint}); hoặc ghi workspace vào tài khoản`
      }
      const parsed = parseWorkspacePage(res.text)
      slugs.push(...parsed.slugs)
      url = parsed.next
    } catch (err) {
      return String(err)
    }
  }
  return [...new Set(slugs)]
}

async function listAccountRepos($: EngineInterface, a: Account): Promise<{ repos: RemoteRepo[]; error: string | null }> {
  const token = await tokenOf($, a)
  if (!token) return { repos: [], error: `${a.username}@${a.host}: không thấy token trong Keychain, đăng nhập lại` }
  const out: RemoteRepo[] = []
  let scopes = a.scopes
  if (a.provider === 'bitbucket' && scopes.length === 0) {
    const ws = await bitbucketWorkspaces($, a, token)
    if (typeof ws === 'string') return { repos: [], error: `${a.username}@${a.host}: ${ws}` }
    if (ws.length === 0) return { repos: [], error: `${a.username}@${a.host}: tài khoản không thuộc workspace nào` }
    scopes = ws
  }
  for (const first of repoListUrls(a, scopes)) {
    let url: string | null = first
    for (let page = 0; url && page < 30; page++) {
      try {
        const res = await $.http.fetch(url, { headers: authHeaders(a, token) })
        if (!res.ok) return { repos: out, error: `${a.username}@${a.host}: ${apiError(res.status, res.text)}` }
        const parsed = parseRepoPage(a, res.text, res.headers)
        out.push(...parsed.repos)
        url = parsed.next
      } catch (err) {
        return { repos: out, error: `${a.host}: ${String(err)}` }
      }
    }
  }
  return { repos: out, error: null }
}

/** Lists the repos every signed-in account can see, most recently updated first. */
async function loadRemote($: EngineInterface) {
  if ((await read($, remote)).isLoading) return
  // an SSH-only account reaches git, not the provider's API
  const list = (await read($, accounts)).filter(a => a.method !== 'ssh')
  if (list.length === 0) {
    await update($, remote, r => ({ ...r, errors: ['Cần một tài khoản OAuth hoặc token (tab Tài khoản) để xem repo trên remote'], at: Date.now() }))
    return
  }
  await update($, remote, r => ({ ...r, isLoading: true, errors: [] }))
  const results = await Promise.all(list.map(a => listAccountRepos($, a)))
  const seen = new Set<string>()
  const all = results.flatMap(r => r.repos).filter(r => (seen.has(r.key) ? false : (seen.add(r.key), true)))
  all.sort((a, b) => b.updatedOn.localeCompare(a.updatedOn))
  const errors = results.map(r => r.error).filter((e): e is string => Boolean(e))
  await update($, remote, r => ({ ...r, isLoading: false, at: Date.now(), errors, repos: all }))
  await markOnDisk($)
}

async function clone($: EngineInterface, repo: RemoteRepo) {
  const folder = cloneFolder(repo.slug)
  if (!folder) {
    void $.ui.toast(`Tên repo không dùng làm thư mục được: ${repo.slug}`)
    return
  }
  const target = `${cfg.cloneDir}/${folder}`
  const key = `clone:${repo.key}`
  await refreshExpiring($)
  const list = await read($, accounts)
  const account = accountForHost(list, repo.host)
  const overSsh = !account || account.protocol === 'ssh'
  const url = overSsh ? repo.sshUrl : httpsWithUser(repo.httpsUrl, account.gitUser)
  const env = { ...GIT_ENV, ...(account?.sshKey ? { GIT_SSH_COMMAND: sshCommand(account.sshKey) } : {}) }
  await setBusy($, key, 'clone')
  try {
    let r = await $.process.run(['git', 'clone', '--', url, target], { cwd: cfg.cloneDir, env, timeoutMs: 600_000 })
      .catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
    if (r.exitCode !== 0 && !overSsh && cfg.useSsh && isAuthError(r.stderr)) {
      r = await $.process.run(['git', 'clone', '--', repo.sshUrl, target], { cwd: cfg.cloneDir, env, timeoutMs: 600_000 })
        .catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
    }
    await report($, `Clone ${repo.fullName}`, r, `Đã clone ${repo.fullName} vào ${target}`)
    if (r.exitCode === 0) await watch($, target)
  } finally {
    await setBusy($, key, null)
  }
}

// ── pull requests ──────────────────────────────────────────────────────────

/** The account and API path for the open repo's origin, or why there is none. */
async function prTarget($: EngineInterface): Promise<{ account: Account; path: string } | string> {
  const sel = await read($, selected)
  if (!sel) return 'Chưa chọn repo'
  return prTargetFor($, sel.repo)
}

/** The signed-in account and API path for a repo's origin, or why there is none. */
async function prTargetFor($: EngineInterface, repoPath: string): Promise<{ account: Account; path: string } | string> {
  const s = (await read($, settings))[repoPath] ?? (await readSettings($, repoPath))
  const origin = s?.remotes.find(r => r.name === 'origin') ?? s?.remotes[0]
  const parsed = origin ? parseRemoteUrl(origin.fetchUrl) : null
  if (!parsed) return 'Repo không có remote nhận diện được'
  const list = await read($, accounts)
  const provider = providerForHost(parsed.host, list)
  const account = list.find(a => a.host === parsed.host && a.method !== 'ssh')
  if (!provider || !account) return `Chưa đăng nhập tài khoản cho ${parsed.host} (tab Tài khoản)`
  return { account, path: parsed.path }
}

async function loadPrs($: EngineInterface) {
  const target = await prTarget($)
  if (typeof target === 'string') {
    await update($, panel, p => (p ? { ...p, prs: [], prError: target } : p))
    return
  }
  const token = await tokenOf($, target.account)
  if (!token) {
    await update($, panel, p => (p ? { ...p, prs: [], prError: 'Không thấy token trong Keychain, đăng nhập lại' } : p))
    return
  }
  try {
    const res = await $.http.fetch(prListUrl(target.account, target.path), { headers: authHeaders(target.account, token) })
    const prs = res.ok ? parsePrs(target.account.provider, res.text) : []
    await update($, panel, p => (p ? { ...p, prs, prError: res.ok ? null : apiError(res.status, res.text) } : p))
  } catch (err) {
    await update($, panel, p => (p ? { ...p, prs: [], prError: String(err) } : p))
  }
}

async function createPr($: EngineInterface, cwd: string, source: string) {
  const d = await read($, drafts)
  const title = (d[`prtitle:${cwd}`] ?? '').trim()
  const target = (d[`prtarget:${cwd}`] ?? '').trim()
  const description = (d[`prdesc:${cwd}`] ?? '').trim()
  if (!title || !target) {
    void $.ui.toast('Nhập tiêu đề và branch đích')
    return
  }
  const t = await prTarget($)
  if (typeof t === 'string') {
    void $.ui.toast(t)
    return
  }
  const token = await tokenOf($, t.account)
  if (!token) {
    void $.ui.toast('Không thấy token trong Keychain, đăng nhập lại')
    return
  }
  const req = prCreateRequest(t.account, t.path, { title, source, target, description })
  await setBusy($, cwd, 'Tạo pull request')
  try {
    const res = await $.http.fetch(req.url, {
      method: 'POST',
      headers: { ...authHeaders(t.account, token), 'Content-Type': 'application/json' },
      body: req.body,
    })
    if (!res.ok) {
      await update($, result, () => ({ label: 'Tạo pull request', ok: false, text: apiError(res.status, res.text), at: Date.now() }))
      void $.ui.toast(`Tạo PR lỗi: ${apiError(res.status, res.text)}`)
      return
    }
    const pr = parseCreatedPr(t.account.provider, res.text)
    await update($, result, () => ({ label: 'Tạo pull request', ok: true, text: `#${pr.id} ${pr.title}\n${pr.url}`, at: Date.now() }))
    void $.ui.toast(`Đã tạo PR #${pr.id}`)
    await setDraft($, `prtitle:${cwd}`, '')
    await setDraft($, `prdesc:${cwd}`, '')
    await loadPrs($)
  } catch (err) {
    void $.ui.toast(`Tạo PR lỗi: ${String(err)}`)
  } finally {
    await setBusy($, cwd, null)
  }
}

// ── register ───────────────────────────────────────────────────────────────

// ── git-flow ───────────────────────────────────────────────────────────────

/** Runs git commands in order, stopping at the first one that fails, and reports what ran and what is left. */
async function runSteps($: EngineInterface, cwd: string, label: string, steps: readonly FlowStep[]) {
  const b = await read($, busy)
  if (b[cwd]) {
    void $.ui.toast(`Đang chạy "${b[cwd]}", chờ xong đã`)
    return false
  }
  await setBusy($, cwd, label)
  const done: string[] = []
  try {
    for (const [i, s] of steps.entries()) {
      const r = s.isNetwork ? await gitNet($, cwd, s.args) : await git($, cwd, s.args, 120_000)
      if (r.exitCode === 0) {
        done.push(`✓ ${s.label}`)
        continue
      }
      if (s.optional) {
        done.push(`○ ${s.label} — bỏ qua: ${lastLine(r.stderr)}`)
        continue
      }
      const left = steps.slice(i + 1).map(x => `· ${x.label}`)
      const text = [...done, `✗ ${s.label}: ${explainNetworkError(output(r))}`, ...(left.length ? ['Chưa chạy:', ...left] : [])].join('\n')
      await update($, result, () => ({ label, ok: false, text, at: Date.now() }))
      void $.ui.toast(`${label}: dừng ở "${s.label}"`)
      return false
    }
    await update($, result, () => ({ label, ok: true, text: done.join('\n'), at: Date.now() }))
    void $.ui.toast(`${label}: xong`)
    return true
  } finally {
    await setBusy($, cwd, null)
    await refreshFor($, cwd)
  }
}

async function flowInit($: EngineInterface, cwd: string) {
  const d = await read($, drafts)
  const p = await read($, panel)
  const names = new Set(p?.branches.map(b => b.name) ?? [])
  const guess = names.has('main') && !names.has('master') ? 'main' : 'master'
  const base = flowDefaults((d['flow:master'] ?? '').trim() || guess)
  const c: FlowConfig = {
    master: base.master,
    develop: (d['flow:develop'] ?? '').trim() || base.develop,
    feature: (d['flow:feature'] ?? '').trim() || base.feature,
    bugfix: (d['flow:bugfix'] ?? '').trim() || base.bugfix,
    release: (d['flow:release'] ?? '').trim() || base.release,
    hotfix: (d['flow:hotfix'] ?? '').trim() || base.hotfix,
    support: (d['flow:support'] ?? '').trim() || base.support,
    versiontag: (d['flow:versiontag'] ?? '').trim(),
  }
  for (const name of [c.master, c.develop]) if (!(await validBranchName($, cwd, name))) return
  const steps: FlowStep[] = flowConfigArgs(c).map(args => ({ label: `${args[2]} = ${args[3] || '(trống)'}`, args }))
  if (!names.has(c.develop)) {
    const remoteDevelop = p?.remoteBranches.some(b => b.name === `origin/${c.develop}`)
    steps.push(remoteDevelop
      ? { label: `Tạo ${c.develop} theo origin/${c.develop}`, args: ['branch', '--track', c.develop, `origin/${c.develop}`] }
      : { label: `Tạo ${c.develop} từ ${c.master}`, args: ['branch', c.develop, c.master] })
  }
  await runSteps($, cwd, 'Bật git-flow', steps)
}

async function flowStart($: EngineInterface, cwd: string, kind: FlowKind) {
  const p = await read($, panel)
  const c = p?.flow
  if (!c) return
  const d = await read($, drafts)
  const name = (d[`flowname:${kind}`] ?? '').trim()
  const branch = `${c[kind]}${name}`
  if (!name || !(await validBranchName($, cwd, branch))) return
  const base = flowBase(kind, c)
  const ok = await act($, cwd, `Bắt đầu ${kind} ${name}`, ['switch', '-c', branch, base], { okText: `Đã tạo ${branch} từ ${base}` })
  if (ok) await setDraft($, `flowname:${kind}`, '')
}

async function flowStepsFor($: EngineInterface, branch: string): Promise<{ steps: FlowStep[]; kind: FlowKind; name: string } | null> {
  const p = await read($, panel)
  const c = p?.flow
  const k = c ? flowKindOf(branch, c) : null
  if (!c || !k) return null
  const f = await read($, flags)
  const d = await read($, drafts)
  const steps = finishSteps(k.kind, branch, k.name, c, { keep: Boolean(f.flowKeep), push: Boolean(f.flowPush), tagMessage: (d.flowtag ?? '').trim() })
  return { steps, kind: k.kind, name: k.name }
}

async function askFlowFinish($: EngineInterface, cwd: string, branch: string) {
  const plan = await flowStepsFor($, branch)
  if (!plan) return
  if (plan.steps.length === 0) {
    void $.ui.toast(`git-flow không có bước finish cho ${plan.kind}`)
    return
  }
  const st = (await read($, repos)).flatMap(r => r.worktrees).find(w => w.path === cwd)
  if (st && !isClean(st)) {
    void $.ui.toast('Worktree còn thay đổi chưa commit: commit hoặc stash trước')
    return
  }
  await ask($, ['flow-finish', cwd, branch].join(SEP), `Hoàn tất ${plan.kind} ${plan.name}?`, plan.steps.map(s => `· ${s.label}`).join('\n'))
}

async function flowFinish($: EngineInterface, cwd: string, branch: string) {
  const plan = await flowStepsFor($, branch)
  if (plan) await runSteps($, cwd, `Hoàn tất ${plan.kind} ${plan.name}`, plan.steps)
}

// ── finding repos ──────────────────────────────────────────────────────────

/** Looks for git repos under a folder (three levels down, skipping dependency and system folders). */
async function scanRepos($: EngineInterface, rootIn?: string) {
  const d = await read($, drafts)
  const root = (rootIn ?? d.scanroot ?? '').trim().replace(/\/+$/, '') || cfg.home
  if (!root.startsWith('/')) {
    void $.ui.toast('Nhập đường dẫn tuyệt đối')
    return
  }
  await update($, scan, s => ({ ...s, isLoading: true, root }))
  const r = await $.process.run(
    ['find', root, '-maxdepth', '3', '(', '-name', 'node_modules', '-o', '-name', 'Library', '-o', '-name', '.Trash', '-o', '-name', 'Pods', ')', '-prune', '-o', '-name', '.git', '-print'],
    { timeoutMs: 90_000 },
  ).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  const dirs = r.stdout.split('\n').filter(Boolean).map(p => p.replace(/\/\.git$/, '')).sort()
  // a worktree or submodule inside a repo is reached through that repo
  const found = dirs.filter(p => !dirs.some(q => q !== p && p.startsWith(`${q}/`)))
  await update($, scan, () => ({ isLoading: false, root, found }))
  if (found.length === 0) void $.ui.toast(`Không thấy repo nào trong ${root}`)
}

async function addRepo($: EngineInterface, pathIn?: string) {
  const d = await read($, drafts)
  const path = (pathIn ?? d.addrepo ?? '').trim().replace(/\/+$/, '')
  if (!path.startsWith('/')) {
    void $.ui.toast('Nhập đường dẫn tuyệt đối tới repo')
    return
  }
  const top = await git($, path, ['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) {
    void $.ui.toast(`${path} không phải git repo`)
    return
  }
  await setDraft($, 'addrepo', '')
  await watch($, top.stdout.trim())
}

async function watchAll($: EngineInterface, paths: readonly string[]) {
  const fresh = paths.filter(p => !allPaths().includes(p))
  if (fresh.length) {
    extraRepos = [...extraRepos, ...fresh]
    await saveExtra($)
  }
  await refresh($)
}

// ── publish: create the repo on the provider, add origin, push ─────────────

/** Accounts that can create repos: every OAuth or token one (an SSH-only account has no API). */
async function apiAccounts($: EngineInterface): Promise<Account[]> {
  return (await read($, accounts)).filter(a => a.method !== 'ssh')
}

/** The account itself, then its orgs / workspaces / groups. */
async function loadOwners($: EngineInterface, accountId: string): Promise<string[]> {
  const a = (await read($, accounts)).find(x => x.id === accountId)
  if (!a) return []
  const token = await tokenOf($, a)
  const own = a.provider === 'bitbucket' ? [] : [a.username]
  let found: string[] = []
  if (token) {
    try {
      const res = await $.http.fetch(ownersUrl(a), { headers: authHeaders(a, token) })
      if (res.ok) found = parseOwners(a.provider, res.text)
    } catch {
      // the account's own space still works
    }
  }
  const list = [...new Set([...own, ...a.scopes, ...found])]
  await update($, owners, o => ({ ...o, [accountId]: list }))
  return list
}

type PublishInput = { accountId?: string; provider?: string; owner?: string; name?: string; description?: string; isPrivate?: boolean; remote?: string }
type PublishOutcome = { ok: boolean; text: string; webUrl: string }

/**
 * Creates the repo on the provider with a signed-in account, adds it as a remote of the local repo
 * (https with the account's git user, or SSH when the account is set to SSH) and pushes the current branch.
 */
async function publishRepo($: EngineInterface, repoPath: string, input: PublishInput): Promise<PublishOutcome> {
  const fail = (text: string): PublishOutcome => ({ ok: false, text, webUrl: '' })
  const top = await git($, repoPath, ['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) return fail(`${repoPath} không phải git repo`)
  const cwd = top.stdout.trim()
  const remoteName = (input.remote ?? 'origin').trim() || 'origin'
  if (!/^[\w.-]+$/.test(remoteName)) return fail(`Tên remote không hợp lệ: ${remoteName}`)
  const existing = await git($, cwd, ['remote', 'get-url', remoteName])
  if (existing.exitCode === 0) return fail(`Repo đã có remote "${remoteName}" (${existing.stdout.trim()}): đổi tên remote hoặc dùng Push`)
  const head = await git($, cwd, ['rev-parse', '--verify', '-q', 'HEAD'])
  if (head.exitCode !== 0) return fail('Repo chưa có commit nào để push')

  const list = await apiAccounts($)
  const account = input.accountId
    ? list.find(a => a.id === input.accountId)
    : list.find(a => !input.provider || a.provider === input.provider)
  if (!account) return fail(input.provider ? `Chưa đăng nhập tài khoản ${input.provider} (OAuth hoặc token)` : 'Chưa có tài khoản OAuth hoặc token nào')
  const token = await tokenOf($, account)
  if (!token) return fail(`${account.username}@${account.host}: không thấy token trong Keychain, đăng nhập lại`)

  const name = repoSlug(input.name || cwd.split('/').pop() || '')
  if (!name) return fail('Tên repo không hợp lệ')
  const owner = (input.owner ?? '').trim() || (account.provider === 'bitbucket' ? account.scopes[0] ?? '' : account.username)
  if (!owner) return fail('Bitbucket cần workspace để tạo repo (chọn owner)')
  const isPrivate = input.isPrivate !== false

  let groupId: number | undefined
  if (account.provider === 'gitlab' && owner.toLowerCase() !== account.username.toLowerCase()) {
    try {
      const g = await $.http.fetch(`https://${account.host}/api/v4/groups/${encodeURIComponent(owner)}`, { headers: authHeaders(account, token) })
      if (!g.ok) return fail(`Không thấy group ${owner}: ${apiError(g.status, g.text)}`)
      groupId = (JSON.parse(g.text) as { id?: number }).id
    } catch (err) {
      return fail(String(err))
    }
  }

  const req = createRepoRequest(account, owner, { name, description: input.description ?? '', isPrivate }, groupId)
  let created: { webUrl: string; httpsUrl: string; sshUrl: string }
  try {
    const res = await $.http.fetch(req.url, {
      method: 'POST',
      headers: { ...authHeaders(account, token), 'Content-Type': 'application/json' },
      body: req.body,
    })
    if (!res.ok) {
      const hint = res.status === 403 ? ' — token chưa có quyền tạo repo' : res.status === 422 || res.status === 400 ? ' — có thể tên đã tồn tại' : ''
      return fail(`Tạo repo lỗi: ${apiError(res.status, res.text)}${hint}`)
    }
    created = parseCreatedRepo(account.provider, res.text)
  } catch (err) {
    return fail(`Tạo repo lỗi: ${String(err)}`)
  }

  const url = account.protocol === 'ssh' ? created.sshUrl : httpsWithUser(created.httpsUrl, account.gitUser)
  const steps: string[] = [`✓ Tạo ${isPrivate ? 'private' : 'public'} repo ${owner}/${name} trên ${providerLabel(account.provider)}: ${created.webUrl}`]
  const add = await git($, cwd, ['remote', 'add', remoteName, url])
  if (add.exitCode !== 0) return { ok: false, text: [...steps, `✗ Thêm remote: ${lastLine(add.stderr)}`].join('\n'), webUrl: created.webUrl }
  steps.push(`✓ Thêm remote ${remoteName} → ${url}`)
  const pushed = await gitNet($, cwd, ['push', '-u', remoteName, 'HEAD'])
  if (pushed.exitCode !== 0) {
    steps.push(`✗ Push: ${explainNetworkError(lastLine(pushed.stderr))}`)
    return { ok: false, text: steps.join('\n'), webUrl: created.webUrl }
  }
  steps.push(`✓ Push ${(await git($, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()} lên ${remoteName}`)
  if (!allPaths().includes(cwd)) {
    extraRepos = [...extraRepos, cwd]
    await saveExtra($)
  }
  await refreshFor($, cwd)
  return { ok: true, text: steps.join('\n'), webUrl: created.webUrl }
}

async function askPublish($: EngineInterface, repoPath: string) {
  const d = await read($, drafts)
  const f = await read($, flags)
  const list = await apiAccounts($)
  const account = list.find(a => a.id === d[`pub:account:${repoPath}`]) ?? list[0]
  if (!account) {
    void $.ui.toast('Đăng nhập một tài khoản OAuth hoặc token trước (tab Tài khoản)')
    return
  }
  const name = repoSlug(d[`pub:name:${repoPath}`] || repoPath.split('/').pop() || '')
  const owner = d[`pub:owner:${repoPath}`] || (account.provider === 'bitbucket' ? account.scopes[0] ?? '' : account.username)
  const visibility = f[`pub:public:${repoPath}`] ? 'PUBLIC (ai cũng xem được)' : 'private'
  await ask($, ['publish', repoPath].join(SEP), `Tạo ${owner}/${name} trên ${providerLabel(account.provider)} rồi push?`,
    `Chế độ: ${visibility}\nTài khoản: ${account.username}@${account.host}\nRemote: origin`)
}

async function publishFromDrafts($: EngineInterface, repoPath: string) {
  const d = await read($, drafts)
  const f = await read($, flags)
  const list = await apiAccounts($)
  const account = list.find(a => a.id === d[`pub:account:${repoPath}`]) ?? list[0]
  await setBusy($, repoPath, 'Publish')
  try {
    const out = await publishRepo($, repoPath, {
      accountId: account?.id,
      owner: d[`pub:owner:${repoPath}`],
      name: d[`pub:name:${repoPath}`],
      description: d[`pub:desc:${repoPath}`],
      isPrivate: !f[`pub:public:${repoPath}`],
    })
    await update($, result, () => ({ label: 'Publish lên remote', ok: out.ok, text: out.text, at: Date.now() }))
    void $.ui.toast(out.ok ? `Đã publish: ${out.webUrl}` : `Publish lỗi: ${lastLine(out.text)}`)
  } finally {
    await setBusy($, repoPath, null)
  }
}

async function choosePublishAccount($: EngineInterface, repoPath: string, accountId: string) {
  await setDraft($, `pub:account:${repoPath}`, accountId)
  await setDraft($, `pub:owner:${repoPath}`, '')
  await loadOwners($, accountId)
}

// ── tools Claude can call ──────────────────────────────────────────────────

const TOOL_PREFIX = 'mcp__repo-pane__'

type ToolAnswer = { result: unknown; text: string } | { isError: true; result: unknown; text: string }

function toolOk(text: string, result: unknown = { ok: true }): ToolAnswer {
  return { result, text }
}

function toolError(text: string): ToolAnswer {
  return { isError: true, result: { ok: false, error: text }, text }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** The top of the git repo a tool was pointed at, or why it is not one. */
async function toolRepo($: EngineInterface, path: unknown): Promise<string | ToolAnswer> {
  const p = str(path)
  if (!p.startsWith('/')) return toolError('`path` must be an absolute path to a git repository or worktree')
  const top = await git($, p, ['rev-parse', '--show-toplevel'])
  return top.exitCode === 0 ? top.stdout.trim() : toolError(`${p} is not a git repository`)
}

function describeWorktree(w: WorktreeStatus): string {
  const sync = w.isDetached ? 'detached' : !w.upstream ? 'no upstream' : `↑${w.ahead} ↓${w.behind} vs ${w.upstream}`
  const changes = isClean(w) ? 'clean' : `${w.staged} staged, ${w.modified} modified, ${w.untracked} untracked, ${w.conflicted} conflicted`
  return `${w.path} [${w.branch}] ${sync}; ${changes}`
}

async function toolStatus($: EngineInterface, input: Record<string, unknown>): Promise<ToolAnswer> {
  if (str(input.path)) {
    const top = await toolRepo($, input.path)
    if (typeof top !== 'string') return top
    const r = await readRepo($, top, null)
    const s = await readSettings($, top)
    const remotes = s.remotes.map(x => `${x.name} ${x.fetchUrl}`).join('; ') || 'none'
    const files = r.worktrees.flatMap(w => w.files.slice(0, 50).map(f => `  ${f.code} ${f.path}`))
    return toolOk([`Repo ${top}`, `Remotes: ${remotes}`, ...r.worktrees.map(describeWorktree), ...files].join('\n'), r)
  }
  await refresh($)
  const list = await read($, repos)
  if (list.length === 0) return toolOk('No repositories are watched yet.', [])
  return toolOk(list.map(r => [`${r.name} (${r.path})${r.fetchError ? ` — fetch error: ${r.fetchError}` : ''}`, ...r.worktrees.map(w => `  ${describeWorktree(w)}`)].join('\n')).join('\n'), list)
}

async function toolAccounts($: EngineInterface): Promise<ToolAnswer> {
  const list = await read($, accounts)
  if (list.length === 0) return toolOk('No accounts are signed in. The person can sign in from Repo Pane, tab "Tài khoản".', [])
  const safe = list.map(a => ({ provider: a.provider, host: a.host, username: a.username, method: a.method, protocol: a.protocol, scopes: a.scopes, error: a.error }))
  return toolOk(safe.map(a => `${a.provider} ${a.username}@${a.host} (${a.method}, git over ${a.protocol})${a.error ? ` — ${a.error}` : ''}`).join('\n'), safe)
}

async function toolPublish($: EngineInterface, input: Record<string, unknown>): Promise<ToolAnswer> {
  const top = await toolRepo($, input.path)
  if (typeof top !== 'string') return top
  const out = await publishRepo($, top, {
    provider: str(input.provider) || undefined,
    owner: str(input.owner) || undefined,
    name: str(input.name) || undefined,
    description: str(input.description),
    isPrivate: input.private !== false,
    remote: str(input.remote) || undefined,
  })
  return out.ok ? toolOk(out.text, { ok: true, url: out.webUrl }) : toolError(out.text)
}

async function toolGit($: EngineInterface, cwd: string, label: string, args: string[]): Promise<ToolAnswer> {
  const r = await gitNet($, cwd, args)
  await refreshFor($, cwd)
  const text = output(r)
  return r.exitCode === 0 ? toolOk(`${label}: done${text ? `\n${text}` : ''}`) : toolError(`${label} failed: ${explainNetworkError(text || `exit ${r.exitCode}`)}`)
}

async function toolPush($: EngineInterface, input: Record<string, unknown>): Promise<ToolAnswer> {
  const top = await toolRepo($, input.path)
  if (typeof top !== 'string') return top
  const upstream = await git($, top, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  const args = upstream.exitCode === 0 ? ['push'] : ['push', '-u', 'origin', 'HEAD']
  if (input.force_with_lease === true) args.push('--force-with-lease')
  return toolGit($, top, 'Push', args)
}

async function toolPull($: EngineInterface, input: Record<string, unknown>): Promise<ToolAnswer> {
  const top = await toolRepo($, input.path)
  if (typeof top !== 'string') return top
  const mode = str(input.mode)
  const flag = mode === 'rebase' ? '--rebase' : mode === 'merge' ? '--no-rebase' : '--ff-only'
  return toolGit($, top, `Pull (${flag})`, ['pull', flag])
}

async function toolFetch($: EngineInterface, input: Record<string, unknown>): Promise<ToolAnswer> {
  if (!str(input.path)) {
    await fetchAll($)
    const failed = (await read($, repos)).filter(r => r.fetchError)
    return toolOk(failed.length ? `Fetched every watched repo; errors:\n${failed.map(r => `${r.name}: ${r.fetchError}`).join('\n')}` : 'Fetched every watched repo.')
  }
  const top = await toolRepo($, input.path)
  if (typeof top !== 'string') return top
  return toolGit($, top, 'Fetch', ['fetch', '--all', '--prune'])
}

async function toolCreatePr($: EngineInterface, input: Record<string, unknown>): Promise<ToolAnswer> {
  const top = await toolRepo($, input.path)
  if (typeof top !== 'string') return top
  const title = str(input.title)
  const target = str(input.target)
  if (!title || !target) return toolError('`title` and `target` (the branch to merge into) are required')
  const source = str(input.source) || (await git($, top, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  const t = await prTargetFor($, top)
  if (typeof t === 'string') return toolError(t)
  const token = await tokenOf($, t.account)
  if (!token) return toolError('No token in the Keychain for this account: sign in again from Repo Pane')
  const req = prCreateRequest(t.account, t.path, { title, source, target, description: str(input.description) })
  try {
    const res = await $.http.fetch(req.url, { method: 'POST', headers: { ...authHeaders(t.account, token), 'Content-Type': 'application/json' }, body: req.body })
    if (!res.ok) return toolError(`Creating the pull request failed: ${apiError(res.status, res.text)}`)
    const pr = parseCreatedPr(t.account.provider, res.text)
    return toolOk(`Created pull request #${pr.id} ${pr.title} (${pr.source} → ${pr.target}): ${pr.url}`, pr)
  } catch (err) {
    return toolError(String(err))
  }
}

const PATH_PROP = { type: 'string', description: 'Absolute path to the local git repository (or one of its worktrees)' }

const TOOLS: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
  {
    name: 'status',
    description: 'Git status from Repo Pane: with `path`, one repo (branch, ahead/behind, changed files, remotes); without it, every repo the person watches in Repo Pane.',
    inputSchema: { type: 'object', properties: { path: PATH_PROP } },
  },
  {
    name: 'accounts',
    description: 'The Bitbucket / GitHub / GitLab accounts signed in to the repo-pane plugin (provider, host, username, sign-in method, git protocol). No secrets.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'publish',
    description: 'Create a new repository on GitHub, Bitbucket or GitLab with a signed-in account, add it as the local repo\'s remote (origin by default) and push the current branch. Creates something visible to others: call it only when the person asked to publish or create the remote repo, and confirm the visibility with them first (private unless they said public).',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROP,
        provider: { type: 'string', enum: ['github', 'bitbucket', 'gitlab'], description: 'Which provider; default: the first signed-in account' },
        owner: { type: 'string', description: 'GitHub user or org, Bitbucket workspace, or GitLab user or group path; default: the account itself (Bitbucket: its first workspace)' },
        name: { type: 'string', description: 'Repository name; default: the local folder name' },
        description: { type: 'string' },
        private: { type: 'boolean', description: 'Default true' },
        remote: { type: 'string', description: 'Remote name to add; default origin' },
      },
      required: ['path'],
    },
  },
  {
    name: 'push',
    description: 'Push the current branch of a local repo with the signed-in account (sets the upstream to origin when there is none). `force_with_lease` only when the person asked to force push.',
    inputSchema: { type: 'object', properties: { path: PATH_PROP, force_with_lease: { type: 'boolean' } }, required: ['path'] },
  },
  {
    name: 'pull',
    description: 'Pull the current branch of a local repo: fast-forward only by default; `mode` "rebase" or "merge" when the person asked for it.',
    inputSchema: { type: 'object', properties: { path: PATH_PROP, mode: { type: 'string', enum: ['ff-only', 'rebase', 'merge'] } }, required: ['path'] },
  },
  {
    name: 'fetch',
    description: 'Fetch one repo (`path`), or every repo watched in Repo Pane when `path` is left out.',
    inputSchema: { type: 'object', properties: { path: PATH_PROP } },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request (merge request on GitLab) for a local repo\'s origin, from `source` (default: the current branch, which must be pushed) into `target`.',
    inputSchema: {
      type: 'object',
      properties: { path: PATH_PROP, title: { type: 'string' }, target: { type: 'string' }, source: { type: 'string' }, description: { type: 'string' } },
      required: ['path', 'title', 'target'],
    },
  },
]

async function runTool($: EngineInterface, name: string, input: Record<string, unknown>): Promise<ToolAnswer> {
  switch (name) {
    case 'status': return toolStatus($, input)
    case 'accounts': return toolAccounts($)
    case 'publish': return toolPublish($, input)
    case 'push': return toolPush($, input)
    case 'pull': return toolPull($, input)
    case 'fetch': return toolFetch($, input)
    case 'create_pull_request': return toolCreatePr($, input)
    default: return toolError(`Unknown tool ${name}`)
  }
}

const TABS: { tab: RepoTab; label: string }[] = [
  { tab: 'changes', label: 'Thay đổi' },
  { tab: 'branches', label: 'Branch' },
  { tab: 'history', label: 'Lịch sử' },
  { tab: 'flow', label: 'Git-flow' },
  { tab: 'stash', label: 'Stash' },
  { tab: 'tags', label: 'Tag' },
  { tab: 'prs', label: 'Pull request' },
  { tab: 'advanced', label: 'Nâng cao' },
  { tab: 'settings', label: 'Cài đặt' },
]

const BRANCH_PREFIXES = ['', 'feature/', 'bugfix/', 'hotfix/', 'release/', 'chore/']

/** OAuth apps an admin set in the plugin's settings, shared by everyone who installs it. */
function sharedApps(options: Record<string, unknown>): SharedApp[] {
  const apps: SharedApp[] = []
  const str = (k: string) => String(options[k] ?? '').trim()
  if (str('bitbucketOAuthKey')) {
    apps.push({ provider: 'bitbucket', host: 'bitbucket.org', clientId: str('bitbucketOAuthKey'), secret: str('bitbucketOAuthSecret') })
  }
  if (str('githubOAuthClientId')) {
    apps.push({ provider: 'github', host: (str('githubHost') || 'github.com').toLowerCase(), clientId: str('githubOAuthClientId'), secret: '' })
  }
  if (str('gitlabOAuthClientId')) {
    apps.push({ provider: 'gitlab', host: (str('gitlabHost') || 'gitlab.com').toLowerCase(), clientId: str('gitlabOAuthClientId'), secret: '' })
  }
  return apps
}

export const register: Register = (on, options) => {
  cfg = {
    repos: splitList(options.repos),
    cloneDir: String(options.cloneDir ?? '').replace(/\/+$/, ''),
    useSsh: options.useSsh !== false,
    home: '',
    apps: sharedApps(options),
  }
  const fetchMinutes = Number(options.fetchMinutes ?? 5)
  const refreshSeconds = Math.max(5, Number(options.refreshSeconds ?? 30))

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'repo-pane', description: 'Mở Repo Pane (trạng thái repo, branch, commit, PR…)' })
    for (const t of TOOLS) await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema })
    const home = await $.process.run(['printenv', 'HOME']).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))
    cfg.home = home.stdout.trim().replace(/\/+$/, '')
    if (!cfg.cloneDir) cfg.cloneDir = cfg.home
    const stored = await $.store.get('extraRepos')
    extraRepos = Array.isArray(stored) ? stored.filter((p): p is string => typeof p === 'string') : []
    await loadAccounts($)
    await loadOAuthApps($)
    // first run: nothing watched yet, so offer the repos found in the home folder
    if (allPaths().length === 0 && cfg.home) void scanRepos($, cfg.home)
    void $.ui.open({ id: PANE, title: TITLE })

    void refresh($)
    $.clock.every(refreshSeconds * 1000, () => void refresh($))
    if (fetchMinutes > 0) {
      $.clock.after(3_000, () => void fetchAll($))
      $.clock.every(fetchMinutes * 60_000, () => void fetchAll($))
    }

    return next(e)
  })

  // Tools Claude can call (registered at session.start): status, accounts, publish, push, pull, fetch, create_pull_request
  on('tool.call', async ($, e, next) => {
    if (!e.tool.startsWith(TOOL_PREFIX)) return next(e)
    const { tool, tool_use_id: _id, ...input } = e as unknown as Record<string, unknown> & { tool: string; tool_use_id: string }
    return runTool($, tool.slice(TOOL_PREFIX.length), input)
  })

  on('command.run', { command: 'repo-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    void refresh($)

    return { text: 'Đã mở Repo Pane.' }
  })

  // One line above the prompt: what needs attention, and a button that opens the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, repos)
    const info = await read($, fetchInfo)
    const all = list.flatMap(r => r.worktrees)
    const behind = all.filter(w => w.upstream && w.behind > 0).length
    const dirty = all.filter(w => !isClean(w)).length
    const conflicts = all.filter(w => w.conflicted > 0).length
    const fetchFailed = list.filter(r => r.fetchError).length

    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text bold>Repo Pane</Text>
        <Text dimColor>{list.length} repo</Text>
        {behind > 0 && <Text color="warning">↓ {behind} cần pull</Text>}
        {dirty > 0 && <Text color="warning">◐ {dirty} có thay đổi</Text>}
        {conflicts > 0 && <Text color="error">! {conflicts} conflict</Text>}
        {fetchFailed > 0 && <Text color="error">fetch lỗi {fetchFailed}</Text>}
        {behind + dirty + conflicts + fetchFailed === 0 && list.length > 0 && <Text color="success">● sạch</Text>}
        <Text dimColor>· {info.isRunning ? 'đang fetch…' : `fetch ${ago(info.at, Date.now())}`}</Text>
        <Button key="open-pane-detail" onPress={() => void $.ui.open({ id: PANE, title: TITLE, focus: true })}>Chi tiết</Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Code, Link } = ui
    // Chosen by surface, not by what the table object holds: the mobile app draws no field (forms are left
    // out there), and the terminal draws no SVG (the history graph falls back to text).
    const Input = e.surface !== 'mobile' && 'Input' in ui ? ui.Input : null
    const Select = e.surface !== 'mobile' && 'Select' in ui ? ui.Select : null

    const list = await read($, repos)
    const info = await read($, fetchInfo)
    const current = await read($, view)
    const sel = await read($, selected)
    const p = await read($, panel)
    const settingsOf = await read($, settings)
    const busyOf = await read($, busy)
    const d = await read($, drafts)
    const f = await read($, flags)
    const ask0 = await read($, confirm)
    const res = await read($, result)
    const df = await read($, diff)
    const remoteList = await read($, remote)
    const accts = await read($, accounts)
    const form = await read($, accountForm)
    const apps = await read($, oauthApps)
    const progress = await read($, oauth)
    const scanned = await read($, scan)
    const sshState = await read($, ssh)
    const ownerLists = await read($, owners)
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const now = Date.now()

    const draftInput = (key: string, label: string, placeholder = '', onSubmit?: (v: string) => void) =>
      Input && (
        <Input
          key={`in:${key}`}
          label={label}
          placeholder={placeholder}
          value={d[key] ?? ''}
          onInput={v => void setDraft($, key, v)}
          onSubmit={v => {
            void setDraft($, key, v)
            onSubmit?.(v)
          }}
        />
      )

    const flagButton = (key: string, label: string) => (
      <Button key={`flag:${key}`} label={`${f[key] ? '☑' : '☐'} ${label}`} plain onPress={() => void toggleFlag($, key)} />
    )

    const sync = (w: WorktreeStatus) => {
      if (w.isDetached) return ''
      if (!w.upstream) return 'chưa có upstream'
      const parts: string[] = []
      if (w.ahead) parts.push(`↑${w.ahead}`)
      if (w.behind) parts.push(`↓${w.behind}`)
      return parts.length ? parts.join(' ') : '='
    }

    const counts = (w: WorktreeStatus) => {
      const parts: string[] = []
      if (w.conflicted) parts.push(`!${w.conflicted}`)
      if (w.staged) parts.push(`+${w.staged}`)
      if (w.modified) parts.push(`~${w.modified}`)
      if (w.untracked) parts.push(`?${w.untracked}`)
      return parts.join(' ')
    }

    const dot = (w: WorktreeStatus) => (
      <Text color={w.error || w.conflicted ? 'error' : isClean(w) ? 'success' : 'warning'}>
        {w.error ? '✗' : isClean(w) ? '●' : '◐'}
      </Text>
    )

    const topTabs = (
      <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        <Button key="tab-repos" label="Repo trên máy" variant={current === 'repos' || current === 'repo' ? 'primary' : 'secondary'} onPress={() => void showView($, 'repos')} />
        <Button key="tab-remote" label={`Repo trên remote${remoteList.repos.length ? ` (${remoteList.repos.length})` : ''}`} variant={current === 'remote' ? 'primary' : 'secondary'} onPress={() => void showView($, 'remote')} />
        <Button key="tab-accounts" label={`Tài khoản (${accts.length})`} variant={current === 'accounts' ? 'primary' : 'secondary'} onPress={() => void showView($, 'accounts')} />
      </Box>
    )

    const confirmBar = ask0 && (
      <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
        <Text bold color="warning">{ask0.label}</Text>
        {ask0.detail && <Text dimColor>{ask0.detail}</Text>}
        <Box flexDirection="row" gap={1}>
          <Button key="confirm-yes" variant="primary" label="Đồng ý" onPress={() => void confirmed($)} />
          <Button key="confirm-no" label="Huỷ" onPress={() => void cancelConfirm($)} />
        </Box>
      </Box>
    )

    const resultBar = res && (
      <Box flexDirection="column" borderStyle="round" borderColor={res.ok ? 'success' : 'error'} paddingX={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text bold color={res.ok ? 'success' : 'error'}>{res.ok ? '✓' : '✗'} {res.label}</Text>
          <Text dimColor>{ago(res.at, now)}</Text>
          <Button key="result-close" label="Đóng" plain onPress={() => void closeResult($)} />
        </Box>
        {res.text && <Code source={res.text} language="text" wrap="wrap" />}
      </Box>
    )

    const diffBox = df && (
      <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text bold>{df.title}</Text>
          <Button key="diff-close" label="Đóng" plain onPress={() => void closeDiff($)} />
        </Box>
        <Code source={df.source} format={df.format} language={df.format === 'diff' ? undefined : 'text'} />
      </Box>
    )

    const notices = (
      <Box flexDirection="column" gap={1}>
        {confirmBar}
        {resultBar}
      </Box>
    )

    // ── accounts ──
    if (current === 'accounts') {
      const formHost = (form.host || defaultHost(form.provider)).toLowerCase()
      const suggested = [...new Set(list.map(r => settingsOf[r.path]?.remotes[0]?.fetchUrl ?? '')
        .map(u => /^https:\/\/([^@/]+)@([^/]+)\//.exec(u))
        .filter((m): m is RegExpExecArray => Boolean(m) && m?.[2]?.toLowerCase() === formHost)
        .map(m => m[1] ?? ''))].filter(Boolean)
      const app = apps.find(a => a.provider === form.provider && a.host === oauthHostFor(form.provider, form))
      const keyOptions = [
        { value: '', label: 'Theo ~/.ssh/config (mặc định)' },
        ...sshState.keys.map(k => ({ value: k.path, label: `${k.path.split('/').pop()} — ${k.comment || k.fingerprint}` })),
      ]
      const keyLabel = (path: string) => (path ? path.split('/').pop() : '~/.ssh/config')
      const methodLabel = (m: SignInMethod) => (m === 'oauth' ? 'OAuth' : m === 'token' ? 'API token' : 'SSH key')
      const test = sshState.test

      const sshSection = Select && (
        <Box flexDirection="column" gap={1} borderStyle="round" paddingX={1}>
          <Text bold>SSH key</Text>
          <Select key="acct-sshkey" label="Key dùng cho tài khoản này" value={form.sshKey} options={keyOptions} onSelect={v => void setForm($, 'sshKey', v)} />
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="ssh-generate" label="Tạo key mới" onPress={() => void generateSshKey($)} />
            {form.sshKey && <Button key="ssh-copy" label="Copy public key & mở trang thêm key" onPress={() => void copyPublicKey($, form.sshKey)} />}
            <Button key="ssh-test" label={sshState.isTesting ? 'Đang kiểm tra…' : `Kiểm tra kết nối tới ${formHost}`} onPress={() => void testFormSsh($)} />
          </Box>
          {test && test.host === formHost && test.key === form.sshKey && (
            <Text color={test.ok ? 'success' : 'error'}>{test.ok ? '✓ Key vào được' : '✗ Key chưa vào được'} — {test.text.split('\n')[0]}</Text>
          )}
          <Text dimColor>Mod không sửa ~/.ssh/config: key chọn ở đây được dùng riêng cho các lệnh git của tài khoản này.</Text>
        </Box>
      )

      return (
        <Box flexDirection="column" gap={1}>
          {topTabs}
          {notices}
          <Text bold>Tài khoản đã đăng nhập</Text>
          {accts.length === 0 && <Text dimColor>Chưa có tài khoản nào.</Text>}
          {accts.map(a => (
            <Box flexDirection="column">
              <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                <Text color={a.error ? 'error' : 'success'}>{a.error ? '✗' : '●'}</Text>
                <Text bold>{providerLabel(a.provider)}</Text>
                <Text>{a.username}@{a.host}</Text>
                <Text dimColor>{methodLabel(a.method)} · git qua {a.protocol.toUpperCase()}{a.protocol === 'ssh' ? ` (${keyLabel(a.sshKey)})` : ''}</Text>
                {a.scopes.length > 0 && <Text dimColor>[{a.scopes.join(', ')}]</Text>}
                <Text dimColor>{a.error ?? `kiểm tra ${ago(a.verifiedAt, now)}`}</Text>
              </Box>
              <Box flexDirection="row" gap={1} paddingLeft={2} flexWrap="wrap">
                <Button key={`verify:${a.id}`} label="Kiểm tra" plain onPress={() => void verifyAccount($, a.id)} />
                {a.method !== 'ssh' && (
                  <Button
                    key={`proto:${a.id}`}
                    label={a.protocol === 'ssh' ? 'Dùng HTTPS' : 'Dùng SSH'}
                    plain
                    onPress={() => void setAccountProtocol($, a.id, a.protocol === 'ssh' ? 'https' : 'ssh')}
                  />
                )}
                {a.protocol === 'ssh' && form.sshKey !== a.sshKey && (
                  <Button key={`setkey:${a.id}`} label={`Dùng key ${keyLabel(form.sshKey)} đang chọn bên dưới`} plain onPress={() => void setAccountKey($, a.id, form.sshKey)} />
                )}
                <Button key={`logout:${a.id}`} label="Đăng xuất" plain onPress={() => void ask($, ['logout', a.id].join(SEP), `Đăng xuất ${a.username}@${a.host}?`, a.method === 'ssh' ? 'Chỉ bỏ tài khoản khỏi mod; SSH key vẫn còn.' : 'Token sẽ bị xoá khỏi Keychain (git credential reject).')} />
              </Box>
            </Box>
          ))}

          {progress && (
            <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
              <Text color="suggestion">⟳ {providerLabel(progress.provider)}: {progress.message}</Text>
              {progress.stage === 'device' && (
                <Box flexDirection="row" gap={1} alignItems="center">
                  <Text>Mã:</Text>
                  <Text bold color="claude">{progress.userCode}</Text>
                  <Button key="oauth-reopen" label="Mở lại trang" plain onPress={() => void openUrl($, progress.verifyUrl)} />
                </Box>
              )}
              <Button key="oauth-cancel" label="Huỷ" plain onPress={() => void cancelOAuth($)} />
            </Box>
          )}

          {Input && Select && (
            <Box flexDirection="column" gap={1} borderStyle="round" paddingX={1}>
              <Text bold>Thêm tài khoản</Text>
              <Select key="acct-provider" label="Nhà cung cấp" value={form.provider} options={PROVIDERS.map(x => ({ value: x.value, label: x.label }))} onSelect={v => void setForm($, 'provider', v)} />
              {form.provider !== 'bitbucket' && (
                <Input key="acct-host" label="Host (GitHub Enterprise / GitLab tự host thì sửa)" value={form.host} onInput={v => void setForm($, 'host', v)} onSubmit={v => void setForm($, 'host', v)} />
              )}
              <Select
                key="acct-method"
                label="Kiểu đăng nhập"
                value={form.method}
                options={[
                  { value: 'oauth', label: 'OAuth — đăng nhập bằng trình duyệt' },
                  { value: 'token', label: 'API token / personal access token' },
                  { value: 'ssh', label: 'Chỉ SSH key (git; không xem được repo trên remote và PR)' },
                ]}
                onSelect={v => void setForm($, 'method', v)}
              />
              <Select
                key="acct-protocol"
                label="Git dùng giao thức"
                value={form.protocol}
                options={form.method === 'ssh'
                  ? [{ value: 'ssh', label: 'SSH' }]
                  : [{ value: 'https', label: 'HTTPS (dùng token đã đăng nhập)' }, { value: 'ssh', label: 'SSH (dùng SSH key)' }]}
                onSelect={v => void setForm($, 'protocol', v)}
              />
              {form.method !== 'ssh' && (
                <Input
                  key="acct-scopes"
                  label={form.provider === 'bitbucket' ? 'Workspace để liệt kê repo (tuỳ chọn, phẩy ngăn cách)' : form.provider === 'github' ? 'Organization (tuỳ chọn; trống = mọi repo bạn thấy)' : 'Group (tuỳ chọn; trống = mọi project của bạn)'}
                  value={form.scopes}
                  onInput={v => void setForm($, 'scopes', v)}
                  onSubmit={v => void setForm($, 'scopes', v)}
                />
              )}

              {form.method === 'oauth' && (app ? (
                <Button key={`oauth:${form.provider}`} variant="primary" label={`Đăng nhập ${providerLabel(form.provider)} bằng trình duyệt`} onPress={() => void oauthLogin($, form.provider)} />
              ) : (
                <Box flexDirection="column" gap={1}>
                  <Text color="warning">{providerLabel(form.provider)} chưa có OAuth app cho mod này: cần đăng ký một lần (như Atlassian đã làm sẵn cho SourceTree), hoặc chọn kiểu đăng nhập khác.</Text>
                  <Button key={`oauth-setup:${form.provider}`} label={`${f[`oauthSetup:${form.provider}`] ? '▾' : '▸'} Cấu hình OAuth app`} onPress={() => void toggleFlag($, `oauthSetup:${form.provider}`)} />
                </Box>
              ))}

              {form.method === 'token' && (
                <Box flexDirection="column" gap={1}>
                  <Input key="acct-username" label="Username" placeholder={suggested[0] ?? ''} value={form.username} onInput={v => void setForm($, 'username', v)} onSubmit={v => void setForm($, 'username', v)} />
                  {form.provider === 'bitbucket' && (
                    <Input key="acct-email" label="Email Atlassian (cho REST API)" value={form.email} onInput={v => void setForm($, 'email', v)} onSubmit={v => void setForm($, 'email', v)} />
                  )}
                  <Text dimColor>{tokenHint(form.provider)}</Text>
                  {suggested.length > 0 && <Text dimColor>Remote của bạn đang dùng username: {suggested.join(', ')}</Text>}
                  <Box flexDirection="row" gap={1} flexWrap="wrap">
                    <Button key="acct-token-page" label="1. Mở trang tạo token" onPress={() => void openTokenPage($)} />
                    {busyOf.login ? <Text color="suggestion">Đang kiểm tra token…</Text> : (
                      <Button key="acct-login" variant="primary" label="2. Copy token rồi bấm: Đăng nhập bằng token trong clipboard" onPress={() => void login($)} />
                    )}
                  </Box>
                  <Text dimColor>Token không gõ vào đây và không hiện ra: mod đọc từ clipboard, kiểm tra với {formHost}, lưu vào Keychain qua git credential rồi xoá clipboard.</Text>
                </Box>
              )}

              {form.method === 'ssh' && (
                <Box flexDirection="column" gap={1}>
                  {form.provider === 'bitbucket' && (
                    <Input key="acct-username" label="Username (Bitbucket không báo tên qua SSH; chỉ để hiển thị)" placeholder={suggested[0] ?? ''} value={form.username} onInput={v => void setForm($, 'username', v)} onSubmit={v => void setForm($, 'username', v)} />
                  )}
                  {sshSection}
                  <Button key="acct-ssh-add" variant="primary" label="Kiểm tra key và thêm tài khoản" onPress={() => void sshLogin($)} />
                </Box>
              )}
              {form.method !== 'ssh' && form.protocol === 'ssh' && sshSection}
            </Box>
          )}

          {PROVIDERS.filter(x => f[`oauthSetup:${x.value}`]).map(x => (
            <Box flexDirection="column" gap={1} borderStyle="round" paddingX={1}>
              <Text bold>Cấu hình OAuth app cho {x.label} ({oauthHostFor(x.value, form)})</Text>
              <Text dimColor>Làm một lần (thường do người phát hành mod hoặc admin), rồi mọi người chỉ cần bấm đăng nhập. {oauthAppHint(x.value)}</Text>
              {x.value === 'bitbucket' && draftInput('oauthws', 'Workspace đặt consumer — chỉ dùng để mở đúng trang cài đặt, không ảnh hưởng đăng nhập (trống = đoán từ remote)', guessWorkspace(list) || 'tên workspace')}
              <Button key={`oauth-page:${x.value}`} label="Mở trang tạo OAuth app" onPress={() => void openOAuthAppPage($, x.value)} />
              {draftInput(`oauthid:${x.value}`, x.value === 'bitbucket' ? 'Key của consumer' : x.value === 'github' ? 'Client ID' : 'Application ID')}
              <Button
                key={`oauth-save:${x.value}`}
                variant="primary"
                label={x.value === 'bitbucket' ? 'Copy Secret rồi bấm: Lưu (secret lấy từ clipboard)' : 'Lưu'}
                onPress={() => void saveOAuthApp($, x.value)}
              />
              <Text dimColor>Để cả nhóm không phải làm bước này: điền vào cài đặt của plugin (bitbucketOAuthKey / bitbucketOAuthSecret, githubOAuthClientId, gitlabOAuthClientId + gitlabHost).</Text>
            </Box>
          ))}
          {apps.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>OAuth app đã cấu hình:</Text>
              {apps.map(a => (
                <Box flexDirection="row" gap={1} alignItems="center">
                  <Text>{providerLabel(a.provider)} · {a.host}</Text>
                  <Text dimColor>{a.clientId.slice(0, 8)}… · {a.source === 'settings' ? 'từ cài đặt plugin' : 'lưu trên máy này'}</Text>
                  {a.source === 'pane' && (
                    <Button key={`oauth-rm:${a.provider}:${a.host}`} label="Xoá" plain onPress={() => void ask($, ['oauth-app-remove', a.provider, a.host].join(SEP), `Xoá cấu hình OAuth app ${providerLabel(a.provider)} (${a.host})?`, 'Tài khoản đã đăng nhập vẫn còn, nhưng không tự làm mới token được nữa.')} />
                  )}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    // ── remote repos ──
    if (current === 'remote') {
      const local = new Map(list.filter(r => r.remote).map(r => [r.remote as string, r.path]))
      const onDisk = new Set(remoteList.onDisk)
      const q = d.remoteq ?? ''
      const shown = remoteList.repos.filter(r => matchesQuery(r, q))

      const action = (rr: RemoteRepo) => {
        const localPath = local.get(rr.key)
        if (localPath) return <Button key={`open:${rr.key}`} label="Mở" onPress={() => void openRepo($, localPath)} />
        if (busyOf[`clone:${rr.key}`]) return <Text color="suggestion">đang clone…</Text>
        if (onDisk.has(rr.slug)) return <Button key={`watch:${rr.key}`} label="Có thư mục · Theo dõi" onPress={() => void watch($, `${cfg.cloneDir}/${rr.slug}`)} />
        return <Button key={`clone:${rr.key}`} label="Clone" onPress={() => void clone($, rr)} />
      }

      return (
        <Box flexDirection="column" gap={1}>
          {topTabs}
          {notices}
          <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
            <Text dimColor>
              {remoteList.isLoading ? 'Đang tải danh sách…' : `${accts.length} tài khoản · ${remoteList.repos.length} repo · cập nhật ${ago(remoteList.at, now)}`}
            </Text>
            <Button key="remote-reload" label="Tải lại" onPress={() => void loadRemote($)} />
            <Text dimColor>Clone vào {cfg.cloneDir}</Text>
          </Box>
          {draftInput('remoteq', 'Tìm repo', 'tên, project, mô tả, host…')}
          {remoteList.errors.map(err => <Text color="error">{err}</Text>)}
          <Box flexDirection="column">
            {shown.slice(0, MAX_REMOTE_ROWS).map(rr => (
              <Box flexDirection="row" gap={1} alignItems="center">
                <Text dimColor>{providerLabel(rr.provider)}</Text>
                <Text bold wrap="truncate-middle">{rr.fullName}</Text>
                {rr.project && <Text dimColor wrap="truncate-end">{rr.project}</Text>}
                {rr.mainBranch && <Text color="inactive">{rr.mainBranch}</Text>}
                <Text dimColor>{shortDate(rr.updatedOn)}</Text>
                {action(rr)}
              </Box>
            ))}
            {shown.length > MAX_REMOTE_ROWS && <Text dimColor>… còn {shown.length - MAX_REMOTE_ROWS} repo nữa, gõ để lọc</Text>}
            {!remoteList.isLoading && remoteList.at != null && shown.length === 0 && remoteList.errors.length === 0 && (
              <Text dimColor>Không có repo nào khớp.</Text>
            )}
          </Box>
        </Box>
      )
    }

    // ── one repo ──
    const repo = sel ? repoOf(list, sel.repo) : undefined
    if (current === 'repo' && sel && repo) {
      const wt = repo.worktrees.find(w => w.path === sel.worktree) ?? repo.worktrees[0]
      const cwd = wt?.path ?? repo.path
      const running = busyOf[cwd]
      const s = settingsOf[repo.path]
      const branchName = wt && !wt.isDetached ? wt.branch : ''

      const header = (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
            <Button key="back" label="← Danh sách" plain onPress={() => void showView($, 'repos')} />
            <Text bold>{repo.name}</Text>
            {wt && dot(wt)}
            {wt && <Text bold color="suggestion">{wt.branch}</Text>}
            {wt && <Text color={wt.behind ? 'warning' : wt.ahead ? 'suggestion' : 'inactive'}>{sync(wt)}</Text>}
            {wt && !isClean(wt) && <Text color="warning">{counts(wt)}</Text>}
            {p?.opState && <Text color="error">đang {p.opState}</Text>}
            {running && <Text color="suggestion">⟳ {running}…</Text>}
          </Box>
          {repo.worktrees.length > 1 && Select && (
            <Select
              key="worktree"
              label="Worktree"
              value={cwd}
              options={repo.worktrees.map(w => ({ value: w.path, label: `${w.label} — ${w.branch}${isClean(w) ? '' : ' ◐'}${w.behind ? ` ↓${w.behind}` : ''}` }))}
              onSelect={v => void selectWorktree($, v)}
            />
          )}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="act-fetch" hotkey="f" label="Fetch" onPress={() => void fetchOne($, repo.path)} />
            <Button key="act-pull" hotkey="l" label={`Pull${wt?.behind ? ` ↓${wt.behind}` : ''}`} onPress={() => void pullFf($, cwd)} />
            <Button key="act-push" hotkey="u" label={`Push${wt?.ahead ? ` ↑${wt.ahead}` : ''}`} onPress={() => void push($, cwd)} />
            <Button key="act-stash" label="Stash" onPress={() => void stashSave($, cwd)} />
            <Button key="act-finder" label="Finder" plain onPress={() => void openIn($, cwd, 'finder')} />
            <Button key="act-terminal" label="Terminal" plain onPress={() => void openIn($, cwd, 'terminal')} />
            <Button key="act-vscode" label="VS Code" plain onPress={() => void openIn($, cwd, 'vscode')} />
            <Button key="act-sourcetree" label="SourceTree" plain onPress={() => void openIn($, cwd, 'sourcetree')} />
          </Box>
          {repo.fetchError && <Text color="error">fetch: {repo.fetchError}</Text>}
          {!repo.remote && s && !s.remotes.some(r => r.name === 'origin') && (
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text color="warning">Repo chưa có remote.</Text>
              <Button key="pub-shortcut" label="Publish lên remote" onPress={() => void setTab($, 'settings')} />
            </Box>
          )}
        </Box>
      )

      const tabs = (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {TABS.map(t => {
            const badge = t.tab === 'changes' && wt && !isClean(wt) ? ` (${wt.files.length})`
              : t.tab === 'stash' && p?.stashes.length ? ` (${p.stashes.length})`
                : t.tab === 'prs' && p?.prs.length ? ` (${p.prs.length})` : ''
            return (
              <Button key={`rtab:${t.tab}`} label={`${t.label}${badge}`} variant={sel.tab === t.tab ? 'primary' : 'secondary'} onPress={() => void setTab($, t.tab)} />
            )
          })}
        </Box>
      )

      const fileRow = (file: ChangedFile, group: 'staged' | 'unstaged' | 'untracked' | 'conflict') => (
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color={group === 'conflict' ? 'error' : group === 'staged' ? 'success' : group === 'untracked' ? 'inactive' : 'warning'}>{file.code}</Text>
          <Button key={`diff:${group}:${file.path}`} label={file.path} plain onPress={() => void showFileDiff($, cwd, file, group === 'staged')} />
          {group === 'staged' && <Button key={`unstage:${file.path}`} label="Unstage" plain onPress={() => void unstage($, cwd, file.path)} />}
          {(group === 'unstaged' || group === 'untracked') && <Button key={`stage:${group}:${file.path}`} label="Stage" plain onPress={() => void stage($, cwd, file.path)} />}
          {(group === 'unstaged' || group === 'untracked') && (
            <Button
              key={`discard:${group}:${file.path}`}
              label={group === 'untracked' ? 'Xoá' : 'Bỏ thay đổi'}
              plain
              onPress={() => void ask($, ['discard-file', cwd, file.path, group].join(SEP), group === 'untracked' ? `Xoá file mới ${file.path}?` : `Bỏ mọi thay đổi của ${file.path}?`, 'Không hoàn tác được.')}
            />
          )}
          {group === 'conflict' && (
            <Box flexDirection="row" gap={1}>
              <Button key={`ours:${file.path}`} label="Dùng của mình" plain onPress={() => void resolve($, cwd, file.path, 'ours')} />
              <Button key={`theirs:${file.path}`} label="Dùng của họ" plain onPress={() => void resolve($, cwd, file.path, 'theirs')} />
              <Button key={`resolved:${file.path}`} label="Đã sửa tay xong" plain onPress={() => void markResolved($, cwd, file.path)} />
            </Box>
          )}
        </Box>
      )

      const section = (title: string, children: unknown, actions?: unknown) => (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text bold>{title}</Text>
            {actions as never}
          </Box>
          <Box flexDirection="column" paddingLeft={1}>{children as never}</Box>
        </Box>
      )

      let body: unknown = null
      if (sel.tab === 'changes' && wt) {
        const files = wt.files
        const conflicts = files.filter(x => x.isConflicted)
        const staged = files.filter(x => x.isStaged)
        const unstaged = files.filter(x => x.isUnstaged)
        const untracked = files.filter(x => x.isUntracked)
        body = (
          <Box flexDirection="column" gap={1}>
            {isClean(wt) && <Text color="success">● Không có thay đổi nào.</Text>}
            {conflicts.length > 0 && section(`Conflict (${conflicts.length})`, conflicts.map(x => fileRow(x, 'conflict')))}
            {staged.length > 0 && section(`Đã stage (${staged.length})`, staged.map(x => fileRow(x, 'staged')),
              <Button key="unstage-all" label="Unstage tất cả" plain onPress={() => void unstageAll($, cwd)} />)}
            {unstaged.length > 0 && section(`Đã sửa (${unstaged.length})`, unstaged.map(x => fileRow(x, 'unstaged')),
              <Box flexDirection="row" gap={1}>
                <Button key="stage-all" label="Stage tất cả" plain onPress={() => void stageAll($, cwd)} />
                <Button key="discard-all" label="Bỏ hết thay đổi" plain onPress={() => void ask($, ['discard-all', cwd].join(SEP), 'Bỏ mọi thay đổi (cả đã stage) trong worktree này?', 'File mới chưa theo dõi được giữ lại. Không hoàn tác được.')} />
              </Box>)}
            {untracked.length > 0 && section(`File mới (${untracked.length})`, untracked.map(x => fileRow(x, 'untracked')),
              <Button key="stage-all-new" label="Stage tất cả" plain onPress={() => void stageAll($, cwd)} />)}
            {files.length < wt.staged + wt.modified + wt.untracked + wt.conflicted && <Text dimColor>… danh sách bị cắt bớt</Text>}
            {Input && (
              <Box flexDirection="column" borderStyle="round" paddingX={1}>
                {draftInput(`commit:${cwd}`, `Commit lên ${wt.branch}`, 'commit message', () => void commit($, cwd))}
                <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
                  {flagButton('amend', 'Amend commit trước')}
                  {flagButton('pushAfterCommit', 'Push ngay sau khi commit')}
                  <Button key="commit" variant="primary" label={f.amend ? 'Amend' : `Commit (${staged.length} file)`} onPress={() => void commit($, cwd)} />
                </Box>
              </Box>
            )}
          </Box>
        )
      } else if (sel.tab === 'branches' && p) {
        const bq = (d[`branchq:${cwd}`] ?? '').toLowerCase()
        const locals = p.branches.filter(b => b.name.toLowerCase().includes(bq))
        const remotes = p.remoteBranches.filter(b => b.name.toLowerCase().includes(bq)).slice(0, MAX_LIST)
        body = (
          <Box flexDirection="column" gap={1}>
            {Input && Select && (
              <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold>Tạo branch từ {wt?.branch ?? 'HEAD'}</Text>
                <Select key="prefix" label="Tiền tố" value={d[`prefix:${cwd}`] ?? ''} options={(p.flow ? ['', p.flow.feature, p.flow.bugfix, p.flow.release, p.flow.hotfix, p.flow.support].filter((x, i, all) => all.indexOf(x) === i) : BRANCH_PREFIXES).map(x => ({ value: x, label: x || '(không)' }))} onSelect={v => void setDraft($, `prefix:${cwd}`, v)} />
                {draftInput(`branch:${cwd}`, 'Tên branch', 'SPT-1234-mo-ta-ngan', () => void createBranch($, cwd))}
                <Button key="create-branch" variant="primary" label="Tạo và checkout" onPress={() => void createBranch($, cwd)} />
              </Box>
            )}
            {draftInput(`branchq:${cwd}`, 'Lọc branch', 'gõ một phần tên')}
            {section(`Branch trên máy (${locals.length})`, locals.map(b => (
              <Box flexDirection="column">
                <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                  <Text color={b.isHead ? 'success' : 'inactive'}>{b.isHead ? '●' : '○'}</Text>
                  <Text bold={b.isHead}>{b.name}</Text>
                  {b.upstream ? <Text dimColor>→ {b.upstream}</Text> : <Text dimColor>(chưa push)</Text>}
                  {b.track && <Text color={b.track.includes('gone') ? 'error' : 'warning'}>{b.track}</Text>}
                  <Text dimColor>{b.when}</Text>
                </Box>
                <Box flexDirection="row" gap={1} paddingLeft={2} flexWrap="wrap">
                  {!b.isHead && <Button key={`co:${b.name}`} label="Checkout" plain onPress={() => void checkout($, cwd, b.name)} />}
                  {!b.isHead && <Button key={`merge:${b.name}`} label={`Merge vào ${wt?.branch}`} plain onPress={() => void ask($, ['merge', cwd, b.name].join(SEP), `Merge ${b.name} vào ${wt?.branch}?`, '')} />}
                  {!b.isHead && <Button key={`rebase:${b.name}`} label={`Rebase ${wt?.branch} lên đây`} plain onPress={() => void ask($, ['rebase', cwd, b.name].join(SEP), `Rebase ${wt?.branch} lên ${b.name}?`, 'Viết lại lịch sử của branch hiện tại; branch đã push sẽ cần force push.')} />}
                  <Button key={`pushb:${b.name}`} label="Push" plain onPress={() => void pushBranch($, cwd, b.name)} />
                  <Button key={`wt:${b.name}`} label="Mở worktree" plain onPress={() => void addWorktree($, repo.path, cwd, b.name)} />
                  {b.isHead && Input && <Button key={`rename:${b.name}`} label="Đổi tên (nhập bên dưới)" plain onPress={() => void renameBranch($, cwd, b.name)} />}
                  {!b.isHead && <Button key={`del:${b.name}`} label="Xoá" plain onPress={() => void ask($, ['delete-branch', cwd, b.name, 'safe'].join(SEP), `Xoá branch ${b.name}?`, 'Chỉ xoá được khi đã merge; muốn xoá hẳn dùng "Xoá hẳn".')} />}
                  {!b.isHead && <Button key={`delf:${b.name}`} label="Xoá hẳn" plain onPress={() => void ask($, ['delete-branch', cwd, b.name, 'force'].join(SEP), `Xoá hẳn ${b.name} (kể cả commit chưa merge)?`, 'Commit chưa merge ở branch này sẽ mất.')} />}
                </Box>
              </Box>
            )))}
            {Input && draftInput(`rename:${cwd}`, `Tên mới cho ${wt?.branch ?? ''}`, '', () => wt && void renameBranch($, cwd, wt.branch))}
            {section(`Branch trên remote (${p.remoteBranches.length})`, remotes.map(b => (
              <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                <Text>{b.name}</Text>
                <Text dimColor>{b.when}</Text>
                <Button key={`cor:${b.name}`} label="Checkout" plain onPress={() => void checkoutRemote($, cwd, b.name)} />
                <Button
                  key={`delr:${b.name}`}
                  label="Xoá trên remote"
                  plain
                  onPress={() => void ask($, ['delete-remote-branch', cwd, b.name.split('/').slice(1).join('/'), b.name.split('/')[0] ?? 'origin'].join(SEP), `Xoá branch ${b.name} trên remote?`, 'Ảnh hưởng tới mọi người dùng repo.')}
                />
              </Box>
            )))}
          </Box>
        )
      } else if (sel.tab === 'history' && p) {
        body = (
          <Box flexDirection="column" gap={1}>
            {draftInput(`logq:${cwd}`, 'Tìm commit', 'chữ trong message, hoặc @tên-tác-giả', () => void loadPanel($, false))}
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key="log-search" label="Tìm" onPress={() => void loadPanel($, false)} />
              {flagButton('graph', 'Đồ thị')}
              {f.graph && flagButton('graphCurrent', 'Chỉ branch hiện tại')}
            </Box>
            {f.graph && p.graph.length > 0 && Svg && (() => {
              // the SVG is drawn at the pane's width; rows are dropped until it fits the element's size limit
              const width = Math.min(1400, Math.max(480, (e.props.bodyColumns ?? 100) * 8))
              let rows = p.graph
              let drawn = graphSvg(rows, width, p.remoteNames, d[`open:${cwd}`] ?? '')
              while (drawn.svg.length > 130_000 && rows.length > 10) {
                rows = rows.slice(0, Math.floor(rows.length * 0.8))
                drawn = graphSvg(rows, width, p.remoteNames, d[`open:${cwd}`] ?? '')
              }
              return <Svg source={drawn.svg} alt={`Đồ thị ${rows.length} commit gần nhất`} width={width} height={drawn.height} />
            })()}
            {f.graph && !Svg && p.graphText && <Code source={p.graphText} language="text" />}
            {f.graph && <Text bold>Commit (bấm mã để xem và thao tác)</Text>}
            {p.log.map(c => (
              <Box flexDirection="column">
                <Box flexDirection="row" gap={1} alignItems="center">
                  <Button key={`show:${c.hash}`} label={c.short} plain onPress={() => void pickCommit($, cwd, c.hash)} />
                  <Text wrap="truncate-end">{c.subject}</Text>
                  {c.refs && <Text color="suggestion" wrap="truncate-end">({c.refs})</Text>}
                  <Text dimColor>{c.author} · {c.when}</Text>
                </Box>
                {(d[`open:${cwd}`] ?? '') === c.hash && (
                  <Box flexDirection="row" gap={1} paddingLeft={2} flexWrap="wrap">
                    <Button key={`cp:${c.hash}`} label="Cherry-pick" plain onPress={() => void ask($, ['cherry-pick', cwd, c.hash].join(SEP), `Cherry-pick ${c.short} vào ${wt?.branch}?`, c.subject)} />
                    <Button key={`rv:${c.hash}`} label="Revert" plain onPress={() => void ask($, ['revert', cwd, c.hash].join(SEP), `Tạo commit revert ${c.short}?`, c.subject)} />
                    <Button key={`rs:${c.hash}`} label="Reset soft" plain onPress={() => void ask($, ['reset', cwd, c.hash, 'soft'].join(SEP), `Reset --soft ${wt?.branch} về ${c.short}?`, 'Giữ thay đổi ở trạng thái đã stage.')} />
                    <Button key={`rm:${c.hash}`} label="Reset mixed" plain onPress={() => void ask($, ['reset', cwd, c.hash, 'mixed'].join(SEP), `Reset --mixed ${wt?.branch} về ${c.short}?`, 'Giữ thay đổi trong file, bỏ stage.')} />
                    <Button key={`rh:${c.hash}`} label="Reset hard" plain onPress={() => void ask($, ['reset', cwd, c.hash, 'hard'].join(SEP), `Reset --hard ${wt?.branch} về ${c.short}?`, 'MẤT mọi thay đổi chưa commit và các commit sau nó. Không hoàn tác được.')} />
                    <Button key={`bt:${c.hash}`} label="Tạo branch tại đây" plain onPress={() => void branchAt($, cwd, c.hash)} />
                    <Button key={`tt:${c.hash}`} label="Tạo tag tại đây" plain onPress={() => void tagAt($, cwd, c.hash)} />
                  </Box>
                )}
              </Box>
            ))}
            <Text dimColor>Bấm mã commit để xem nội dung và các thao tác (cherry-pick, revert, reset, tạo branch/tag — tên lấy từ ô ở tab Branch / Tag).</Text>
          </Box>
        )
      } else if (sel.tab === 'flow' && p) {
        const c = p.flow
        if (!c) {
          const names = new Set(p.branches.map(b => b.name))
          const guess = names.has('main') && !names.has('master') ? 'main' : 'master'
          const dflt = flowDefaults(guess)
          body = (
            <Box flexDirection="column" gap={1}>
              <Text>Repo này chưa bật git-flow. Thiết lập như <Text bold>git flow init</Text> (tương thích git-flow AVH và SourceTree):</Text>
              {Input && (
                <Box flexDirection="column" borderStyle="round" paddingX={1}>
                  {draftInput('flow:master', 'Branch production', dflt.master)}
                  {draftInput('flow:develop', 'Branch phát triển', dflt.develop)}
                  {draftInput('flow:feature', 'Tiền tố feature', dflt.feature)}
                  {draftInput('flow:bugfix', 'Tiền tố bugfix', dflt.bugfix)}
                  {draftInput('flow:release', 'Tiền tố release', dflt.release)}
                  {draftInput('flow:hotfix', 'Tiền tố hotfix', dflt.hotfix)}
                  {draftInput('flow:support', 'Tiền tố support', dflt.support)}
                  {draftInput('flow:versiontag', 'Tiền tố tag phiên bản', 'v (để trống = không)')}
                  <Text dimColor>Ô để trống dùng giá trị gợi ý. Branch phát triển chưa có sẽ được tạo từ branch production.</Text>
                  <Button key="flow-init" variant="primary" label="Bật git-flow" onPress={() => void flowInit($, cwd)} />
                </Box>
              )}
            </Box>
          )
        } else {
          const active = p.branches
            .map(b => ({ b, k: flowKindOf(b.name, c) }))
            .filter((x): x is { b: typeof x.b; k: NonNullable<typeof x.k> } => x.k !== null)
          const currentKind = branchName ? flowKindOf(branchName, c) : null
          body = (
            <Box flexDirection="column" gap={1}>
              <Text dimColor>
                production: <Text bold>{c.master}</Text> · phát triển: <Text bold>{c.develop}</Text> · {FLOW_KINDS.map(k => `${k.label.toLowerCase()} ${c[k.kind] || '—'}`).join(' · ')}{c.versiontag ? ` · tag ${c.versiontag}` : ''}
              </Text>
              {currentKind && (
                <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" borderStyle="round" borderColor="suggestion" paddingX={1}>
                  <Text>Đang ở {currentKind.kind} <Text bold>{currentKind.name}</Text></Text>
                  <Button key="flow-finish-current" variant="primary" label={`Hoàn tất ${currentKind.kind}`} onPress={() => void askFlowFinish($, cwd, branchName)} />
                  <Button key="flow-publish-current" label="Publish (push)" onPress={() => void pushBranch($, cwd, branchName)} />
                </Box>
              )}
              {Input && section('Bắt đầu', (
                <Box flexDirection="column">
                  {FLOW_KINDS.map(k => (
                    <Box flexDirection="row" gap={1} alignItems="center">
                      {draftInput(`flowname:${k.kind}`, `${k.label} mới (từ ${k.from === 'master' ? c.master : c.develop})`, k.kind === 'release' || k.kind === 'hotfix' ? '1.2.0' : 'ten-ngan-gon', () => void flowStart($, cwd, k.kind))}
                      <Button key={`flow-start:${k.kind}`} label={`Bắt đầu ${k.label}`} onPress={() => void flowStart($, cwd, k.kind)} />
                    </Box>
                  ))}
                </Box>
              ))}
              {section('Tuỳ chọn khi hoàn tất', (
                <Box flexDirection="column">
                  <Box flexDirection="row" gap={1} flexWrap="wrap">
                    {flagButton('flowKeep', 'Giữ lại branch')}
                    {flagButton('flowPush', 'Push các branch và tag sau khi xong')}
                  </Box>
                  {draftInput('flowtag', 'Ghi chú tag (release / hotfix)', 'Release <phiên bản>')}
                </Box>
              ))}
              {section(`Branch git-flow đang mở (${active.length})`, active.length === 0 ? <Text dimColor>Chưa có.</Text> : active.map(({ b, k }) => (
                <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                  <Text color={b.isHead ? 'success' : 'inactive'}>{b.isHead ? '●' : '○'}</Text>
                  <Text dimColor>{k.kind}</Text>
                  <Text bold={b.isHead}>{k.name}</Text>
                  {b.upstream ? <Text dimColor>đã publish</Text> : <Text dimColor>chưa publish</Text>}
                  {!b.isHead && <Button key={`flow-co:${b.name}`} label="Checkout" plain onPress={() => void checkout($, cwd, b.name)} />}
                  <Button key={`flow-pub:${b.name}`} label="Publish" plain onPress={() => void pushBranch($, cwd, b.name)} />
                  {k.kind !== 'support' && <Button key={`flow-fin:${b.name}`} label="Hoàn tất" plain onPress={() => void askFlowFinish($, cwd, b.name)} />}
                </Box>
              )))}
            </Box>
          )
        }
      } else if (sel.tab === 'stash' && p) {
        body = (
          <Box flexDirection="column" gap={1}>
            {Input && (
              <Box flexDirection="column" borderStyle="round" paddingX={1}>
                {draftInput(`stash:${cwd}`, 'Stash thay đổi hiện tại', 'ghi chú (tuỳ chọn)', () => void stashSave($, cwd))}
                <Box flexDirection="row" gap={1}>
                  {flagButton('stashUntracked', 'Gồm cả file mới')}
                  <Button key="stash-save" variant="primary" label="Stash" onPress={() => void stashSave($, cwd)} />
                </Box>
              </Box>
            )}
            {p.stashes.length === 0 && <Text dimColor>Chưa có stash nào.</Text>}
            {p.stashes.map(st => (
              <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                <Button key={`ss:${st.ref}`} label={st.ref} plain onPress={() => void showStash($, cwd, st.ref)} />
                <Text wrap="truncate-end">{st.message}</Text>
                <Text dimColor>{st.when}</Text>
                <Button key={`sa:${st.ref}`} label="Apply" plain onPress={() => void stashApply($, cwd, st.ref, false)} />
                <Button key={`sp:${st.ref}`} label="Pop" plain onPress={() => void stashApply($, cwd, st.ref, true)} />
                <Button key={`sd:${st.ref}`} label="Xoá" plain onPress={() => void ask($, ['stash-drop', cwd, st.ref].join(SEP), `Xoá ${st.ref}?`, st.message)} />
              </Box>
            ))}
          </Box>
        )
      } else if (sel.tab === 'tags' && p) {
        body = (
          <Box flexDirection="column" gap={1}>
            {Input && (
              <Box flexDirection="column" borderStyle="round" paddingX={1}>
                {draftInput(`tag:${cwd}`, 'Tên tag mới (gắn vào HEAD, hoặc commit chọn ở tab Lịch sử)', 'v1.2.3')}
                {draftInput(`tagmsg:${cwd}`, 'Ghi chú (có thì tạo annotated tag)', '')}
                <Box flexDirection="row" gap={1}>
                  <Button key="tag-create" variant="primary" label="Tạo tag tại HEAD" onPress={() => void createTag($, cwd)} />
                  <Button key="tag-push-all" label="Push mọi tag" onPress={() => void pushAllTags($, cwd)} />
                </Box>
              </Box>
            )}
            {p.tags.length === 0 && <Text dimColor>Chưa có tag nào.</Text>}
            {p.tags.map(t => (
              <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                <Button key={`tshow:${t.name}`} label={t.name} plain onPress={() => void showCommit($, cwd, `refs/tags/${t.name}`)} />
                <Text dimColor wrap="truncate-end">{t.subject}</Text>
                <Text dimColor>{t.when}</Text>
                <Button key={`tpush:${t.name}`} label="Push" plain onPress={() => void pushTag($, cwd, t.name)} />
                <Button key={`tdel:${t.name}`} label="Xoá" plain onPress={() => void ask($, ['tag-delete', cwd, t.name].join(SEP), `Xoá tag ${t.name} trên máy?`, '')} />
                <Button key={`tdelr:${t.name}`} label="Xoá trên remote" plain onPress={() => void ask($, ['tag-delete-remote', cwd, t.name].join(SEP), `Xoá tag ${t.name} trên remote?`, 'Ảnh hưởng tới mọi người dùng repo.')} />
              </Box>
            ))}
          </Box>
        )
      } else if (sel.tab === 'prs' && p) {
        const mine = p.prs.filter(pr => pr.source === branchName)
        body = (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" gap={1} alignItems="center">
              <Button key="pr-reload" label="Tải lại" onPress={() => void loadPrs($)} />
              {p.prError && <Text color="error">{p.prError}</Text>}
            </Box>
            {mine.length > 0 && <Text color="success">Branch {branchName} đã có PR: #{mine.map(x => x.id).join(', #')}</Text>}
            {p.prs.length === 0 && !p.prError && <Text dimColor>Không có pull request nào đang mở.</Text>}
            {p.prs.map(pr => (
              <Box flexDirection="column">
                <Box flexDirection="row" gap={1} alignItems="center">
                  <Text bold color={pr.source === branchName ? 'success' : undefined}>#{pr.id}</Text>
                  <Link href={pr.url} label={pr.title} />
                </Box>
                <Text dimColor>  {pr.source} → {pr.target} · {pr.author} · {shortDate(pr.updated)}</Text>
              </Box>
            ))}
            {Input && branchName && (
              <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold>Tạo pull request từ {branchName}</Text>
                {draftInput(`prtitle:${cwd}`, 'Tiêu đề', branchName)}
                {draftInput(`prtarget:${cwd}`, 'Branch đích', 'release / master / develop…')}
                {draftInput(`prdesc:${cwd}`, 'Mô tả (tuỳ chọn)', '')}
                <Text dimColor>Push branch trước khi tạo PR{wt && !wt.upstream ? ' — branch này chưa có trên remote' : ''}.</Text>
                <Button key="pr-create" variant="primary" label="Tạo pull request" onPress={() => void createPr($, cwd, branchName)} />
              </Box>
            )}
          </Box>
        )
      } else if (sel.tab === 'advanced' && p) {
        const others = repo.worktrees.filter(w => w.path !== repo.path)
        body = (
          <Box flexDirection="column" gap={1}>
            {p.opState && section(`Đang ${p.opState} dở`, (
              <Box flexDirection="row" gap={1}>
                <Button key="op-continue" variant="primary" label="Tiếp tục" onPress={() => void continueOp($, cwd, p.opState as string)} />
                <Button key="op-abort" label="Huỷ bỏ" onPress={() => void ask($, ['abort', cwd, p.opState as string].join(SEP), `Huỷ ${p.opState} đang dở?`, 'Đưa worktree về trước khi bắt đầu.')} />
              </Box>
            ))}
            {section('Pull / Push nâng cao', (
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                <Button key="pull-merge" label="Pull (merge)" onPress={() => void ask($, ['pull-merge', cwd].join(SEP), 'Pull và tạo merge commit nếu cần?', '')} />
                <Button key="pull-rebase" label="Pull (rebase)" onPress={() => void ask($, ['pull-rebase', cwd].join(SEP), 'Pull và rebase commit của bạn lên trên?', '')} />
                <Button key="force-push" label="Force push (with lease)" onPress={() => void ask($, ['force-push', cwd].join(SEP), `Force push ${wt?.branch}?`, 'Ghi đè branch trên remote; dùng --force-with-lease nên sẽ dừng nếu có người vừa push.')} />
              </Box>
            ))}
            {section('Dọn dẹp', (
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                {wt?.upstream && <Button key="reset-upstream" label={`Reset hard về ${wt.upstream}`} onPress={() => void ask($, ['reset', cwd, wt.upstream ?? '', 'hard'].join(SEP), `Reset --hard về ${wt.upstream}?`, 'MẤT mọi thay đổi và commit chưa push. Không hoàn tác được.')} />}
                <Button key="clean" label="Xoá file chưa theo dõi" onPress={() => void askClean($, cwd)} />
              </Box>
            ))}
            {section(`Worktree (${repo.worktrees.length})`, (
              <Box flexDirection="column">
                {repo.worktrees.map(w => (
                  <Box flexDirection="row" gap={1} alignItems="center">
                    {dot(w)}
                    <Button key={`wsel:${w.path}`} label={`${w.label} — ${w.branch}`} plain onPress={() => void selectWorktree($, w.path)} />
                    {w.path !== repo.path && <Button key={`wrm:${w.path}`} label="Xoá worktree" plain onPress={() => void ask($, ['worktree-remove', repo.path, w.path].join(SEP), `Xoá worktree ${w.label}?`, isClean(w) ? 'Branch vẫn còn, chỉ xoá thư mục.' : 'Worktree còn thay đổi chưa commit: git sẽ từ chối.')} />}
                  </Box>
                ))}
                <Button key="wt-prune" label="Dọn worktree đã mất thư mục" plain onPress={() => void pruneWorktrees($, repo.path)} />
                {others.length === 0 && <Text dimColor>Tạo worktree mới ở tab Branch → "Mở worktree".</Text>}
              </Box>
            ))}
            {section('Submodule', (
              <Box flexDirection="column">
                {p.submodules ? <Code source={p.submodules} language="text" /> : <Text dimColor>Repo không có submodule.</Text>}
                {p.submodules && <Button key="sub-update" label="Cập nhật submodule" plain onPress={() => void submoduleUpdate($, cwd)} />}
              </Box>
            ))}
          </Box>
        )
      } else if (sel.tab === 'settings') {
        const pubAccounts = accts.filter(a => a.method !== 'ssh')
        const pubAccount = pubAccounts.find(a => a.id === d[`pub:account:${repo.path}`]) ?? pubAccounts[0]
        const pubOwners = pubAccount ? ownerLists[pubAccount.id] ?? [] : []
        const hasOrigin = Boolean(s?.remotes.some(r => r.name === 'origin'))
        const publishBox = s && !hasOrigin && (
          <Box flexDirection="column" gap={1} borderStyle="round" borderColor="suggestion" paddingX={1}>
            <Text bold>Publish lên remote</Text>
            <Text dimColor>Repo chưa có remote origin: tạo repo mới trên GitHub / Bitbucket / GitLab bằng tài khoản đã đăng nhập, gắn làm origin rồi push branch hiện tại.</Text>
            {pubAccounts.length === 0 && (
              <Box flexDirection="row" gap={1} alignItems="center">
                <Text color="warning">Cần một tài khoản OAuth hoặc token.</Text>
                <Button key="pub-goto-accounts" label="Mở tab Tài khoản" plain onPress={() => void showView($, 'accounts')} />
              </Box>
            )}
            {pubAccount && Select && Input && (
              <Box flexDirection="column" gap={1}>
                <Select
                  key="pub-account"
                  label="Tài khoản"
                  value={pubAccount.id}
                  options={pubAccounts.map(a => ({ value: a.id, label: `${providerLabel(a.provider)} · ${a.username}@${a.host}` }))}
                  onSelect={v => void choosePublishAccount($, repo.path, v)}
                />
                <Box flexDirection="row" gap={1} alignItems="center">
                  <Select
                    key="pub-owner"
                    label={pubAccount.provider === 'bitbucket' ? 'Workspace' : pubAccount.provider === 'github' ? 'Owner (bạn hoặc organization)' : 'Namespace (bạn hoặc group)'}
                    value={d[`pub:owner:${repo.path}`] || (pubAccount.provider === 'bitbucket' ? pubAccount.scopes[0] ?? '' : pubAccount.username)}
                    options={(pubOwners.length ? pubOwners : [pubAccount.provider === 'bitbucket' ? pubAccount.scopes[0] ?? '' : pubAccount.username].filter(Boolean)).map(o => ({ value: o, label: o }))}
                    onSelect={v => void setDraft($, `pub:owner:${repo.path}`, v)}
                  />
                  <Button key="pub-owners-load" label="Tải danh sách" plain onPress={() => void loadOwners($, pubAccount.id)} />
                </Box>
                {draftInput(`pub:name:${repo.path}`, 'Tên repo', repo.name)}
                {draftInput(`pub:desc:${repo.path}`, 'Mô tả (tuỳ chọn)', '')}
                <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
                  {flagButton(`pub:public:${repo.path}`, 'Public (bỏ chọn = private)')}
                  <Button key="pub-go" variant="primary" label="Publish" onPress={() => void askPublish($, repo.path)} />
                </Box>
              </Box>
            )}
          </Box>
        )
        body = !s ? <Text dimColor>Đang đọc cài đặt…</Text> : (
          <Box flexDirection="column" gap={1}>
            {publishBox}
            {section('Remote', (
              <Box flexDirection="column">
                {s.remotes.map(rm => (
                  <Box flexDirection="column">
                    <Box flexDirection="row" gap={1} alignItems="center">
                      <Text bold>{rm.name}</Text>
                      <Text wrap="truncate-middle">{rm.fetchUrl}</Text>
                      {rm.pushUrl !== rm.fetchUrl && <Text dimColor>push: {rm.pushUrl}</Text>}
                      <Button key={`rmrm:${rm.name}`} label="Xoá" plain onPress={() => void ask($, ['remote-remove', repo.path, rm.name].join(SEP), `Xoá remote ${rm.name}?`, rm.fetchUrl)} />
                    </Box>
                    {Input && (
                      <Input key={`remote:${rm.name}`} label={`URL mới cho ${rm.name}`} value={rm.fetchUrl} submitLabel="Lưu" onSubmit={v => void setRemoteUrl($, repo.path, rm.name, v)} />
                    )}
                  </Box>
                ))}
                {Input && (
                  <Box flexDirection="column">
                    {draftInput(`remotename:${repo.path}`, 'Thêm remote: tên', 'upstream')}
                    {draftInput(`remoteurl:${repo.path}`, 'URL', 'git@bitbucket.org:workspace/repo.git')}
                    <Button key="remote-add" label="Thêm remote" onPress={() => void addRemote($, repo.path)} />
                  </Box>
                )}
              </Box>
            ))}
            {section('Commit dưới tên', (
              <Box flexDirection="column">
                <Text>{s.name || '(chưa đặt)'} &lt;{s.email || '?'}&gt; <Text dimColor>{s.localName || s.localEmail ? '(riêng repo này)' : '(global)'}</Text></Text>
                {Input && (
                  <Box flexDirection="column">
                    <Input key="ident-name" label="user.name riêng cho repo (trống = dùng global)" value={s.localName} placeholder={s.name} submitLabel="Lưu" onSubmit={v => void setIdentity($, repo.path, 'user.name', v)} />
                    <Input key="ident-email" label="user.email riêng cho repo (trống = dùng global)" value={s.localEmail} placeholder={s.email} submitLabel="Lưu" onSubmit={v => void setIdentity($, repo.path, 'user.email', v)} />
                  </Box>
                )}
              </Box>
            ))}
            {extraRepos.includes(repo.path) && (
              <Button key="unwatch" label="Bỏ theo dõi repo này" onPress={() => void ask($, ['unwatch', repo.path].join(SEP), `Bỏ theo dõi ${repo.name}?`, 'Chỉ bỏ khỏi danh sách, không xoá thư mục.')} />
            )}
          </Box>
        )
      }

      return (
        <Box flexDirection="column" gap={1}>
          {topTabs}
          {header}
          {notices}
          {tabs}
          {diffBox}
          {p?.isLoading && !p.log.length && <Text dimColor>Đang đọc…</Text>}
          {body as never}
        </Box>
      )
    }

    // ── repo list ──
    const behindCount = list.flatMap(r => r.worktrees).filter(w => w.upstream && w.behind > 0).length
    return (
      <Box flexDirection="column" gap={1}>
        {topTabs}
        <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          <Text dimColor>
            {info.isRunning ? 'Đang fetch…' : `Fetch: ${ago(info.at, now)}`}
            {info.failed > 0 ? ` · lỗi ${info.failed}` : ''}
          </Text>
          <Button key="fetch" hotkey="f" onPress={() => void fetchAll($)}>Fetch tất cả</Button>
          <Button key="refresh" hotkey="r" onPress={() => void refresh($)}>Làm mới</Button>
          {behindCount > 0 && <Button key="pull-all" hotkey="p" label={`Pull tất cả (${behindCount})`} onPress={() => void pullAll($)} />}
        </Box>
        {notices}
        {allPaths().length === 0 && (
          <Text>Chưa theo dõi repo nào. Thêm đường dẫn repo hoặc quét một thư mục bên dưới.</Text>
        )}
        {allPaths().length > 0 && list.length === 0 && <Text dimColor>Đang đọc trạng thái…</Text>}
        <Box flexDirection="column">
          {list.map(r => {
            const worst = r.error || r.worktrees.some(w => w.error || w.conflicted) ? 'error' : r.worktrees.every(isClean) ? 'success' : 'warning'
            const main = r.worktrees[0]
            const dirty = r.worktrees.filter(w => !isClean(w)).length
            const behind = r.worktrees.filter(w => w.behind > 0).length
            const ahead = r.worktrees.filter(w => w.ahead > 0).length
            return (
              <Box flexDirection="column">
                <Box flexDirection="row" gap={1} alignItems="center">
                  <Text color={worst}>●</Text>
                  <Button key={`repo:${r.path}`} label={r.name} plain onPress={() => void openRepo($, r.path)} />
                  <Text color="suggestion" wrap="truncate-end">{main?.branch ?? '?'}</Text>
                  {main && <Text color={main.behind ? 'warning' : main.ahead ? 'suggestion' : 'inactive'}>{sync(main)}</Text>}
                  {r.worktrees.length > 1 && <Text dimColor>{r.worktrees.length} worktree</Text>}
                  {dirty > 0 && <Text color="warning">◐{dirty}</Text>}
                  {behind > 0 && <Text color="warning">↓{behind}</Text>}
                  {ahead > 0 && <Text color="suggestion">↑{ahead}</Text>}
                </Box>
                {r.fetchError && <Text color="error" wrap="truncate-end">  fetch: {r.fetchError}</Text>}
                {r.error && <Text color="error">  {r.error}</Text>}
              </Box>
            )
          })}
        </Box>
        {list.length > 0 && <Text dimColor>Bấm tên repo để mở: thay đổi, branch, lịch sử, git-flow, stash, tag, pull request, nâng cao, cài đặt.</Text>}
        {Input && (
          <Box flexDirection="column" gap={1} borderStyle="round" paddingX={1}>
            <Text bold>Thêm repo</Text>
            <Box flexDirection="row" gap={1} alignItems="center">
              {draftInput('addrepo', 'Đường dẫn repo', `${cfg.home || '~'}/my-project`, () => void addRepo($))}
              <Button key="add-repo" label="Theo dõi" onPress={() => void addRepo($)} />
            </Box>
            <Box flexDirection="row" gap={1} alignItems="center">
              {draftInput('scanroot', 'Quét thư mục tìm repo', cfg.home, () => void scanRepos($))}
              <Button key="scan" label={scanned.isLoading ? 'Đang quét…' : 'Quét'} onPress={() => void scanRepos($)} />
            </Box>
            {!scanned.isLoading && scanned.found.length > 0 && (() => {
              const fresh = scanned.found.filter(p => !allPaths().includes(p))
              return (
                <Box flexDirection="column">
                  <Box flexDirection="row" gap={1} alignItems="center">
                    <Text dimColor>Tìm thấy {scanned.found.length} repo trong {scanned.root}, {fresh.length} chưa theo dõi</Text>
                    {fresh.length > 0 && <Button key="watch-all" variant="primary" label={`Theo dõi cả ${fresh.length}`} onPress={() => void watchAll($, fresh)} />}
                  </Box>
                  {fresh.slice(0, MAX_LIST).map(path => (
                    <Box flexDirection="row" gap={1} alignItems="center">
                      <Text wrap="truncate-middle">{path.startsWith(`${scanned.root}/`) ? path.slice(scanned.root.length + 1) : path}</Text>
                      <Button key={`watch-found:${path}`} label="Theo dõi" plain onPress={() => void watch($, path)} />
                    </Box>
                  ))}
                </Box>
              )
            })()}
          </Box>
        )}
      </Box>
    )
  })
}
