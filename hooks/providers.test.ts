import { expect, test } from 'claude-code/testing'

import type { Account } from '../types'
import {
  OAUTH_REDIRECT, authHeaders, authorizeUrl, createRepoRequest, ownersUrl, parseCreatedRepo, parseOwners, repoSlug, deviceCodeRequest, deviceTokenRequest, httpsWithUser, linkNext, loginOf,
  oauthAppPage, oauthGitUser, parseDeviceCode, parseWorkspacePage, parsePrs, parseRepoPage, parseTokenResponse, pkceChallenge, prCreateRequest, prListUrl,
  providerForHost, repoApiUrl, repoListUrls, tokenRequest, verifyUrl,
} from './providers'

const base = { method: 'token' as const, protocol: 'https' as const, sshKey: '', gitUser: '', expiresAt: null, verifiedAt: null, error: null }
const BB: Account = { ...base, id: 'b', provider: 'bitbucket', host: 'bitbucket.org', username: 'alice', gitUser: 'alice', email: 'a@x.com', scopes: ['acme'] }
const GH: Account = { ...base, id: 'g', provider: 'github', host: 'github.com', username: 'octo', gitUser: 'octo', email: '', scopes: [] }
const GL: Account = { ...base, id: 'l', provider: 'gitlab', host: 'gitlab.example.com', username: 'me', gitUser: 'me', email: '', scopes: ['team/web'] }

test('OAuth: authorize URLs, PKCE, token requests and responses', async () => {
  expect(authorizeUrl('bitbucket', 'bitbucket.org', 'KEY', 'st', '')).toBe('https://bitbucket.org/site/oauth2/authorize?client_id=KEY&response_type=code&state=st')
  const gl = new URL(authorizeUrl('gitlab', 'gitlab.example.com', 'APP', 'st', 'CH'))
  expect(gl.origin + gl.pathname).toBe('https://gitlab.example.com/oauth/authorize')
  expect(gl.searchParams.get('redirect_uri')).toBe(OAUTH_REDIRECT)
  expect(gl.searchParams.get('code_challenge_method')).toBe('S256')
  // RFC 7636 appendix B
  expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')

  const bbCode = tokenRequest('bitbucket', 'bitbucket.org', { clientId: 'KEY', secret: 'SEC' }, { code: 'C', verifier: '' })
  expect(bbCode.url).toBe('https://bitbucket.org/site/oauth2/access_token')
  expect(bbCode.headers.Authorization).toBe(`Basic ${btoa('KEY:SEC')}`)
  expect(bbCode.body).toBe('grant_type=authorization_code&code=C')
  const glRefresh = tokenRequest('gitlab', 'gitlab.example.com', { clientId: 'APP', secret: '' }, { refreshToken: 'R' })
  expect(glRefresh.url).toBe('https://gitlab.example.com/oauth/token')
  expect(glRefresh.body).toContain('grant_type=refresh_token')
  expect(glRefresh.body).toContain('refresh_token=R')

  expect(parseTokenResponse('{"access_token":"A","refresh_token":"R","expires_in":7200}')).toEqual({ accessToken: 'A', refreshToken: 'R', expiresIn: 7200 })
  expect(parseTokenResponse('{"error":"invalid_grant","error_description":"bad code"}')).toEqual({ error: 'bad code' })
  expect(oauthGitUser('bitbucket', 'alice')).toBe('x-token-auth')
  expect(oauthGitUser('gitlab', 'me')).toBe('oauth2')
  expect(oauthGitUser('github', 'octo')).toBe('octo')
  expect(authHeaders({ provider: 'bitbucket', method: 'oauth', email: '' }, 'T').Authorization).toBe('Bearer T')
})

test('the OAuth app page never guesses a workspace name', async () => {
  expect(oauthAppPage('bitbucket', 'bitbucket.org', 'acme')).toBe('https://bitbucket.org/acme/workspace/settings')
  expect(oauthAppPage('bitbucket', 'bitbucket.org', '')).toBe('https://bitbucket.org/account/workspaces/')
  expect(oauthAppPage('gitlab', 'gitlab.example.com', '')).toBe('https://gitlab.example.com/-/user_settings/applications')
})

test('GitHub device flow requests and responses', async () => {
  expect(deviceCodeRequest('github.com', 'CID')).toMatchObject({ url: 'https://github.com/login/device/code', body: 'client_id=CID&scope=repo%20read%3Aorg' })
  expect(deviceTokenRequest('github.com', 'CID', 'DC').body).toBe('client_id=CID&device_code=DC&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code')
  expect(parseDeviceCode('{"device_code":"DC","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","interval":5,"expires_in":900}'))
    .toEqual({ deviceCode: 'DC', userCode: 'ABCD-1234', verifyUrl: 'https://github.com/login/device', interval: 5, expiresIn: 900 })
  expect(parseDeviceCode('{"error":"device_flow_disabled"}')).toEqual({ error: 'device_flow_disabled' })
})

test('auth headers per provider: Bitbucket signs in with the email, not the username', async () => {
  expect(authHeaders(BB, 'tok').Authorization).toBe(`Basic ${btoa('a@x.com:tok')}`)
  expect(authHeaders(GH, 'tok').Authorization).toBe('Bearer tok')
  expect(authHeaders(GL, 'tok')['PRIVATE-TOKEN']).toBe('tok')
  expect(verifyUrl(BB)).toBe('https://api.bitbucket.org/2.0/repositories/acme?pagelen=1&fields=size')
  expect(verifyUrl(GL)).toBe('https://gitlab.example.com/api/v4/user')
  expect(loginOf('github', '{"login":"octo"}')).toBe('octo')
  expect(providerForHost('gitlab.example.com', [GL])).toBe('gitlab')
  expect(providerForHost('git.corp', [])).toBe(null)
})

test('Bitbucket lists repos per workspace, the workspaces read first when none are given', async () => {
  // the removed cross-workspace GET /2.0/repositories is never asked for
  expect(repoListUrls({ ...BB, scopes: [] })).toEqual([])
  expect(repoListUrls({ ...BB, scopes: [] }, ['acme', 'other'])).toHaveLength(2)
  expect(repoListUrls(BB).some(u => /\/2\.0\/repositories\?/.test(u))).toBe(false)
  expect(parseWorkspacePage(JSON.stringify({
    values: [{ workspace: { slug: 'acme' } }, { workspace: { slug: 'alice' } }],
    next: 'https://api.bitbucket.org/2.0/user/workspaces?page=2',
  }))).toEqual({ slugs: ['acme', 'alice'], next: 'https://api.bitbucket.org/2.0/user/workspaces?page=2' })
})

test('repo list URLs follow the account scopes', async () => {
  expect(repoListUrls(BB)[0]).toContain('/2.0/repositories/acme?pagelen=100')
  expect(repoListUrls(GH)[0]).toContain('https://api.github.com/user/repos?per_page=100')
  expect(repoListUrls(GL)[0]).toContain('https://gitlab.example.com/api/v4/groups/team%2Fweb/projects?include_subgroups=true')
})

test('the repo API address asked before a refused git run blames the token', async () => {
  expect(repoApiUrl(BB, 'acme/web')).toBe('https://api.bitbucket.org/2.0/repositories/acme/web')
  expect(repoApiUrl(GH, 'octo/tool')).toBe('https://api.github.com/repos/octo/tool')
  expect(repoApiUrl(GL, 'team/web/app')).toBe('https://gitlab.example.com/api/v4/projects/team%2Fweb%2Fapp')
})

test('parses repo pages of the three providers', async () => {
  const bb = parseRepoPage(BB, JSON.stringify({
    next: 'https://api.bitbucket.org/next',
    values: [{ slug: 'web-app-router', full_name: 'acme/web-app-router', mainbranch: { name: 'release' }, project: { name: 'Web' },
      links: { clone: [{ name: 'https', href: 'https://alice@bitbucket.org/acme/web-app-router.git' }, { name: 'ssh', href: 'git@bitbucket.org:acme/web-app-router.git' }] } }],
  }), {})
  expect(bb.next).toBe('https://api.bitbucket.org/next')
  expect(bb.repos[0]).toMatchObject({
    key: 'bitbucket.org/acme/web-app-router', slug: 'web-app-router', mainBranch: 'release',
    httpsUrl: 'https://bitbucket.org/acme/web-app-router.git', sshUrl: 'git@ssh.bitbucket.org:acme/web-app-router.git',
  })
  const gh = parseRepoPage(GH, JSON.stringify([{ name: 'Hello', full_name: 'octo/Hello', default_branch: 'main', owner: { login: 'octo' }, clone_url: 'https://github.com/octo/Hello.git' }]),
    { link: '<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=5>; rel="last"' })
  expect(gh.next).toBe('https://api.github.com/user/repos?page=2')
  expect(gh.repos[0]).toMatchObject({ key: 'github.com/octo/hello', slug: 'hello', project: 'octo' })
  const gl = parseRepoPage(GL, JSON.stringify([{ path: 'app', path_with_namespace: 'team/web/app', visibility: 'private', namespace: { full_path: 'team/web' } }]), {})
  expect(gl.repos[0]).toMatchObject({ key: 'gitlab.example.com/team/web/app', isPrivate: true })
  expect(linkNext({})).toBe(null)
})

test('pull requests: list URL, parse and create body per provider', async () => {
  expect(prListUrl(BB, 'acme/web-app-router')).toBe('https://api.bitbucket.org/2.0/repositories/acme/web-app-router/pullrequests?state=OPEN&pagelen=50')
  expect(prListUrl(GL, 'team/web/app')).toBe('https://gitlab.example.com/api/v4/projects/team%2Fweb%2Fapp/merge_requests?state=opened&per_page=50')
  const bbPrs = parsePrs('bitbucket', JSON.stringify({ values: [{ id: 7, title: 'T', author: { display_name: 'A' }, source: { branch: { name: 'f' } }, destination: { branch: { name: 'release' } }, links: { html: { href: 'https://bb/7' } } }] }))
  expect(bbPrs[0]).toMatchObject({ id: '7', source: 'f', target: 'release', url: 'https://bb/7' })
  const ghPrs = parsePrs('github', JSON.stringify([{ number: 3, title: 'G', user: { login: 'o' }, head: { ref: 'h' }, base: { ref: 'main' }, html_url: 'https://gh/3' }]))
  expect(ghPrs[0]).toMatchObject({ id: '3', source: 'h', target: 'main' })
  const req = prCreateRequest(BB, 'acme/r', { title: 'T', source: 'f', target: 'release', description: '' })
  expect(JSON.parse(req.body)).toEqual({ title: 'T', description: '', source: { branch: { name: 'f' } }, destination: { branch: { name: 'release' } } })
  expect(JSON.parse(prCreateRequest(GH, 'o/r', { title: 'T', source: 'f', target: 'main', description: 'd' }).body)).toEqual({ title: 'T', head: 'f', base: 'main', body: 'd' })
  expect(httpsWithUser('https://bitbucket.org/acme/r.git', 'alice')).toBe('https://alice@bitbucket.org/acme/r.git')
})

test('publish: create-repo requests and responses for the three providers', async () => {
  const repo = { name: 'My Tool!', description: 'd', isPrivate: true }
  expect(repoSlug('My Tool!')).toBe('My-Tool')
  expect(createRepoRequest(GH, 'octo', repo)).toEqual({
    url: 'https://api.github.com/user/repos',
    body: JSON.stringify({ name: 'My-Tool', description: 'd', private: true, auto_init: false }),
  })
  expect(createRepoRequest(GH, 'acme-org', repo).url).toBe('https://api.github.com/orgs/acme-org/repos')
  expect(createRepoRequest(BB, 'acme', repo).url).toBe('https://api.bitbucket.org/2.0/repositories/acme/my-tool')
  expect(JSON.parse(createRepoRequest(BB, 'acme', repo).body)).toEqual({ scm: 'git', is_private: true, description: 'd' })
  expect(JSON.parse(createRepoRequest(GL, 'me', { ...repo, isPrivate: false }, 42).body)).toMatchObject({ path: 'My-Tool', visibility: 'public', namespace_id: 42 })

  expect(parseCreatedRepo('github', JSON.stringify({ html_url: 'https://github.com/o/r', clone_url: 'https://github.com/o/r.git', ssh_url: 'git@github.com:o/r.git' })))
    .toEqual({ webUrl: 'https://github.com/o/r', httpsUrl: 'https://github.com/o/r.git', sshUrl: 'git@github.com:o/r.git' })
  expect(parseCreatedRepo('bitbucket', JSON.stringify({ links: { html: { href: 'https://bitbucket.org/acme/r' }, clone: [{ name: 'https', href: 'https://alice@bitbucket.org/acme/r.git' }, { name: 'ssh', href: 'git@bitbucket.org:acme/r.git' }] } })))
    .toEqual({ webUrl: 'https://bitbucket.org/acme/r', httpsUrl: 'https://bitbucket.org/acme/r.git', sshUrl: 'git@ssh.bitbucket.org:acme/r.git' })
  expect(parseOwners('github', JSON.stringify([{ login: 'acme-org' }]))).toEqual(['acme-org'])
  expect(parseOwners('gitlab', JSON.stringify([{ full_path: 'team/web' }]))).toEqual(['team/web'])
  expect(ownersUrl(GL)).toBe('https://gitlab.example.com/api/v4/groups?min_access_level=30&per_page=100')
})
