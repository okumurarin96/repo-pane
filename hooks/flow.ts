import type { FlowConfig, FlowKind } from '../types'

/** git-flow's own defaults, the production branch being whichever the repo has. */
export function flowDefaults(master: string): FlowConfig {
  return {
    master,
    develop: 'develop',
    feature: 'feature/',
    bugfix: 'bugfix/',
    release: 'release/',
    hotfix: 'hotfix/',
    support: 'support/',
    versiontag: '',
  }
}

export const FLOW_KINDS: { kind: FlowKind; label: string; from: 'develop' | 'master' }[] = [
  { kind: 'feature', label: 'Feature', from: 'develop' },
  { kind: 'bugfix', label: 'Bugfix', from: 'develop' },
  { kind: 'release', label: 'Release', from: 'develop' },
  { kind: 'hotfix', label: 'Hotfix', from: 'master' },
  { kind: 'support', label: 'Support', from: 'master' },
]

/** Reads `git config --get-regexp ^gitflow\.` (git-flow AVH keys); null until both branches are set. */
export function parseFlowConfig(out: string): FlowConfig | null {
  const v = new Map<string, string>()
  for (const line of out.split('\n')) {
    const i = line.indexOf(' ')
    if (i > 0) v.set(line.slice(0, i), line.slice(i + 1).trim())
  }
  const master = v.get('gitflow.branch.master') ?? v.get('gitflow.branch.main')
  const develop = v.get('gitflow.branch.develop')
  if (!master || !develop) return null
  const d = flowDefaults(master)
  return {
    master,
    develop,
    feature: v.get('gitflow.prefix.feature') ?? d.feature,
    bugfix: v.get('gitflow.prefix.bugfix') ?? d.bugfix,
    release: v.get('gitflow.prefix.release') ?? d.release,
    hotfix: v.get('gitflow.prefix.hotfix') ?? d.hotfix,
    support: v.get('gitflow.prefix.support') ?? d.support,
    versiontag: v.get('gitflow.prefix.versiontag') ?? d.versiontag,
  }
}

/** The `git config --local` writes that set git-flow up, the way `git flow init` stores them. */
export function flowConfigArgs(c: FlowConfig): string[][] {
  return [
    ['config', '--local', 'gitflow.branch.master', c.master],
    ['config', '--local', 'gitflow.branch.develop', c.develop],
    ['config', '--local', 'gitflow.prefix.feature', c.feature],
    ['config', '--local', 'gitflow.prefix.bugfix', c.bugfix],
    ['config', '--local', 'gitflow.prefix.release', c.release],
    ['config', '--local', 'gitflow.prefix.hotfix', c.hotfix],
    ['config', '--local', 'gitflow.prefix.support', c.support],
    ['config', '--local', 'gitflow.prefix.versiontag', c.versiontag],
  ]
}

/** Which git-flow branch a name is, and its name without the prefix. */
export function flowKindOf(branch: string, c: FlowConfig): { kind: FlowKind; name: string } | null {
  for (const { kind } of FLOW_KINDS) {
    const prefix = c[kind]
    if (prefix && branch.startsWith(prefix) && branch.length > prefix.length) return { kind, name: branch.slice(prefix.length) }
  }
  return null
}

export function flowBase(kind: FlowKind, c: FlowConfig): string {
  return FLOW_KINDS.find(k => k.kind === kind)?.from === 'master' ? c.master : c.develop
}

/** One git command of a finish; an optional step that fails does not stop the rest. A network step runs with credentials. */
export type FlowStep = { label: string; args: string[]; optional?: boolean; isNetwork?: boolean }

/**
 * What `git flow <kind> finish` does, step by step:
 * feature / bugfix merge into develop; release / hotfix merge into the production branch,
 * are tagged there, and are merged back into develop; then the branch is deleted (unless kept)
 * and, when asked, the touched branches and the tag are pushed.
 */
export function finishSteps(
  kind: FlowKind,
  branch: string,
  name: string,
  c: FlowConfig,
  opts: { keep: boolean; push: boolean; tagMessage: string },
): FlowStep[] {
  const steps: FlowStep[] = []
  const merge = (into: string) => {
    steps.push({ label: `Checkout ${into}`, args: ['switch', '--', into] })
    steps.push({ label: `Merge ${branch} vào ${into}`, args: ['merge', '--no-ff', '--no-edit', branch] })
  }
  const pushed: string[] = []
  if (kind === 'feature' || kind === 'bugfix') {
    merge(c.develop)
    pushed.push(c.develop)
  } else if (kind === 'release' || kind === 'hotfix') {
    const tag = `${c.versiontag}${name}`
    merge(c.master)
    steps.push({ label: `Tạo tag ${tag}`, args: ['tag', '-a', tag, '-m', opts.tagMessage || `${kind === 'release' ? 'Release' : 'Hotfix'} ${name}`] })
    merge(c.develop)
    pushed.push(c.master, c.develop)
  } else {
    return []
  }
  if (!opts.keep) steps.push({ label: `Xoá branch ${branch}`, args: ['branch', '-d', '--', branch] })
  if (opts.push) {
    steps.push({ label: `Push ${pushed.join(', ')}`, args: ['push', 'origin', ...pushed.map(b => `${b}:${b}`)], isNetwork: true })
    if (kind === 'release' || kind === 'hotfix') {
      steps.push({ label: 'Push tag', args: ['push', 'origin', `refs/tags/${c.versiontag}${name}`], isNetwork: true })
    }
    if (!opts.keep) {
      steps.push({ label: `Xoá ${branch} trên remote (nếu có)`, args: ['push', 'origin', '--delete', branch], optional: true, isNetwork: true })
    }
  }
  return steps
}
