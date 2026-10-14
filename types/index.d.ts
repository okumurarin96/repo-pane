export type ChangedFile = {
  /** Two-letter status as `git status --short` prints it (`M `, ` M`, `??`, `UU`...). */
  code: string
  path: string
  isStaged: boolean
  isUnstaged: boolean
  isUntracked: boolean
  isConflicted: boolean
}

export type WorktreeStatus = {
  path: string
  label: string
  branch: string
  isDetached: boolean
  upstream: string | null
  ahead: number
  behind: number
  staged: number
  modified: number
  untracked: number
  conflicted: number
  files: ChangedFile[]
  error: string | null
}

export type RepoStatus = {
  name: string
  path: string
  /** `host/owner/repo` of origin, lowercased, else null. */
  remote: string | null
  worktrees: WorktreeStatus[]
  fetchError: string | null
  error: string | null
  /** The folder is gone (renamed, moved or deleted); `remote` is the last one seen there. */
  isMissing: boolean
}

/** The provider said a remote moved (repo renamed or transferred): where to, in the remote's own URL style. */
export type RemoteMove = { remote: string; from: string; to: string }

export type FetchInfo = { at: number | null; isRunning: boolean; failed: number }

export type Commit = { hash: string; short: string; author: string; when: string; refs: string; subject: string }

export type Branch = {
  name: string
  upstream: string
  /** `[ahead 1, behind 2]`, `[gone]` or '' */
  track: string
  when: string
  subject: string
  isHead: boolean
}

export type RemoteBranch = { name: string; when: string; subject: string }

export type Stash = { ref: string; when: string; message: string }

export type Tag = { name: string; when: string; subject: string }

export type OpState = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null

export type Provider = 'bitbucket' | 'github' | 'gitlab'

export type PullRequest = {
  id: string
  title: string
  author: string
  source: string
  target: string
  url: string
  updated: string
  state: string
}

/** What the open repo's tabs show, read for the selected worktree. */
/** A commit as the history graph reads it, with its parents. */
export type GraphCommit = {
  hash: string
  parents: string[]
  short: string
  author: string
  when: string
  refs: string
  subject: string
}

/** git-flow's settings (`gitflow.*` in the repo's config), as git-flow AVH writes them. */
export type FlowConfig = {
  master: string
  develop: string
  feature: string
  bugfix: string
  release: string
  hotfix: string
  support: string
  versiontag: string
}

export type FlowKind = 'feature' | 'bugfix' | 'release' | 'hotfix' | 'support'

export type Panel = {
  worktree: string
  branches: Branch[]
  remoteBranches: RemoteBranch[]
  log: Commit[]
  /** Every branch's recent history, for the drawn graph. */
  graph: GraphCommit[]
  /** The same history as `git log --graph` text, for surfaces that draw no SVG. */
  graphText: string
  remoteNames: string[]
  stashes: Stash[]
  tags: Tag[]
  submodules: string
  opState: OpState
  /** null while git-flow is not set up in the repo. */
  flow: FlowConfig | null
  prs: PullRequest[]
  prError: string | null
  isLoading: boolean
}

export type RepoTab = 'changes' | 'branches' | 'history' | 'flow' | 'stash' | 'tags' | 'prs' | 'advanced' | 'settings'

export type Selection = { repo: string; worktree: string; tab: RepoTab }

export type View = 'repos' | 'repo' | 'remote' | 'accounts'

export type RemoteUrl = { name: string; fetchUrl: string; pushUrl: string }

export type RepoSettings = {
  remotes: RemoteUrl[]
  localName: string
  localEmail: string
  name: string
  email: string
}

export type RemoteRepo = {
  /** `host/owner/repo`, lowercased: what a local repo's origin is matched on. */
  key: string
  provider: Provider
  host: string
  fullName: string
  slug: string
  project: string
  description: string
  mainBranch: string
  updatedOn: string
  isPrivate: boolean
  sshUrl: string
  httpsUrl: string
}

/** The repos one signed-in account can see, newest first, or why they could not be listed. */
export type RemoteGroup = {
  accountId: string
  provider: Provider
  host: string
  username: string
  repos: RemoteRepo[]
  error: string | null
}

export type RemoteList = {
  isLoading: boolean
  at: number | null
  errors: string[]
  /** Every repo once, across accounts. */
  repos: RemoteRepo[]
  /** The same repos per account (a repo two accounts see is in both). */
  groups: RemoteGroup[]
  onDisk: string[]
}

/** A signed-in account. The token itself lives in git's credential store (macOS Keychain), never here. */
export type Account = {
  id: string
  provider: Provider
  host: string
  /** `oauth`: signed in through the browser; `token`: a personal access / API token; `ssh`: an SSH key only (git, no API). */
  method: SignInMethod
  /** How git talks to the host for this account's repos. */
  protocol: GitProtocol
  /** The private key git uses over SSH; '' follows ~/.ssh/config. */
  sshKey: string
  /** The account's own name on the provider. */
  username: string
  /** The user name git sends over https with the saved secret (`x-token-auth`, `oauth2`, or the username). */
  gitUser: string
  /** When an OAuth access token runs out (it is refreshed before), null when it does not. */
  expiresAt: number | null
  /** Bitbucket only: the Atlassian email its REST API signs in with. */
  email: string
  /** Bitbucket workspaces / GitHub orgs / GitLab groups to list; empty lists everything the token sees. */
  scopes: string[]
  verifiedAt: number | null
  error: string | null
}

export type SignInMethod = 'oauth' | 'token' | 'ssh'

export type GitProtocol = 'https' | 'ssh'

export type AccountForm = {
  provider: Provider
  host: string
  method: SignInMethod
  protocol: GitProtocol
  sshKey: string
  username: string
  email: string
  scopes: string
}

export type SshKeyInfo = { path: string; fingerprint: string; comment: string }

export type SshState = {
  keys: SshKeyInfo[]
  /** The last connection test: which host, whether the key got in, and what the host said. */
  test: { host: string; key: string; ok: boolean; text: string } | null
  isTesting: boolean
}

/** An OAuth app (Bitbucket consumer, GitHub OAuth app, GitLab application) the browser sign-in goes through. */
export type OAuthApp = {
  provider: Provider
  host: string
  clientId: string
  /** Bitbucket only: the consumer secret is saved (in the Keychain, never here). */
  hasSecret: boolean
  /** Where it came from: the plugin's settings (shared with a team) or this pane. */
  source: 'settings' | 'pane'
}

/** A browser sign-in under way. */
export type OAuthProgress = {
  provider: Provider
  host: string
  stage: 'browser' | 'device' | 'exchange'
  /** GitHub device flow: the code the person types on github.com, and where. */
  userCode: string
  verifyUrl: string
  message: string
}

export type ScanResult = { isLoading: boolean; root: string; found: string[] }

export type Result = { label: string; ok: boolean; text: string; at: number }

export type Confirm = { key: string; label: string; detail: string }

export type DiffView = { title: string; source: string; format: 'diff' | 'source' }

declare module 'claude-code' {
  interface PluginState {
    'repo-pane': {
      repos: RepoStatus[]
      fetch: FetchInfo
      refreshedAt: number | null
      view: View
      selected: Selection | null
      panel: Panel | null
      settings: Record<string, RepoSettings>
      busy: Record<string, string>
      drafts: Record<string, string>
      flags: Record<string, boolean>
      confirm: Confirm | null
      result: Result | null
      diff: DiffView | null
      remote: RemoteList
      accounts: Account[]
      accountForm: AccountForm
      oauthApps: OAuthApp[]
      oauth: OAuthProgress | null
      scan: ScanResult
      ssh: SshState
      /** Where each account can create repos (orgs, workspaces, groups), by account id. */
      owners: Record<string, string[]>
      /** Remotes the provider reported as moved, by repo path. */
      moves: Record<string, RemoteMove>
      /** Repos on the signed-in accounts that may replace a dead remote, by repo path. */
      replacements: Record<string, RemoteRepo[]>
      /** Folders found that may be where a missing repo went, by its old path. */
      relocations: Record<string, string[]>
    }
  }
}
