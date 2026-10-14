import { expect, test } from 'claude-code/testing'

import {
  cloneFolder, credentialRewriteArgs, diffHunks, parseKeyFingerprint, remoteHosts, sshArgv, sshCommand, sshGreeting, isAuthError, isClean, isValidRemoteUrl, parseBranches, parseLog, parseRemoteBranches,
  parseRemotes, parseRemoteUrl, parseStashes, parseStatus, parseTags, parseWorktreeList, remoteKey, sshRewriteArgs,
  worktreeFolder, worktreeLabel,
} from './git'

const U = '\x1f'

test('parses worktree list with bare entries', async () => {
  const out = ['worktree /r', 'branch refs/heads/release', '', 'worktree /r/.worktrees/x', 'detached', '', 'worktree /bare', 'bare', ''].join('\n')
  const list = parseWorktreeList(out)
  expect(list.map(w => w.path)).toEqual(['/r', '/r/.worktrees/x', '/bare'])
  expect(list.map(w => w.isBare)).toEqual([false, false, true])
  expect(worktreeLabel('/r', '/r/.worktrees/x')).toBe('.worktrees/x')
  expect(worktreeLabel('/r', '/r')).toBe('main')
})

test('status: counts, ahead/behind and changed files grouped by kind', async () => {
  const out = [
    '# branch.oid 0123456789abcdef',
    '# branch.head feature/x',
    '# branch.upstream origin/feature/x',
    '# branch.ab +2 -3',
    '1 M. N... 100644 100644 100644 a b src/staged.ts',
    '1 .M N... 100644 100644 100644 a b src/my file.ts',
    '1 MM N... 100644 100644 100644 a b src/both.ts',
    '2 R. N... 100644 100644 100644 a b R100 src/new.ts\tsrc/old.ts',
    'u UU N... 100644 100644 100644 100644 a b c src/conflict.ts',
    '? new.txt',
  ].join('\n')
  const s = parseStatus(out, '/r', 'main')
  expect([s.branch, s.upstream, s.ahead, s.behind]).toEqual(['feature/x', 'origin/feature/x', 2, 3])
  expect([s.staged, s.modified, s.untracked, s.conflicted]).toEqual([3, 2, 1, 1])
  const by = (p: string) => s.files.find(f => f.path === p)
  expect(by('src/staged.ts')).toMatchObject({ isStaged: true, isUnstaged: false })
  expect(by('src/my file.ts')).toMatchObject({ isStaged: false, isUnstaged: true })
  expect(by('src/both.ts')).toMatchObject({ isStaged: true, isUnstaged: true })
  expect(by('src/new.ts')).toMatchObject({ code: 'R ', isStaged: true })
  expect(by('src/conflict.ts')).toMatchObject({ isConflicted: true, isStaged: false, isUnstaged: false })
  expect(by('new.txt')).toMatchObject({ isUntracked: true, isStaged: false })
  expect(isClean(s)).toBe(false)
})

test('detached head shows its short commit', async () => {
  const s = parseStatus('# branch.oid 0c0e83c617aa\n# branch.head (detached)\n', '/r/w', 'w')
  expect(s.branch).toBe('detached @0c0e83c6')
  expect(isClean(s)).toBe(true)
})

test('log, branches, remote branches, stashes and tags', async () => {
  expect(parseLog(`abcdef01${U}abc${U}Anh${U}2 hours ago${U}HEAD -> main, origin/main${U}fix: a${U}b\n`)).toEqual([
    { hash: 'abcdef01', short: 'abc', author: 'Anh', when: '2 hours ago', refs: 'HEAD -> main, origin/main', subject: `fix: a${U}b` },
  ])
  expect(parseBranches(`main${U}origin/main${U}[ahead 1]${U}1 day ago${U}msg${U}*\nold${U}${U}${U}2 days ago${U}x${U} \n`)).toEqual([
    { name: 'main', upstream: 'origin/main', track: '[ahead 1]', when: '1 day ago', subject: 'msg', isHead: true },
    { name: 'old', upstream: '', track: '', when: '2 days ago', subject: 'x', isHead: false },
  ])
  const remotes = parseRemoteBranches(
    [`origin/HEAD${U}1h${U}s${U}refs/remotes/origin/main`, `origin${U}1h${U}s${U}`, `origin/main${U}1h${U}s${U}`, `origin/feature/a${U}2h${U}t${U}`].join('\n'),
  )
  expect(remotes.map(r => r.name)).toEqual(['origin/main', 'origin/feature/a'])
  expect(parseStashes(`stash@{0}${U}5 minutes ago${U}On main: wip\n`)).toEqual([{ ref: 'stash@{0}', when: '5 minutes ago', message: 'On main: wip' }])
  expect(parseTags(`v1.0${U}3 days ago${U}Release 1.0\n`)).toEqual([{ name: 'v1.0', when: '3 days ago', subject: 'Release 1.0' }])
})

test('remote URLs: parse, key, SSH rewrite and validation', async () => {
  expect(parseRemoteUrl('https://alice@bitbucket.org/acme/web-app-router.git')).toEqual({ host: 'bitbucket.org', path: 'acme/web-app-router' })
  expect(parseRemoteUrl('git@gitlab.example.com:group/sub/repo.git')).toEqual({ host: 'gitlab.example.com', path: 'group/sub/repo' })
  expect(parseRemoteUrl('ssh://git@github.com:22/a/b')).toEqual({ host: 'github.com', path: 'a/b' })
  expect(remoteKey('git@bitbucket.org:acme/My-App.git\n')).toBe('bitbucket.org/acme/my-app')
  const remoteV = [
    'origin\thttps://alice@bitbucket.org/acme/web-app-router.git (fetch)',
    'origin\thttps://alice@bitbucket.org/acme/web-app-router.git (push)',
    'gh\thttps://github.com/a/b.git (fetch)',
    'ssh\tgit@github.com:a/b.git (fetch)',
  ].join('\n')
  expect(sshRewriteArgs(remoteV)).toEqual([
    '-c', 'url.git@bitbucket.org:.insteadOf=https://alice@bitbucket.org/',
    '-c', 'url.git@github.com:.insteadOf=https://github.com/',
  ])
  expect(parseRemotes(remoteV).map(r => r.name)).toEqual(['origin', 'gh', 'ssh'])
  expect(isValidRemoteUrl('git@bitbucket.org:acme/a.git')).toBe(true)
  expect(isValidRemoteUrl('--upload-pack=x')).toBe(false)
  expect(cloneFolder('web-app-router')).toBe('web-app-router')
  expect(cloneFolder('..')).toBe(null)
  expect(worktreeFolder('feature/SPT-1 x')).toBe('feature-SPT-1-x')
  expect(isAuthError("fatal: could not read Password for 'https://a@bitbucket.org': terminal prompts disabled")).toBe(true)
})

test('credential rewrite sends a signed-in account\'s git user, leaving the remote as it is', async () => {
  const remoteV = [
    'origin\thttps://alice@bitbucket.org/acme/r.git (fetch)',
    'gl\thttps://gitlab.example.com/team/app.git (fetch)',
    'gh\thttps://octo@github.com/o/r.git (fetch)',
  ].join('\n')
  const net = { protocol: 'https' as const, sshKey: '' }
  const accounts = [
    { ...net, host: 'bitbucket.org', gitUser: 'x-token-auth', method: 'oauth' as const },
    { ...net, host: 'gitlab.example.com', gitUser: 'oauth2', method: 'oauth' as const },
    { ...net, host: 'github.com', gitUser: 'octo', method: 'token' as const },
  ]
  expect(credentialRewriteArgs(remoteV, accounts)).toEqual([
    '-c', 'url.https://x-token-auth@bitbucket.org/.insteadOf=https://alice@bitbucket.org/',
    '-c', 'url.https://oauth2@gitlab.example.com/.insteadOf=https://gitlab.example.com/',
  ])
  // a token account whose name the remote already carries, or a remote with no name: git finds it as is
  expect(credentialRewriteArgs('o\thttps://bitbucket.org/a/b.git (fetch)', [{ ...net, host: 'bitbucket.org', gitUser: 'alice', method: 'token' }])).toEqual([])
  // an account set to SSH sends the host's https remotes over SSH
  expect(credentialRewriteArgs(remoteV, [{ host: 'bitbucket.org', gitUser: 'git', method: 'ssh', protocol: 'ssh', sshKey: '/k' }]))
    .toEqual(['-c', 'url.git@bitbucket.org:.insteadOf=https://alice@bitbucket.org/'])
  expect(remoteHosts(remoteV)).toEqual(['bitbucket.org', 'gitlab.example.com', 'github.com'])
})

test('SSH: command, greeting and key fingerprints', async () => {
  expect(sshCommand('')).toBe('ssh -o BatchMode=yes -o ConnectTimeout=15')
  expect(sshCommand("/Users/a b/.ssh/it's")).toBe(`ssh -o BatchMode=yes -o ConnectTimeout=15 -i '/Users/a b/.ssh/it'\\''s' -o IdentitiesOnly=yes`)
  expect(sshArgv('/k', true)).toEqual(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new', '-i', '/k', '-o', 'IdentitiesOnly=yes'])
  expect(sshGreeting('authenticated via ssh key.\n\nYou can use git to connect to Bitbucket. Shell access is disabled')).toEqual({ ok: true, username: '' })
  expect(sshGreeting("Hi octo! You've successfully authenticated, but GitHub does not provide shell access.")).toEqual({ ok: true, username: 'octo' })
  expect(sshGreeting('Welcome to GitLab, @me!')).toEqual({ ok: true, username: 'me' })
  expect(sshGreeting('git@bitbucket.org: Permission denied (publickey).')).toEqual({ ok: false, username: '' })
  expect(parseKeyFingerprint('256 SHA256:4SMi alice@bitbucket (ED25519)')).toEqual({ fingerprint: 'SHA256:4SMi', comment: 'alice@bitbucket (ED25519)' })
})

test('diff output keeps only the hunks', async () => {
  const out = ['diff --git a/x b/x', 'index 1..2 100644', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b', ''].join('\n')
  expect(diffHunks(out)).toBe('@@ -1 +1 @@\n-a\n+b')
  expect(diffHunks('Binary files differ')).toBe('')
})
