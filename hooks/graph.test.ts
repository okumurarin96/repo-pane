import { expect, test } from 'claude-code/testing'

import type { GraphCommit } from '../types'
import { graphSvg, layoutGraph, parseGraphLog, refLabels } from './graph'

const c = (hash: string, parents: string[], refs = ''): GraphCommit => ({ hash, parents, short: hash, author: 'A', when: '1h', refs, subject: `commit ${hash}` })

test('a merge opens a lane for its second parent, and the lanes close when they meet', async () => {
  // M merges F into main: M → (B, F), F → B, B → root
  const rows = layoutGraph([c('M', ['B', 'F']), c('F', ['B']), c('B', ['R']), c('R', [])])
  expect(rows.map(r => r.col)).toEqual([0, 1, 0, 0])
  expect(rows[0]).toMatchObject({ after: ['B', 'F'], fromNode: [0, 1] })
  // F's lane now waits for B too; B takes the leftmost lane and the other closes
  expect(rows[1]?.after).toEqual(['B', 'B'])
  expect(rows[2]?.after).toEqual(['R'])
  expect(rows[3]?.after).toEqual([])
})

test('a merge whose other parent a lane already waits for joins that lane', async () => {
  // X and Y both wait for P; M merges P on a lane already open for it
  const rows = layoutGraph([c('X', ['P']), c('M', ['Q', 'P']), c('Q', ['P']), c('P', [])])
  expect(rows[1]).toMatchObject({ col: 1, joins: [0] })
})

test('parses the graph log and labels refs by kind', async () => {
  const out = 'aaa\x1fbbb ccc\x1fa\x1fAnh\x1f1h\x1fHEAD -> main, origin/main, origin/HEAD, tag: v1\x1fmsg\n'
  expect(parseGraphLog(out)[0]).toMatchObject({ hash: 'aaa', parents: ['bbb', 'ccc'], refs: 'HEAD -> main, origin/main, origin/HEAD, tag: v1' })
  expect(refLabels('HEAD -> main, origin/main, origin/HEAD, tag: v1, feature/x')).toEqual([
    { text: 'main', kind: 'head' },
    { text: 'origin/main', kind: 'remote' },
    { text: 'v1', kind: 'tag' },
    { text: 'feature/x', kind: 'branch' },
  ])
})

test('the SVG escapes text, draws every commit and follows the color scheme', async () => {
  const { svg, height } = graphSvg([c('M', ['B', 'F'], 'HEAD -> main'), c('F', ['B']), c('B', [])], 800, ['origin'], 'F')
  expect(height).toBe(3 * 24 + 4)
  expect(svg.startsWith('<svg')).toBe(true)
  expect((svg.match(/<circle/g) ?? []).length).toBe(3)
  expect(svg).toContain('prefers-color-scheme: dark')
  expect(svg).toContain('class="sel"')
  expect(graphSvg([{ ...c('X', []), subject: '<script>&' }], 800).svg).toContain('&lt;script&gt;&amp;')
})
