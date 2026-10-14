import { expect, test } from 'claude-code/testing'

import { finishSteps, flowBase, flowConfigArgs, flowDefaults, flowKindOf, parseFlowConfig } from './flow'

const CFG = { ...flowDefaults('main'), versiontag: 'v' }

test('reads git-flow AVH config, and nothing until both branches are set', async () => {
  expect(parseFlowConfig('gitflow.prefix.feature feature/\n')).toBe(null)
  const c = parseFlowConfig('gitflow.branch.master main\ngitflow.branch.develop dev\ngitflow.prefix.feature feat/\ngitflow.prefix.versiontag v\n')
  expect(c).toMatchObject({ master: 'main', develop: 'dev', feature: 'feat/', bugfix: 'bugfix/', versiontag: 'v' })
  expect(flowConfigArgs(CFG)[0]).toEqual(['config', '--local', 'gitflow.branch.master', 'main'])
})

test('branch kinds and bases', async () => {
  expect(flowKindOf('feature/login', CFG)).toEqual({ kind: 'feature', name: 'login' })
  expect(flowKindOf('release/1.2.0', CFG)).toEqual({ kind: 'release', name: '1.2.0' })
  expect(flowKindOf('feature/', CFG)).toBe(null)
  expect(flowKindOf('chore/x', CFG)).toBe(null)
  expect(flowBase('feature', CFG)).toBe('develop')
  expect(flowBase('hotfix', CFG)).toBe('main')
})

test('finishing a feature merges into develop and deletes the branch', async () => {
  expect(finishSteps('feature', 'feature/login', 'login', CFG, { keep: false, push: false, tagMessage: '' }).map(s => s.args)).toEqual([
    ['switch', '--', 'develop'],
    ['merge', '--no-ff', '--no-edit', 'feature/login'],
    ['branch', '-d', '--', 'feature/login'],
  ])
})

test('finishing a release merges into production, tags, merges back, and pushes when asked', async () => {
  const steps = finishSteps('release', 'release/1.2.0', '1.2.0', CFG, { keep: false, push: true, tagMessage: '' })
  expect(steps.map(s => s.args)).toEqual([
    ['switch', '--', 'main'],
    ['merge', '--no-ff', '--no-edit', 'release/1.2.0'],
    ['tag', '-a', 'v1.2.0', '-m', 'Release 1.2.0'],
    ['switch', '--', 'develop'],
    ['merge', '--no-ff', '--no-edit', 'release/1.2.0'],
    ['branch', '-d', '--', 'release/1.2.0'],
    ['push', 'origin', 'main:main', 'develop:develop'],
    ['push', 'origin', 'refs/tags/v1.2.0'],
    ['push', 'origin', '--delete', 'release/1.2.0'],
  ])
  expect(steps.at(-1)).toMatchObject({ optional: true, isNetwork: true })
  expect(finishSteps('hotfix', 'hotfix/1.2.1', '1.2.1', CFG, { keep: true, push: false, tagMessage: 'Sửa gấp' }).map(s => s.args[0]))
    .toEqual(['switch', 'merge', 'tag', 'switch', 'merge'])
})
