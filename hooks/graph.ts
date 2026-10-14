import type { GraphCommit } from '../types'

/** `git log --date-order` printed with this format is what parseGraphLog reads. */
export const GRAPH_FORMAT = '--format=%H%x1f%P%x1f%h%x1f%an%x1f%cr%x1f%D%x1f%s'

export function parseGraphLog(out: string): GraphCommit[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [hash = '', parents = '', short = '', author = '', when = '', refs = '', ...subject] = line.split('\x1f')
      return { hash, parents: parents.split(' ').filter(Boolean), short, author, when, refs, subject: subject.join('\x1f') }
    })
}

/** One row of the laid-out graph. */
export type GraphRow = {
  /** The lane the commit's node sits in. */
  col: number
  /** What each lane waits for after this row (a commit hash), or null where the lane is free. */
  after: (string | null)[]
  /** Lanes that leave this row's node: its first parent's lane and any lane opened for another parent. */
  fromNode: number[]
  /** Lanes already waiting for another parent of this merge: the node also joins them. */
  joins: number[]
}

/**
 * Assigns lanes the way a history graph is drawn: a commit takes the lane that waits for it
 * (the leftmost when several do, the others closing into it), its first parent keeps that lane,
 * and each further parent joins the lane already waiting for it or opens the first free one.
 */
export function layoutGraph(commits: readonly GraphCommit[]): GraphRow[] {
  let lanes: (string | null)[] = []
  const rows: GraphRow[] = []
  for (const c of commits) {
    let col = lanes.indexOf(c.hash)
    if (col < 0) {
      col = lanes.indexOf(null)
      if (col < 0) col = lanes.length
    }
    const next = lanes.map((h, i) => (h === c.hash && i !== col ? null : h))
    next[col] = c.parents[0] ?? null
    const fromNode = [col]
    const joins: number[] = []
    for (const p of c.parents.slice(1)) {
      const k = next.indexOf(p)
      if (k >= 0) {
        joins.push(k)
        continue
      }
      let free = next.indexOf(null)
      if (free < 0) free = next.length
      next[free] = p
      fromNode.push(free)
    }
    // drop free lanes at the right edge so the graph does not keep growing
    while (next.length > 0 && next[next.length - 1] === null) next.pop()
    rows.push({ col, after: next, fromNode, joins })
    lanes = next
  }
  return rows
}

const COLORS = ['#4f8cff', '#e5534b', '#57ab5a', '#c69026', '#b083f0', '#39c5cf', '#e0823d', '#d16d9e']
const ROW = 24
const LANE = 12
const PAD = 10

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** The ref labels of a `%D` decoration, `HEAD -> ` folded into its branch; a ref under a remote's name is the remote's. */
export function refLabels(refs: string, remotes: readonly string[] = ['origin']): { text: string; kind: 'head' | 'branch' | 'remote' | 'tag' }[] {
  return refs
    .split(', ')
    .filter(Boolean)
    .filter(r => !/\/HEAD$/.test(r))
    .map(r => {
      if (r.startsWith('HEAD -> ')) return { text: r.slice(8), kind: 'head' as const }
      if (r.startsWith('tag: ')) return { text: r.slice(5), kind: 'tag' as const }
      if (r === 'HEAD') return { text: 'HEAD', kind: 'head' as const }
      return { text: r, kind: remotes.some(name => r.startsWith(`${name}/`)) ? ('remote' as const) : ('branch' as const) }
    })
}

// Text and backgrounds follow the viewer's light or dark scheme; lane colors read on both.
const STYLE =
  '<style>' +
  '.fg{fill:#1f2328}.dim{fill:#59636e}.bg{fill:#ffffff}.rm{fill:#d0d7de}.rmt{fill:#1f2328}.sel{fill:#ddf4ff}' +
  '.t{font-family:-apple-system,system-ui,sans-serif;font-size:12px}.s{font-size:11px}.m{font-family:ui-monospace,Menlo,monospace;font-size:11px}' +
  '@media (prefers-color-scheme: dark){.fg{fill:#e6edf3}.dim{fill:#9198a1}.bg{fill:#0d1117}.rm{fill:#30363d}.rmt{fill:#e6edf3}.sel{fill:#1f2d3d}}' +
  '</style>'

/**
 * The history as one SVG: lanes and nodes on the left, then each commit's refs, subject,
 * author and age on its row. Colors follow the lane, as in SourceTree.
 */
export function graphSvg(
  commits: readonly GraphCommit[],
  width: number,
  remotes: readonly string[] = ['origin'],
  selected = '',
): { svg: string; height: number } {
  const rows = layoutGraph(commits)
  const lanes = Math.max(1, ...rows.map(r => Math.max(r.after.length, r.col + 1)))
  const textX = PAD + lanes * LANE + 8
  const height = commits.length * ROW + 4
  const x = (lane: number) => PAD + lane * LANE
  const y = (row: number) => row * ROW + ROW / 2 + 2
  const color = (lane: number) => COLORS[lane % COLORS.length] ?? '#888'
  const parts: string[] = []
  const selectedRow = selected ? commits.findIndex(c => c.hash === selected) : -1
  if (selectedRow >= 0) parts.push(`<rect class="sel" x="0" y="${selectedRow * ROW + 2}" width="${width}" height="${ROW}"/>`)

  const edge =(startX: number, y1: number, endX: number, y2: number, stroke: string) => {
    if (startX === endX) {
      parts.push(`<line x1="${startX}" y1="${y1}" x2="${endX}" y2="${y2}" stroke="${stroke}" stroke-width="2"/>`)
    } else {
      const mid = (y1 + y2) / 2
      parts.push(`<path d="M${startX} ${y1} C${startX} ${mid} ${endX} ${mid} ${endX} ${y2}" fill="none" stroke="${stroke}" stroke-width="2"/>`)
    }
  }

  // edges between row i and row i+1, lane by lane
  rows.forEach((row, i) => {
    const below = commits[i + 1]
    const nextRow = rows[i + 1]
    const y1 = y(i)
    const y2 = below ? y(i + 1) : height
    row.after.forEach((h, lane) => {
      if (h === null) return
      const endsAtNext = Boolean(below && nextRow && h === below.hash)
      const endX = endsAtNext && nextRow ? x(nextRow.col) : x(lane)
      const stroke = color(endsAtNext && nextRow ? nextRow.col : lane)
      edge(row.fromNode.includes(lane) ? x(row.col) : x(lane), y1, endX, y2, stroke)
      // a merge whose other parent a lane already waits for: the node joins that lane too
      if (row.joins.includes(lane)) edge(x(row.col), y1, endX, y2, color(lane))
    })
  })

  // nodes and text
  commits.forEach((c, i) => {
    const row = rows[i]
    if (!row) return
    const cx = x(row.col)
    const cy = y(i)
    const isMerge = c.parents.length > 1
    parts.push(isMerge
      ? `<circle class="bg" cx="${cx}" cy="${cy}" r="5" stroke="${color(row.col)}" stroke-width="2.5"/>`
      : `<circle cx="${cx}" cy="${cy}" r="4.5" fill="${color(row.col)}"/>`)
    let tx = textX
    for (const ref of refLabels(c.refs, remotes).slice(0, 3)) {
      const label = clip(ref.text, 26)
      const w = label.length * 6.9 + 10
      const isRemote = ref.kind === 'remote'
      const fill = ref.kind === 'head' ? '#2f81f7' : ref.kind === 'tag' ? '#9a6700' : '#1a7f37'
      parts.push(isRemote
        ? `<rect class="rm" x="${tx}" y="${cy - 8}" width="${w}" height="16" rx="4"/>`
        : `<rect x="${tx}" y="${cy - 8}" width="${w}" height="16" rx="4" fill="${fill}"/>`)
      parts.push(`<text class="m${isRemote ? ' rmt' : ''}" x="${tx + 5}" y="${cy + 4}"${isRemote ? '' : ' fill="#ffffff"'}>${esc(label)}</text>`)
      tx += w + 6
    }
    const meta = clip(`${c.author} · ${c.when}`, 40)
    const metaW = (meta.length + c.short.length + 2) * 6.6
    const room = Math.max(8, Math.floor((width - tx - metaW - 24) / 7.2))
    parts.push(`<text class="t fg" x="${tx}" y="${cy + 4}">${esc(clip(c.subject, room))}</text>`)
    parts.push(`<text class="t s dim" x="${width - 8}" y="${cy + 4}" text-anchor="end">${esc(meta)}  ${esc(c.short)}</text>`)
  })

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${STYLE}${parts.join('')}</svg>`
  return { svg, height }
}
