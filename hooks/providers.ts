import type { Account, Provider, PullRequest, RemoteRepo } from '../types'

export const PROVIDERS: { value: Provider; label: string; host: string }[] = [
  { value: 'bitbucket', label: 'Bitbucket', host: 'bitbucket.org' },
  { value: 'github', label: 'GitHub', host: 'github.com' },
  { value: 'gitlab', label: 'GitLab', host: 'gitlab.com' },
]

export function defaultHost(p: Provider): string {
  return PROVIDERS.find(x => x.value === p)?.host ?? ''
}

export function providerLabel(p: Provider): string {
  return PROVIDERS.find(x => x.value === p)?.label ?? p
}

/** Which provider serves a host: a signed-in account's, else guessed from the name. */
export function providerForHost(host: string, accounts: readonly Account[]): Provider | null {
  const h = host.toLowerCase()
  const known = accounts.find(a => a.host === h)
  if (known) return known.provider
  if (h === 'bitbucket.org') return 'bitbucket'
  if (h === 'github.com') return 'github'
  if (h.includes('gitlab')) return 'gitlab'
  return null
}

export function apiBase(p: Provider, host: string): string {
  if (p === 'bitbucket') return 'https://api.bitbucket.org/2.0'
  if (p === 'github') return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`
  return `https://${host}/api/v4`
}

export function authHeaders(a: Pick<Account, 'provider' | 'method' | 'email'>, token: string): Record<string, string> {
  if (a.provider === 'github') {
    return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  }
  if (a.method === 'oauth') return { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  if (a.provider === 'bitbucket') {
    return { Authorization: `Basic ${btoa(`${a.email}:${token}`)}`, Accept: 'application/json' }
  }
  return { 'PRIVATE-TOKEN': token, Accept: 'application/json' }
}

/** A cheap call the token must pass before it is saved. */
export function verifyUrl(a: Account): string {
  const base = apiBase(a.provider, a.host)
  if (a.provider === 'bitbucket' && a.method === 'token') {
    const ws = a.scopes[0]
    return ws ? `${base}/repositories/${encodeURIComponent(ws)}?pagelen=1&fields=size` : `${base}/user`
  }
  return `${base}/user`
}

/** The login the provider reports for the token, when the verify call answers one. */
export function loginOf(p: Provider, text: string): string {
  try {
    const v = JSON.parse(text) as { login?: string; username?: string; nickname?: string }
    return (p === 'github' ? v.login : p === 'gitlab' ? v.username : v.username ?? v.nickname) ?? ''
  } catch {
    return ''
  }
}

export function tokenPageUrl(p: Provider, host: string): string {
  if (p === 'bitbucket') return 'https://id.atlassian.com/manage-profile/security/api-tokens'
  if (p === 'github') return `https://${host}/settings/personal-access-tokens/new`
  return `https://${host}/-/user_settings/personal_access_tokens?name=git-client&scopes=api,read_repository,write_repository`
}

export function tokenHint(p: Provider): string {
  if (p === 'bitbucket') {
    return 'API token with scopes → Bitbucket: read:repository, write:repository, read:pullrequest, write:pullrequest, read:workspace. Username = username Bitbucket (phân biệt hoa thường), email = email Atlassian.'
  }
  if (p === 'github') return 'Fine-grained token: Contents (read/write), Pull requests (read/write), Metadata (read). Username = login GitHub.'
  return 'Personal access token: api, read_repository, write_repository. Username = username GitLab.'
}

const BB_FIELDS =
  'next,values.slug,values.full_name,values.description,values.is_private,values.updated_on,values.mainbranch.name,values.project.name,values.links.clone'

/** First-page URLs listing the repos the account can see (per workspace / org / group when scoped). */
/**
 * Bitbucket has no cross-workspace repo list any more (`GET /2.0/repositories` was removed in 2026):
 * an account with no workspaces given lists its workspaces here first, then each one's repos.
 */
export const BITBUCKET_WORKSPACES_URL = 'https://api.bitbucket.org/2.0/user/workspaces?pagelen=100'

/** One page of `GET /2.0/user/workspaces`: the workspace slugs, and the next page. */
export function parseWorkspacePage(text: string): { slugs: string[]; next: string | null } {
  const page = JSON.parse(text) as { values?: { workspace?: { slug?: string }; slug?: string }[]; next?: string }
  const slugs = (page.values ?? []).map(v => v.workspace?.slug ?? v.slug ?? '').filter(Boolean)
  return { slugs, next: page.next ?? null }
}

/** First-page URLs listing the repos the account can see; Bitbucket needs the workspaces (`scopes`) to list. */
export function repoListUrls(a: Account, scopes: readonly string[] = a.scopes): string[] {
  const base = apiBase(a.provider, a.host)
  const enc = encodeURIComponent
  if (a.provider === 'bitbucket') {
    return scopes.map(ws => `${base}/repositories/${enc(ws)}?pagelen=100&sort=-updated_on&fields=${BB_FIELDS}`)
  }
  if (a.provider === 'github') {
    return a.scopes.length
      ? a.scopes.map(org => `${base}/orgs/${enc(org)}/repos?per_page=100&sort=updated`)
      : [`${base}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`]
  }
  return a.scopes.length
    ? a.scopes.map(g => `${base}/groups/${enc(g)}/projects?include_subgroups=true&per_page=100&order_by=last_activity_at&simple=true`)
    : [`${base}/projects?membership=true&per_page=100&order_by=last_activity_at&simple=true`]
}

/** The `rel="next"` URL of a `Link` header (GitHub, GitLab). */
export function linkNext(headers: Record<string, string>): string | null {
  const link = headers.link ?? headers.Link ?? ''
  const m = /<([^>]+)>;\s*rel="next"/.exec(link)
  return m?.[1] ?? null
}

type BbRepo = {
  slug?: string; full_name?: string; description?: string; is_private?: boolean; updated_on?: string
  mainbranch?: { name?: string } | null; project?: { name?: string } | null
  links?: { clone?: { name?: string; href?: string }[] }
}
type GhRepo = {
  name?: string; full_name?: string; description?: string | null; private?: boolean; pushed_at?: string; updated_at?: string
  default_branch?: string; owner?: { login?: string }; ssh_url?: string; clone_url?: string
}
type GlRepo = {
  path?: string; path_with_namespace?: string; description?: string | null; visibility?: string; last_activity_at?: string
  default_branch?: string; namespace?: { full_path?: string }; ssh_url_to_repo?: string; http_url_to_repo?: string
}

function stripUser(url: string): string {
  return url.replace(/\/\/[^@/]+@/, '//')
}

/** One page of a provider's repo list. */
export function parseRepoPage(a: Account, text: string, headers: Record<string, string>): { repos: RemoteRepo[]; next: string | null } {
  const host = a.host
  if (a.provider === 'bitbucket') {
    const page = JSON.parse(text) as { values?: BbRepo[]; next?: string }
    const repos = (page.values ?? []).map(v => {
      const fullName = v.full_name ?? ''
      const clone = v.links?.clone ?? []
      return {
        key: `${host}/${fullName}`.toLowerCase(),
        provider: a.provider,
        host,
        fullName,
        slug: (v.slug ?? fullName.split('/').pop() ?? '').toLowerCase(),
        project: v.project?.name ?? '',
        description: v.description ?? '',
        mainBranch: v.mainbranch?.name ?? '',
        updatedOn: v.updated_on ?? '',
        isPrivate: v.is_private ?? true,
        sshUrl: clone.find(c => c.name === 'ssh')?.href ?? `git@${host}:${fullName}.git`,
        httpsUrl: stripUser(clone.find(c => c.name === 'https')?.href ?? `https://${host}/${fullName}.git`),
      }
    })
    return { repos, next: page.next ?? null }
  }
  if (a.provider === 'github') {
    const list = JSON.parse(text) as GhRepo[]
    const repos = list.map(v => {
      const fullName = v.full_name ?? ''
      return {
        key: `${host}/${fullName}`.toLowerCase(),
        provider: a.provider,
        host,
        fullName,
        slug: (v.name ?? '').toLowerCase(),
        project: v.owner?.login ?? '',
        description: v.description ?? '',
        mainBranch: v.default_branch ?? '',
        updatedOn: v.pushed_at ?? v.updated_at ?? '',
        isPrivate: v.private ?? true,
        sshUrl: v.ssh_url ?? `git@${host}:${fullName}.git`,
        httpsUrl: v.clone_url ?? `https://${host}/${fullName}.git`,
      }
    })
    return { repos, next: linkNext(headers) }
  }
  const list = JSON.parse(text) as GlRepo[]
  const repos = list.map(v => {
    const fullName = v.path_with_namespace ?? ''
    return {
      key: `${host}/${fullName}`.toLowerCase(),
      provider: a.provider,
      host,
      fullName,
      slug: (v.path ?? '').toLowerCase(),
      project: v.namespace?.full_path ?? '',
      description: v.description ?? '',
      mainBranch: v.default_branch ?? '',
      updatedOn: v.last_activity_at ?? '',
      isPrivate: v.visibility !== 'public',
      sshUrl: v.ssh_url_to_repo ?? `git@${host}:${fullName}.git`,
      httpsUrl: v.http_url_to_repo ?? `https://${host}/${fullName}.git`,
    }
  })
  return { repos, next: linkNext(headers) }
}

export function prListUrl(a: Account, path: string): string {
  const base = apiBase(a.provider, a.host)
  if (a.provider === 'bitbucket') return `${base}/repositories/${path}/pullrequests?state=OPEN&pagelen=50`
  if (a.provider === 'github') return `${base}/repos/${path}/pulls?state=open&per_page=50`
  return `${base}/projects/${encodeURIComponent(path)}/merge_requests?state=opened&per_page=50`
}

type BbPr = {
  id?: number; title?: string; state?: string; updated_on?: string; author?: { display_name?: string }
  source?: { branch?: { name?: string } }; destination?: { branch?: { name?: string } }; links?: { html?: { href?: string } }
}
type GhPr = {
  number?: number; title?: string; state?: string; updated_at?: string; user?: { login?: string }
  head?: { ref?: string }; base?: { ref?: string }; html_url?: string
}
type GlPr = {
  iid?: number; title?: string; state?: string; updated_at?: string; author?: { username?: string }
  source_branch?: string; target_branch?: string; web_url?: string
}

function toPr(p: Provider, v: BbPr & GhPr & GlPr): PullRequest {
  if (p === 'bitbucket') {
    return {
      id: String(v.id ?? ''), title: v.title ?? '', author: v.author?.display_name ?? '',
      source: v.source?.branch?.name ?? '', target: v.destination?.branch?.name ?? '',
      url: v.links?.html?.href ?? '', updated: v.updated_on ?? '', state: v.state ?? '',
    }
  }
  if (p === 'github') {
    return {
      id: String(v.number ?? ''), title: v.title ?? '', author: v.user?.login ?? '',
      source: v.head?.ref ?? '', target: v.base?.ref ?? '', url: v.html_url ?? '', updated: v.updated_at ?? '', state: v.state ?? '',
    }
  }
  return {
    id: String(v.iid ?? ''), title: v.title ?? '', author: v.author?.username ?? '',
    source: v.source_branch ?? '', target: v.target_branch ?? '', url: v.web_url ?? '', updated: v.updated_at ?? '', state: v.state ?? '',
  }
}

export function parsePrs(p: Provider, text: string): PullRequest[] {
  const v = JSON.parse(text) as { values?: unknown[] } | unknown[]
  const list = (Array.isArray(v) ? v : v.values ?? []) as (BbPr & GhPr & GlPr)[]
  return list.map(x => toPr(p, x))
}

export function parseCreatedPr(p: Provider, text: string): PullRequest {
  return toPr(p, JSON.parse(text) as BbPr & GhPr & GlPr)
}

export function prCreateRequest(
  a: Account,
  path: string,
  pr: { title: string; source: string; target: string; description: string },
): { url: string; body: string } {
  const base = apiBase(a.provider, a.host)
  if (a.provider === 'bitbucket') {
    return {
      url: `${base}/repositories/${path}/pullrequests`,
      body: JSON.stringify({
        title: pr.title,
        description: pr.description,
        source: { branch: { name: pr.source } },
        destination: { branch: { name: pr.target } },
      }),
    }
  }
  if (a.provider === 'github') {
    return {
      url: `${base}/repos/${path}/pulls`,
      body: JSON.stringify({ title: pr.title, head: pr.source, base: pr.target, body: pr.description }),
    }
  }
  return {
    url: `${base}/projects/${encodeURIComponent(path)}/merge_requests`,
    body: JSON.stringify({ title: pr.title, source_branch: pr.source, target_branch: pr.target, description: pr.description }),
  }
}

/** The message an API error body carries, else the status. */
export function apiError(status: number, text: string): string {
  try {
    const v = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
    const msg = typeof v.error === 'string' ? v.error : v.error?.message ?? v.message
    if (msg) return `HTTP ${status}: ${String(msg).slice(0, 200)}`
  } catch {
    // not JSON
  }
  return `HTTP ${status}`
}

/** Every word of the query appears in the repo's name, project or description. */
export function matchesQuery(r: RemoteRepo, query: string): boolean {
  const hay = `${r.host} ${r.fullName} ${r.project} ${r.description}`.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w))
}

/** The https clone URL carrying the account's username, so git finds its saved token. */
export function httpsWithUser(url: string, username: string): string {
  return username ? url.replace(/^https:\/\/(?:[^@/]+@)?/, `https://${encodeURIComponent(username)}@`) : url
}

// ── OAuth ──────────────────────────────────────────────────────────────────

/** The browser comes back here after signing in; register exactly this URL in the OAuth app. */
export const OAUTH_PORT = 53682
export const OAUTH_REDIRECT = `http://127.0.0.1:${OAUTH_PORT}/callback`

/** The user name git sends with an OAuth access token. */
export function oauthGitUser(p: Provider, username: string): string {
  if (p === 'bitbucket') return 'x-token-auth'
  if (p === 'gitlab') return 'oauth2'
  return username
}

export function formBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** PKCE S256: the challenge sent with the authorize request for a verifier kept until the token exchange. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

/** Bitbucket (authorization code) and GitLab (authorization code + PKCE): where the browser signs in. */
export function authorizeUrl(p: Provider, host: string, clientId: string, state: string, challenge: string): string {
  if (p === 'bitbucket') {
    return `https://bitbucket.org/site/oauth2/authorize?${formBody({ client_id: clientId, response_type: 'code', state })}`
  }
  return `https://${host}/oauth/authorize?${formBody({
    client_id: clientId,
    redirect_uri: OAUTH_REDIRECT,
    response_type: 'code',
    state,
    scope: 'api read_repository write_repository',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`
}

export type HttpRequest = { url: string; headers: Record<string, string>; body: string }

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }

/** The token request for a code (`code`) or for a refresh (`refresh`). */
export function tokenRequest(
  p: Provider,
  host: string,
  app: { clientId: string; secret: string },
  grant: { code: string; verifier: string } | { refreshToken: string },
): HttpRequest {
  if (p === 'bitbucket') {
    return {
      url: 'https://bitbucket.org/site/oauth2/access_token',
      headers: { ...FORM, Authorization: `Basic ${btoa(`${app.clientId}:${app.secret}`)}` },
      body: 'code' in grant
        ? formBody({ grant_type: 'authorization_code', code: grant.code })
        : formBody({ grant_type: 'refresh_token', refresh_token: grant.refreshToken }),
    }
  }
  return {
    url: `https://${host}/oauth/token`,
    headers: FORM,
    body: 'code' in grant
      ? formBody({ client_id: app.clientId, code: grant.code, grant_type: 'authorization_code', redirect_uri: OAUTH_REDIRECT, code_verifier: grant.verifier })
      : formBody({ client_id: app.clientId, refresh_token: grant.refreshToken, grant_type: 'refresh_token', redirect_uri: OAUTH_REDIRECT }),
  }
}

export type TokenSet = { accessToken: string; refreshToken: string; expiresIn: number | null }

/** An OAuth token response, or the error it carries. */
export function parseTokenResponse(text: string): TokenSet | { error: string } {
  try {
    const v = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
    if (v.access_token) return { accessToken: v.access_token, refreshToken: v.refresh_token ?? '', expiresIn: v.expires_in ?? null }
    return { error: v.error_description ?? v.error ?? 'không nhận được token' }
  } catch {
    return { error: text.slice(0, 200) || 'phản hồi không đọc được' }
  }
}

/** GitHub device flow, step 1: a code the person enters on the provider's page. */
export function deviceCodeRequest(host: string, clientId: string): HttpRequest {
  return { url: `https://${host}/login/device/code`, headers: FORM, body: formBody({ client_id: clientId, scope: 'repo read:org' }) }
}

export function parseDeviceCode(text: string): { deviceCode: string; userCode: string; verifyUrl: string; interval: number; expiresIn: number } | { error: string } {
  try {
    const v = JSON.parse(text) as { device_code?: string; user_code?: string; verification_uri?: string; interval?: number; expires_in?: number; error_description?: string; error?: string }
    if (!v.device_code || !v.user_code) return { error: v.error_description ?? v.error ?? 'không nhận được mã thiết bị' }
    return { deviceCode: v.device_code, userCode: v.user_code, verifyUrl: v.verification_uri ?? '', interval: v.interval ?? 5, expiresIn: v.expires_in ?? 900 }
  } catch {
    return { error: text.slice(0, 200) }
  }
}

/** GitHub device flow, step 2, polled until the person has entered the code. */
export function deviceTokenRequest(host: string, clientId: string, deviceCode: string): HttpRequest {
  return {
    url: `https://${host}/login/oauth/access_token`,
    headers: FORM,
    body: formBody({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
  }
}

export function userUrl(p: Provider, host: string): string {
  return `${apiBase(p, host)}/user`
}

/** Where a public key is added to the account. */
export function sshKeysPage(p: Provider, host: string): string {
  if (p === 'bitbucket') return 'https://bitbucket.org/account/settings/ssh-keys/'
  if (p === 'github') return `https://${host}/settings/ssh/new`
  return `https://${host}/-/user_settings/ssh_keys`
}

/** Where an admin creates the OAuth app once for a team. */
export function oauthAppPage(p: Provider, host: string, workspace: string): string {
  // the workspace's settings page (OAuth consumers sit in its sidebar); with no workspace known, the list to pick one from
  if (p === 'bitbucket') {
    return workspace ? `https://bitbucket.org/${encodeURIComponent(workspace)}/workspace/settings` : 'https://bitbucket.org/account/workspaces/'
  }
  if (p === 'github') return `https://${host}/settings/applications/new`
  return `https://${host}/-/user_settings/applications`
}

export function oauthAppHint(p: Provider): string {
  if (p === 'bitbucket') {
    return `Trong Workspace settings (cần quyền admin của workspace): thanh bên trái → Apps and features → OAuth consumers → Add consumer. Callback URL: ${OAUTH_REDIRECT}. Bật "This is a private consumer". Quyền: Account (Read), Workspace membership (Read), Repositories (Write), Pull requests (Write). Lưu Key bên dưới và Secret (qua clipboard).`
  }
  if (p === 'github') {
    return `New OAuth App (cá nhân hoặc trong Organization). Callback URL: ${OAUTH_REDIRECT}. Tick "Enable Device Flow". Chỉ cần Client ID, không cần secret.`
  }
  return `Applications → Add new application. Redirect URI: ${OAUTH_REDIRECT}. Bỏ tick "Confidential". Scopes: api, read_repository, write_repository. Chỉ cần Application ID.`
}
