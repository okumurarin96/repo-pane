import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { Account, Panel, RemoteList, RepoSettings, RepoStatus, RepoTab, Selection } from '../types'

const REPO: RepoStatus = {
  name: 'my-app',
  path: '/r',
  remote: 'bitbucket.org/acme/my-app',
  fetchError: null,
  error: null,
  worktrees: [
    {
      path: '/r', label: 'main', branch: 'master', isDetached: false, upstream: 'origin/master',
      ahead: 1, behind: 2, staged: 1, modified: 1, untracked: 1, conflicted: 1, error: null,
      files: [
        { code: 'M ', path: 'lib/staged.dart', isStaged: true, isUnstaged: false, isUntracked: false, isConflicted: false },
        { code: ' M', path: 'lib/a.dart', isStaged: false, isUnstaged: true, isUntracked: false, isConflicted: false },
        { code: '??', path: 'new.txt', isStaged: false, isUnstaged: false, isUntracked: true, isConflicted: false },
        { code: 'UU', path: 'lib/c.dart', isStaged: false, isUnstaged: false, isUntracked: false, isConflicted: true },
      ],
    },
    {
      path: '/r/.worktrees/x', label: '.worktrees/x', branch: 'feature/x', isDetached: false, upstream: null,
      ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0, files: [], error: null,
    },
  ],
}

const PANEL: Panel = {
  worktree: '/r',
  branches: [
    { name: 'master', upstream: 'origin/master', track: '[ahead 1, behind 2]', when: '1h', subject: 's', isHead: true },
    { name: 'feature/y', upstream: '', track: '', when: '2d', subject: 't', isHead: false },
  ],
  remoteBranches: [{ name: 'origin/release', when: '3h', subject: 'r' }],
  log: [{ hash: 'abcdef0123', short: 'abcdef0', author: 'A', when: '1h', refs: 'HEAD -> master', subject: 'fix login' }],
  graph: [
    { hash: 'abcdef0123', parents: ['p1', 'p2'], short: 'abcdef0', author: 'A', when: '1h', refs: 'HEAD -> master, origin/master, tag: v1.0', subject: 'Merge feature/y' },
    { hash: 'p2', parents: ['p1'], short: 'p2', author: 'B', when: '2h', refs: 'feature/y', subject: 'feature work' },
    { hash: 'p1', parents: [], short: 'p1', author: 'A', when: '3h', refs: '', subject: 'init' },
  ],
  graphText: '*   abcdef0 Merge feature/y',
  remoteNames: ['origin'],
  stashes: [{ ref: 'stash@{0}', when: '5m', message: 'On master: wip' }],
  tags: [{ name: 'v1.0', when: '3d', subject: 'Release' }],
  submodules: '',
  opState: 'merge',
  flow: {
    master: 'master', develop: 'develop', feature: 'feature/', bugfix: 'bugfix/', release: 'release/', hotfix: 'hotfix/', support: 'support/', versiontag: 'v',
  },
  prs: [{ id: '7', title: 'Add login', author: 'A', source: 'master', target: 'release', url: 'https://bitbucket.org/x/7', updated: '2026-10-01', state: 'OPEN' }],
  prError: null,
  isLoading: false,
}

const SETTINGS: Record<string, RepoSettings> = {
  '/r': {
    remotes: [{ name: 'origin', fetchUrl: 'https://alice@bitbucket.org/acme/my-app.git', pushUrl: 'https://alice@bitbucket.org/acme/my-app.git' }],
    localName: '', localEmail: '', name: 'Alice', email: 'alice@example.com',
  },
}

const ACCOUNT: Account = {
  id: 'bitbucket:bitbucket.org:alice', provider: 'bitbucket', host: 'bitbucket.org', method: 'oauth', protocol: 'https', sshKey: '',
  username: 'alice', gitUser: 'x-token-auth', expiresAt: 9e12, email: '', scopes: ['acme'], verifiedAt: 1, error: null,
}

const FORM = { provider: 'bitbucket', host: 'bitbucket.org', method: 'oauth', protocol: 'https', sshKey: '', username: '', email: '', scopes: '' } as const

const remoteRepo = (slug: string) => ({
  key: `bitbucket.org/acme/${slug}`, provider: 'bitbucket' as const, host: 'bitbucket.org', fullName: `acme/${slug}`, slug,
  project: 'Acme', description: '', mainBranch: 'master', updatedOn: '2026-10-01T00:00:00Z', isPrivate: true,
  sshUrl: `git@bitbucket.org:acme/${slug}.git`, httpsUrl: `https://bitbucket.org/acme/${slug}.git`,
})

const REMOTE: RemoteList = {
  isLoading: false, at: 1, errors: [], onDisk: ['old-tool'],
  repos: [remoteRepo('my-app'), remoteRepo('old-tool'), remoteRepo('new-service')],
}

const PANE = {
  plugin: 'repo-pane',
  component: 'Pane',
  requestId: 'repo-pane',
  props: { title: 'Git', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const SURFACES = ['terminal', 'desktop'] as const

function seed(on: Parameters<TestBody>[1], state: Record<string, unknown>) {
  on('state.get', async (_$, e, next) => {
    if (e.plugin !== 'repo-pane' || !(e.key in state)) return next(e)
    return { value: { value: state[e.key], version: 1 } }
  })
}

test('repo list and the band', async ($, on) => {
  seed(on, { repos: [REPO], view: 'repos' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'repo:/r' })).toBeDefined()
    expect(await ui.find({ key: 'pull-all' })).toBeDefined()
    expect(await ui.find({ key: 'tab-accounts' })).toBeDefined()
    await ui.unmount()
    const band = await $.ui.mount({
      plugin: 'repo-pane', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect(await band.find({ type: 'Text', text: /1 cần pull/ })).toBeDefined()
    await band.unmount()
  }
})

test('every repo tab draws, with its main controls', async ($, on) => {
  const state: Record<string, unknown> = {
    repos: [REPO], view: 'repo', panel: PANEL, settings: SETTINGS, accounts: [ACCOUNT],
    selected: { repo: '/r', worktree: '/r', tab: 'changes' } as Selection,
    drafts: { 'open:/r': 'abcdef0123' }, flags: { graph: true },
    confirm: { key: 'x', label: 'Xoá?', detail: 'chi tiết' },
    result: { label: 'Pull', ok: false, text: 'fatal: x', at: 1 },
    diff: { title: 'lib/a.dart', source: '@@ -1 +1 @@\n-a\n+b', format: 'diff' },
  }
  seed(on, state)
  const expectKeys: Record<RepoTab, string[]> = {
    changes: ['stage:unstaged:lib/a.dart', 'unstage:lib/staged.dart', 'ours:lib/c.dart', 'in:commit:/r', 'commit', 'confirm-yes', 'result-close', 'diff-close', 'worktree'],
    branches: ['create-branch', 'co:feature/y', 'del:feature/y', 'cor:origin/release', 'wt:feature/y'],
    history: ['show:abcdef0123', 'cp:abcdef0123', 'rh:abcdef0123', 'flag:graph', 'flag:graphCurrent'],
    flow: ['flow-start:feature', 'flow-start:hotfix', 'flag:flowPush', 'flow-fin:feature/y', 'flow-co:feature/y', 'in:flowtag'],
    stash: ['stash-save', 'sp:stash@{0}', 'sd:stash@{0}'],
    tags: ['tag-create', 'tpush:v1.0', 'tdel:v1.0'],
    prs: ['pr-create', 'pr-reload'],
    advanced: ['op-continue', 'op-abort', 'force-push', 'clean', 'wrm:/r/.worktrees/x'],
    settings: ['in:remotename:/r', 'remote-add', 'rmrm:origin', 'ident-email'],
  }
  for (const surface of SURFACES) {
    for (const tab of Object.keys(expectKeys) as RepoTab[]) {
      state.selected = { repo: '/r', worktree: '/r', tab }
      const ui = await $.ui.mount({ ...PANE, surface })
      for (const key of expectKeys[tab]) {
        expect({ surface, tab, key, found: Boolean(await ui.find({ key })) }).toEqual({ surface, tab, key, found: true })
      }
      await ui.unmount()
    }
  }
})

test('remote repos: open, watch or clone; and the accounts tab', async ($, on) => {
  const state: Record<string, unknown> = { repos: [REPO], view: 'remote', remote: REMOTE, accounts: [ACCOUNT], drafts: {} }
  seed(on, state)
  for (const surface of SURFACES) {
    state.view = 'remote'
    state.drafts = {}
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'open:bitbucket.org/acme/my-app' })).toBeDefined()
    expect(await ui.find({ key: 'watch:bitbucket.org/acme/old-tool' })).toBeDefined()
    expect(await ui.find({ key: 'clone:bitbucket.org/acme/new-service' })).toBeDefined()
    await ui.unmount()

    state.drafts = { remoteq: 'new' }
    const filtered = await $.ui.mount({ ...PANE, surface })
    expect(await filtered.find({ key: 'watch:bitbucket.org/acme/old-tool' })).toBeUndefined()
    await filtered.unmount()

    state.view = 'accounts'
    state.accountForm = FORM
    const acct = await $.ui.mount({ ...PANE, surface })
    expect(await acct.find({ key: 'logout:bitbucket:bitbucket.org:alice' })).toBeDefined()
    expect(await acct.find({ key: 'proto:bitbucket:bitbucket.org:alice' })).toBeDefined()
    expect(await acct.find({ key: 'acct-method' })).toBeDefined()
    expect(await acct.find({ key: 'acct-protocol' })).toBeDefined()
    // OAuth chosen with no app yet: the setup is offered, not a dead button
    expect(await acct.find({ key: 'oauth-setup:bitbucket' })).toBeDefined()
    expect(await acct.find({ key: 'oauth:bitbucket' })).toBeUndefined()
    expect(await acct.find({ key: 'acct-login' })).toBeUndefined()
    await acct.unmount()

    state.oauthApps = [{ provider: 'bitbucket', host: 'bitbucket.org', clientId: 'KEY123456', hasSecret: true, source: 'pane' }]
    state.flags = { 'oauthSetup:github': true }
    state.oauth = { provider: 'github', host: 'github.com', stage: 'device', userCode: 'ABCD-1234', verifyUrl: 'https://github.com/login/device', message: 'm' }
    const acct2 = await $.ui.mount({ ...PANE, surface })
    expect(await acct2.find({ key: 'oauth:bitbucket' })).toBeDefined()
    expect(await acct2.find({ key: 'oauth-rm:bitbucket:bitbucket.org' })).toBeDefined()
    expect(await acct2.find({ key: 'oauth-save:github' })).toBeDefined()
    expect(await acct2.find({ type: 'Text', text: /ABCD-1234/ })).toBeDefined()
    await acct2.unmount()
    state.oauthApps = []
    state.flags = {}
    state.oauth = null

    state.accountForm = { ...FORM, method: 'token' }
    const token = await $.ui.mount({ ...PANE, surface })
    expect(await token.find({ key: 'acct-login' })).toBeDefined()
    expect(await token.find({ key: 'acct-email' })).toBeDefined()
    expect(await token.find({ key: 'acct-sshkey' })).toBeUndefined()
    await token.unmount()

    // token over SSH: the key section joins the token form
    state.accountForm = { ...FORM, method: 'token', protocol: 'ssh' }
    const tokenSsh = await $.ui.mount({ ...PANE, surface })
    expect(await tokenSsh.find({ key: 'acct-login' })).toBeDefined()
    expect(await tokenSsh.find({ key: 'acct-sshkey' })).toBeDefined()
    await tokenSsh.unmount()

    state.accountForm = { ...FORM, method: 'ssh', protocol: 'ssh', sshKey: '/h/.ssh/k' }
    state.ssh = { keys: [{ path: '/h/.ssh/k', fingerprint: 'SHA256:x', comment: 'me (ED25519)' }], test: { host: 'bitbucket.org', key: '/h/.ssh/k', ok: true, text: 'authenticated via ssh key.' }, isTesting: false }
    const sshUi = await $.ui.mount({ ...PANE, surface })
    expect(await sshUi.find({ key: 'acct-ssh-add' })).toBeDefined()
    expect(await sshUi.find({ key: 'ssh-copy' })).toBeDefined()
    expect(await sshUi.find({ key: 'ssh-generate' })).toBeDefined()
    expect(await sshUi.find({ type: 'Text', text: /Key vào được/ })).toBeDefined()
    expect(await sshUi.find({ key: 'acct-login' })).toBeUndefined()
    await sshUi.unmount()
    state.accountForm = FORM
    state.ssh = { keys: [], test: null, isTesting: false }
  }
})

test('history draws the graph as SVG on desktop and as text on the terminal', async ($, on) => {
  seed(on, {
    repos: [REPO], view: 'repo', panel: PANEL, settings: SETTINGS, flags: { graph: true },
    selected: { repo: '/r', worktree: '/r', tab: 'history' } as Selection,
  })
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desktop.find({ type: 'Svg' })).toBeDefined()
  await desktop.unmount()
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  expect(await terminal.find({ type: 'Code' })).toBeDefined()
  await terminal.unmount()
})

test('git-flow tab offers setup in a repo without it, and an empty repo list offers to add and scan', async ($, on) => {
  const state: Record<string, unknown> = {
    repos: [REPO], view: 'repo', panel: { ...PANEL, flow: null }, settings: SETTINGS,
    selected: { repo: '/r', worktree: '/r', tab: 'flow' } as Selection,
  }
  seed(on, state)
  for (const surface of SURFACES) {
    state.view = 'repo'
    const flowUi = await $.ui.mount({ ...PANE, surface })
    expect(await flowUi.find({ key: 'flow-init' })).toBeDefined()
    expect(await flowUi.find({ key: 'in:flow:develop' })).toBeDefined()
    await flowUi.unmount()

    state.view = 'repos'
    state.scan = { isLoading: false, root: '/home/me', found: ['/home/me/a', '/home/me/b'] }
    const list = await $.ui.mount({ ...PANE, surface })
    expect(await list.find({ key: 'add-repo' })).toBeDefined()
    expect(await list.find({ key: 'watch-all' })).toBeDefined()
    expect(await list.find({ key: 'watch-found:/home/me/a' })).toBeDefined()
    await list.unmount()
  }
})

test('a repo without origin offers Publish, with the signed-in accounts', async ($, on) => {
  const noRemote: RepoStatus = { ...REPO, remote: null }
  const state: Record<string, unknown> = {
    repos: [noRemote], view: 'repo', panel: PANEL, accounts: [ACCOUNT], owners: { [ACCOUNT.id]: ['acme', 'other'] },
    settings: { '/r': { remotes: [], localName: '', localEmail: '', name: 'Alice', email: 'alice@example.com' } },
    selected: { repo: '/r', worktree: '/r', tab: 'settings' } as Selection,
  }
  seed(on, state)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'pub-account' })).toBeDefined()
    expect(await ui.find({ key: 'pub-owner' })).toBeDefined()
    expect(await ui.find({ key: 'in:pub:name:/r' })).toBeDefined()
    expect(await ui.find({ key: 'flag:pub:public:/r' })).toBeDefined()
    expect(await ui.find({ key: 'pub-go' })).toBeDefined()
    expect(await ui.find({ key: 'pub-shortcut' })).toBeDefined()
    await ui.unmount()
  }
  // with an origin, no Publish
  state.settings = SETTINGS
  state.repos = [REPO]
  const withOrigin = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await withOrigin.find({ key: 'pub-go' })).toBeUndefined()
  await withOrigin.unmount()
})

test('Claude can call the plugin tools: accounts lists no secrets, a bad path is refused', async ($, on) => {
  seed(on, { accounts: [ACCOUNT] })
  const accounts = await $.tool.call({ tool: 'mcp__repo-pane__accounts' })
  expect(accounts.text).toContain('bitbucket alice@bitbucket.org (oauth, git over https)')
  expect(JSON.stringify(accounts.result)).not.toContain('gitUser')
  const bad = await $.tool.call({ tool: 'mcp__repo-pane__push', path: 'relative/path' })
  expect(bad.isError).toBe(true)
  expect(bad.text).toContain('absolute path')
})
