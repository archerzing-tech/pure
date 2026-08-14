// src/shared/cliDiagram.ts
// Terminal wireframe rendering for mermaid / PlantUML diagram blocks.
//
// The GUI renders ```mermaid / ```puml blocks as real graphics; the CLI has no
// browser, so the same blocks are converted into a box-drawing wireframe
// (rectangles + connecting lines + ▶ arrows). Pure (no DOM / no TTY) so the
// renderer and the streaming converter are unit-testable headless.
//
// Two entry points:
//   - renderWireframe(source, lang)  — one-shot conversion of a complete block
//   - CliWireframeStream             — feed TokenDelta content through it; the
//     wrapper buffers open ```mermaid / ```puml / ```plantuml fences, renders
//     the completed block as a wireframe, and streams everything else through
//     unchanged (so prose stays live while diagrams appear when complete).

// ── Syntax support ──
// Mermaid: graph/flowchart TD|LR|RL|BT with `ID[Label]`, `ID(Label)`, `ID{Label}`,
// `ID((Label))`, bare `ID` (label = id), edges `A -->|label| B`, `A --- B`,
// `A -.-> B`, `A ==> B`. Subgraph contents are treated as top-level nodes.
// PlantUML: activity start/stop (`start`, `stop`, `end`), `:label;` steps and
// `-->` transitions; sequence participants `Alice -> Bob: message` with
// `->`/`-->`/`->>` arrows.
// Anything outside that subset yields null — the caller then prints the raw
// source instead of a wrong picture.

export interface DiagramGraph {
  /** id → display label (already stripped of markdown markup). */
  labels: Map<string, string>;
  /** Shape hint; only the diamond `{…}` currently changes the drawing. */
  shapes: Map<string, string>;
  /** Direction of the graph; default 'TD' when the header is missing/odd. */
  direction: 'LR' | 'RL' | 'TD' | 'BT';
  /** Edges keep declaration order (the layout uses it as a stable tiebreak). */
  edges: Array<{ from: string; to: string; label?: string; style: 'solid' | 'dashed' | 'thick' }>;
}

const NODE_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function stripMarkup(label: string): string {
  return label
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nodeLabel(raw: string): string {
  const text = raw.trim();
  // Quoted labels: "…" / '…' (may contain brackets).
  if (/^["']/.test(text)) {
    const quote = text[0];
    const end = text.indexOf(quote, 1);
    if (end > 1) return stripMarkup(text.slice(1, end));
    return stripMarkup(text.slice(1));
  }
  // Bare id → label is the id.
  if (NODE_ID_RE.test(text)) return text;
  return stripMarkup(text);
}

/** Parse the shape+label part of a mermaid node: `ID[...]`, `ID(...)`, `ID{...}`,
 * `ID((...))`, or a bare `ID`. Returns { id, label, shape } or null. */
function parseMermaidNode(token: string): { id: string; label: string; shape: string } | null {
  const trimmed = token.trim();
  const idMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/);
  if (!idMatch) return null;
  const id = idMatch[1];
  const rest = idMatch[2].trim();
  if (!rest) return { id, label: id, shape: 'rect' };
  // Groups: 1='[' 2='((' 3='{' 4='(' 5=inner content. The `((` and `))`
  // alternatives come FIRST so `E((完成))` closes on `))`, not a single `)`,
  // and `(` must not shadow `{` (B{...} is a diamond).
  const m = rest.match(/^(?:(\[)|(\(\()|(\{)|(\())([\s\S]*?)(?:\)\)|\]|\}|\))$/);
  if (!m) return null;
  const shape = m[1] ? 'rect' : m[2] ? 'circle' : m[3] ? 'diamond' : 'round';
  const inner = (m[5] ?? '').trim();
  return { id, label: inner ? nodeLabel(inner) : id, shape };
}

/** Split an edge statement into [leftTokens..., rightTokens...] around the
 * FIRST edge operator; `A -->|文字| B` keeps the `|label|` token with the
 * operator so the label can be extracted. */
function splitEdgeStatement(statement: string): { left: string; right: string; operator: string } | null {
  const m = statement.match(/^(.+?)\s*((?:--[->x]?|==[=>]?|->>|->)(?:\|[^|]*\|)?)\s*(.+)$/);
  if (!m) return null;
  return { left: m[1].trim(), right: m[3].trim(), operator: m[2].trim() };
}

function edgeLabelOf(operator: string): { label?: string; style: DiagramGraph['edges'][number]['style']; rest: string } {
  const labelM = operator.match(/^\S*?\|([^|]*)\|/);
  const label = labelM ? stripMarkup(labelM[1]) : undefined;
  const rest = operator.replace(/\|[^|]*\|/g, '');
  const style = rest.startsWith('==') ? 'thick' : rest.includes('.') ? 'dashed' : 'solid';
  return { label, style, rest };
}

/** Trim trailing `%% …` / `// …` comment from a source line. */
function stripComment(line: string): string {
  const idx = line.search(/\s*(?:%%|\/\/)\s/);
  return idx >= 0 ? line.slice(0, idx) : line;
}

export function parseMermaid(source: string): DiagramGraph | null {
  const labels = new Map<string, string>();
  const shapes = new Map<string, string>();
  const edges: DiagramGraph['edges'] = [];
  let direction: DiagramGraph['direction'] = 'TD';

  const ensure = (id: string, label?: string, shape = 'rect'): void => {
    if (id && !labels.has(id)) {
      labels.set(id, label ?? id);
      shapes.set(id, shape);
    }
  };

  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    if (/^(graph|flowchart)\s+[TBLR][DRLTB]/.test(line)) {
      const dir = line.split(/\s+/)[1] ?? 'TD';
      direction = dir === 'LR' || dir === 'RL' || dir === 'TD' || dir === 'BT' ? dir : 'TD';
      continue;
    }
    if (line.startsWith('subgraph')) continue;
    if (line === 'end') continue;

    const stmt = splitEdgeStatement(line);
    if (stmt) {
      const { label, style } = edgeLabelOf(stmt.operator);
      const leftNode = parseMermaidNode(stmt.left);
      const rightNode = parseMermaidNode(stmt.right);
      if (leftNode) ensure(leftNode.id, leftNode.label, leftNode.shape);
      if (rightNode) ensure(rightNode.id, rightNode.label, rightNode.shape);
      if (leftNode && rightNode) {
        edges.push({ from: leftNode.id, to: rightNode.id, label, style });
      }
      continue;
    }

    // Standalone node declaration (`A[Label]` on its own line).
    const node = parseMermaidNode(line);
    if (node) {
      ensure(node.id, node.label, node.shape);
      continue;
    }
    // `classDef`/`style`/`linkStyle`/`click` directives are ignored — nodes
    // are picked up from edge statements and declarations anyway.
  }

  if (labels.size === 0) return null;
  return { labels, shapes, direction, edges };
}

// ── PlantUML ──

export function parsePlantUml(source: string): DiagramGraph | null {
  const lines = source
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("'"))
    .filter((l) => !/^@startuml/.test(l) && !/^@enduml/.test(l));

  const labels = new Map<string, string>();
  const shapes = new Map<string, string>();
  const edges: DiagramGraph['edges'] = [];
  let direction: DiagramGraph['direction'] = 'TD';
  let seqCounter = 0;
  let lastStep: string | null = null;
  const ensure = (id: string, label: string, shape = 'rect'): void => {
    if (!labels.has(id)) {
      labels.set(id, label);
      shapes.set(id, shape);
    }
  };
  const nextId = (): string => `s${++seqCounter}`;

  // Sequence participants: `Alice -> Bob: message`.
  const seqEdge = (line: string): { a: string; b: string; label: string } | null => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:->|-->|->>)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/);
    return m ? { a: m[1], b: m[2], label: stripMarkup(m[3]) } : null;
  };

  for (const line of lines) {
    if (/^start(?:$|\s)/i.test(line)) {
      lastStep = null;
      continue;
    }
    if (/^(?:stop|end|endif)/i.test(line)) {
      lastStep = null;
      continue;
    }
    const seq = seqEdge(line);
    if (seq) {
      ensure(seq.a, seq.a);
      ensure(seq.b, seq.b);
      edges.push({ from: seq.a, to: seq.b, label: seq.label, style: 'solid' });
      lastStep = null;
      continue;
    }
    // `:label;` activity step; `if (cond) then` becomes a labeled decision box.
    const stepM = line.match(/^:([^;]*);?$/);
    const ifM = line.match(/^if\s+\(?(.+?)\)?\s*(?:then\s*)?$/i);
    const label = stepM ? stripMarkup(stepM[1]) : ifM ? stripMarkup(ifM[1]) : null;
    if (label !== null) {
      const id = nextId();
      ensure(id, label, ifM ? 'diamond' : 'rect');
      if (lastStep) edges.push({ from: lastStep, to: id, style: 'solid' });
      lastStep = id;
      continue;
    }
    // Continuation: `--> 校验库存` chains onto the previous step. The text
    // may itself be another activity step (`--> :发货;`) — strip the markers.
    const contM = line.match(/^--[->]?\s*(.+)$/);
    if (contM && lastStep) {
      const labelText = stripMarkup(contM[1].replace(/^:\s*|;\s*$/g, ''));
      if (labelText) {
        const id = nextId();
        ensure(id, labelText);
        edges.push({ from: lastStep, to: id, style: 'solid' });
        lastStep = id;
      }
      continue;
    }
    // A bare `-->` (or `->`) just continues the chain.
    if (/^--?->?$/.test(line)) continue;
  }

  if (edges.length === 0) return null;
  return { labels, shapes, direction, edges };
}

export function parseDiagramSource(source: string, lang: string): DiagramGraph | null {
  switch (lang) {
    case 'mermaid':
      return parseMermaid(source);
    case 'puml':
    case 'plantuml':
      return parsePlantUml(source);
    default:
      return null;
  }
}

// ── Wireframe layout ──
// Ranks: source nodes (no incoming edge) get rank 0, each downstream node one
// more than its furthest source (longest-path layering). LR/RL → columns,
// TD/BT → rows. Boxes within a rank are stacked with a 2-cell gap that doubles
// as the vertical routing channel for edges between ranks.

interface Placed {
  id: string;
  label: string;
  shape: string;
  box: { x: number; y: number; w: number; h: number };
}

const BOX_PAD = 1;           // horizontal padding inside each box
const RANK_GAP = 6;          // horizontal gap between LR ranks (edge run + elbow)
// Vertical gap between stacked boxes / ranks (TD). The middle row is the
// dedicated routing row for horizontal edge runs between ranks, so an edge
// between adjacent ranks never touches the boxes' border rows.
const ROW_GAP = 3;
const MAX_WIREFRAME_WIDTH = 120;

/** Display width of a string (CJK glyphs count 2). */
function textWidthOf(text: string): number {
  let w = 0;
  for (const ch of text) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return w;
}

/** Truncate a label to fit `width` display columns (CJK-aware). */
function fitLabel(text: string, width: number): string {
  if (width <= 0) return '';
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
    if (w + cw > width) break;
    out += ch;
    w += cw;
  }
  return out || text.slice(0, 1);
}

/** Merge a character onto the grid. Line characters join into junctions
 * (that is what makes the wireframe read as connected lines); text glyphs
 * and arrowheads always win (they sit ON the line they annotate). */
const LINE_CHARS = new Set(['─', '│', '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '┼', '═', '║', '╌', '╎', '╴', '╵', '╶', '╷']);
const ARROW_CHARS = new Set(['▶', '◀', '▼', '▲', '>', '<', 'v', '^']);

function put(grid: string[][], x: number, y: number, ch: string): void {
  if (x < 0 || y < 0 || y >= grid.length || x >= grid[y].length) return;
  const cur = grid[y][x];
  if (cur === ' ' || cur === ch) {
    grid[y][x] = ch;
    return;
  }
  const chIsLine = LINE_CHARS.has(ch);
  const curIsLine = LINE_CHARS.has(cur);
  if (chIsLine && curIsLine) {
    grid[y][x] = mergeLineChar(cur, ch);
  } else if (chIsLine && !curIsLine && ARROW_CHARS.has(cur)) {
    // Arrowhead already placed on the target edge — keep it.
    return;
  } else {
    // Text or arrowhead drawn on top of an existing line.
    grid[y][x] = ch;
  }
}

/** Junction table for two crossing line characters. */
function mergeLineChar(a: string, b: string): string {
  if (a === b) return a;
  const row = LINE_JUNCTIONS[a];
  if (row && row[b]) return row[b];
  const row2 = LINE_JUNCTIONS[b];
  if (row2 && row2[a]) return row2[a];
  return '┼';
}

// a↓ b→ : the junction at (a, b).
const LINE_JUNCTIONS: Record<string, Record<string, string>> = {
  '─': { '│': '┼', '┌': '─', '┐': '─', '└': '─', '┘': '─', '┬': '─', '┴': '─', '├': '─', '┤': '─', '═': '┼' },
  '│': { '─': '┼', '┌': '│', '┐': '│', '└': '│', '┘': '│', '┬': '│', '┴': '│', '├': '│', '┤': '│', '║': '┼' },
  '═': { '│': '┼', '─': '┼' },
  '║': { '─': '┼', '│': '┼' },
  '┌': { '─': '┌', '│': '┌' },
  '┐': { '─': '┐', '│': '┐' },
  '└': { '─': '└', '│': '└' },
  '┘': { '─': '┘', '│': '┘' },
};

function placeBoxes(graph: DiagramGraph): Placed[] {
  // Longest-path layering via repeated relaxation: rank[id] = max over edges
  // of rank[from] + 1. Iterating to a fixpoint gives every node a single
  // final rank (so a sequence participant targeted by an arrow lands in the
  // NEXT column instead of staying at 0), handles diamonds (max of the two
  // parents), and is cycle-tolerant (no topological order required).
  const rank = new Map<string, number>();
  for (const id of graph.labels.keys()) rank.set(id, 0);
  let changed = true;
  let guard = 0;
  while (changed && guard < 64) {
    changed = false;
    guard++;
    for (const e of graph.edges) {
      if (!rank.has(e.from) || !rank.has(e.to)) continue;
      const candidate = (rank.get(e.from) ?? 0) + 1;
      if (candidate > (rank.get(e.to) ?? 0)) {
        rank.set(e.to, candidate);
        changed = true;
      }
    }
  }

  // Group by rank; rank order is stable (declaration order ties broken by
  // edge order below — a node is only inserted once).
  const rankGroups = new Map<number, string[]>();
  for (const id of graph.labels.keys()) {
    const r = rank.get(id) ?? 0;
    if (!rankGroups.has(r)) rankGroups.set(r, []);
    rankGroups.get(r)!.push(id);
  }
  const ranks = [...rankGroups.keys()].sort((a, b) => a - b);
  const horizontal = graph.direction === 'LR' || graph.direction === 'RL';

  // Measure every box: width depends only on its label.
  const boxW = new Map<string, number>();
  for (const id of graph.labels.keys()) {
    const w = textWidthOf(graph.labels.get(id) ?? id) + BOX_PAD * 2;
    boxW.set(id, Math.max(4, Math.min(w, MAX_WIREFRAME_WIDTH - 4)));
  }

  const boxes: Placed[] = [];
  if (horizontal) {
    // LR: every rank is a column; columns are sized by their widest box.
    const colW = new Map<number, number>();
    for (const r of ranks) {
      let maxW = 0;
      for (const id of rankGroups.get(r)!) maxW = Math.max(maxW, boxW.get(id) ?? 0);
      colW.set(r, maxW);
    }
    let x = 0;
    for (const r of ranks) {
      let y = 0;
      for (const id of rankGroups.get(r)!) {
        const w = colW.get(r) ?? 0;
        boxes.push({ id, label: graph.labels.get(id) ?? id, shape: graph.shapes.get(id) ?? 'rect', box: { x, y, w, h: 3 } });
        y += 3 + ROW_GAP;
      }
      x += (colW.get(r) ?? 0) + RANK_GAP;
    }
  } else {
    // TD: every rank is a row; rows are sized by their tallest box (always 3).
    let y = 0;
    for (const r of ranks) {
      let x = 0;
      for (const id of rankGroups.get(r)!) {
        const w = boxW.get(id) ?? 0;
        boxes.push({ id, label: graph.labels.get(id) ?? id, shape: graph.shapes.get(id) ?? 'rect', box: { x, y, w, h: 3 } });
        x += w + RANK_GAP;
      }
      y += 3 + ROW_GAP;
    }
  }
  return boxes;
}

export function renderWireframe(source: string, lang: string): string | null {
  const graph = parseDiagramSource(source, lang);
  if (!graph) return null;
  const boxes = placeBoxes(graph);

  const width = Math.max(1, Math.min(
    MAX_WIREFRAME_WIDTH,
    Math.max(...boxes.map((b) => b.box.x + b.box.w)) + 1,
  ));
  const height = Math.max(1, Math.max(...boxes.map((b) => b.box.y + b.box.h)) + 1);
  const grid: string[][] = Array.from({ length: height }, () => new Array<string>(width).fill(' '));

  const boxIndex = new Map<string, Placed>();
  for (const b of boxes) boxIndex.set(b.id, b);

  // ── Edges (drawn FIRST: a box painted later overwrites any line that
  // crosses its interior, so the border rows stay clean) ──
  const horizontal = graph.direction === 'LR' || graph.direction === 'RL';
  for (const e of graph.edges) {
    const from = boxIndex.get(e.from);
    const to = boxIndex.get(e.to);
    if (!from || !to) continue;
    const edgeChar = e.style === 'dashed' ? '╌' : e.style === 'thick' ? '═' : '─';
    if (horizontal) {
      const f = from.box;
      const t = to.box;
      const dir = graph.direction === 'RL' ? -1 : 1;
      const sourceX = dir > 0 ? f.x + f.w : f.x - 1;       // exit cell
      const targetX = dir > 0 ? t.x - 1 : t.x + t.w;       // entry cell
      // Arrowheads sit on the ROUTING column (exit+1); the bend column
      // (exit+2) carries the other edges' runs, so they never merge over an
      // arrowhead of a parallel edge.
      const bend = dir > 0
        ? Math.max(sourceX + 1, Math.min(targetX - 1, f.x + f.w + 2))
        : Math.min(sourceX - 1, Math.max(targetX + 1, f.x - 3));
      const sourceY = f.y + Math.floor(f.h / 2);
      const targetY = t.y + Math.floor(t.h / 2);
      // Horizontal run out of the source → bend column.
      for (let x = Math.min(sourceX, bend); x <= Math.max(sourceX, bend); x++) put(grid, x, sourceY, edgeChar);
      // Vertical run along the bend into the target's row.
      for (let y = Math.min(sourceY, targetY); y <= Math.max(sourceY, targetY); y++) put(grid, bend, y, '│');
      // Horizontal run into the target.
      for (let x = Math.min(bend, targetX); x <= Math.max(bend, targetX); x++) put(grid, x, targetY, edgeChar);
      // Edge label above the first run, centered.
      if (e.label) {
        const runLen = Math.abs(bend - sourceX);
        const lx = sourceX + Math.max(1, Math.floor((runLen - textWidthOf(e.label)) / 2));
        let cx = lx;
        for (const ch of e.label) {
          put(grid, cx, sourceY - 1, ch);
          cx += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
        }
      }
    } else {
      const f = from.box;
      const t = to.box;
      const dir = graph.direction === 'BT' ? -1 : 1;
      const sourceY = dir > 0 ? f.y + f.h : f.y - 1;       // exit cell
      const targetY = dir > 0 ? t.y - 1 : t.y + t.h;       // entry cell
      // Arrowheads sit on the ROUTING row (exit+1); the bend row (exit+2)
      // carries the other edges' runs, so they never merge over an arrowhead
      // of a parallel edge.
      const bend = dir > 0
        ? Math.max(sourceY + 1, Math.min(targetY - 1, f.y + f.h + 2))
        : Math.min(sourceY - 1, Math.max(targetY + 1, f.y - 3));
      const sourceX = f.x + Math.floor(f.w / 2);
      const targetX = t.x + Math.floor(t.w / 2);
      // Vertical run out of the source → bend row.
      for (let y = Math.min(sourceY, bend); y <= Math.max(sourceY, bend); y++) put(grid, sourceX, y, '│');
      // Horizontal run along the bend into the target's column.
      for (let x = Math.min(sourceX, targetX); x <= Math.max(sourceX, targetX); x++) put(grid, x, bend, edgeChar);
      // Vertical run into the target.
      for (let y = Math.min(bend, targetY); y <= Math.max(bend, targetY); y++) put(grid, targetX, y, '│');
      // Edge label to the right of the vertical run.
      if (e.label) {
        const runLen = Math.abs(bend - sourceY);
        const ly = sourceY + Math.max(1, Math.floor((runLen - 1) / 2));
        let cx = sourceX + 2;
        for (const ch of e.label) {
          put(grid, cx, ly, ch);
          cx += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
        }
      }
    }
  }

  // ── Boxes (painted over the edges: borders overwrite lines passing
  // through the box interior) ──
  for (const b of boxes) {
    const { x, y, w, h } = b.box;
    for (let i = 1; i < w - 1; i++) {
      put(grid, x + i, y, '─');
      put(grid, x + i, y + h - 1, '─');
    }
    for (let j = 1; j < h - 1; j++) {
      put(grid, x, y + j, '│');
      put(grid, x + w - 1, y + j, '│');
    }
    put(grid, x, y, '┌');
    put(grid, x + w - 1, y, '┐');
    put(grid, x, y + h - 1, '└');
    put(grid, x + w - 1, y + h - 1, '┘');

    // Label: centered on the middle row, truncated to the box width.
    const usable = Math.max(0, w - 2);
    const fitted = fitLabel(b.label, usable);
    const fw = textWidthOf(fitted);
    let cx = x + 1 + Math.max(0, Math.floor((usable - fw) / 2));
    const midY = y + Math.floor(h / 2);
    for (const ch of fitted) {
      put(grid, cx, midY, ch);
      cx += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
    }
  }

  // ── Arrowheads (drawn LAST: they sit at the target entry cell and must
  // never be merged over by a later line) ──
  for (const e of graph.edges) {
    const to = boxIndex.get(e.to);
    if (!to) continue;
    if (horizontal) {
      const t = to.box;
      const dir = graph.direction === 'RL' ? -1 : 1;
      const arrowX = dir > 0 ? t.x - 1 : t.x + t.w;
      const targetY = t.y + Math.floor(t.h / 2);
      put(grid, arrowX, targetY, dir > 0 ? '▶' : '◀');
    } else {
      const t = to.box;
      const dir = graph.direction === 'BT' ? -1 : 1;
      const arrowY = dir > 0 ? t.y - 1 : t.y + t.h;
      const targetX = t.x + Math.floor(t.w / 2);
      put(grid, targetX, arrowY, dir > 0 ? '▼' : '▲');
    }
  }

  const lines = grid.map((row) => row.join('').replace(/\s+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

// ── Streaming converter ──
// Feeds TokenDelta content through to a writer; when a complete ```mermaid /
// ```puml / ```plantuml fence closes, the block is rendered as a wireframe
// instead of the raw source. All other text streams through immediately so
// the CLI stays live.

const DIAGRAM_LANGS = new Set(['mermaid', 'puml', 'plantuml']);

export class CliWireframeStream {
  private pending = '';
  private fenceLang: string | null = null;
  private fenceOpen = false;

  constructor(private readonly write: (chunk: string) => void) {}

  feed(text: string): void {
    if (!text) return;
    this.pending += text;
    this.drain();
  }

  private drain(): void {
    while (this.pending.length > 0) {
      if (this.fenceOpen) {
        const close = this.pending.indexOf('```');
        if (close < 0) return; // block still open — keep buffering
        const content = this.pending.slice(0, close);
        this.pending = this.pending.slice(close + 3);
        this.fenceOpen = false;
        this.emitWireframe(content);
        continue;
      }
      const open = this.pending.indexOf('```');
      if (open < 0) {
        // A trailing run of 1–3 backticks COULD be the start of a fence
        // opener split across tokens (a lone ` then `` then ``` …). Hold
        // them back until the line completes; flush everything before them
        // immediately. A plain line with no backticks flushes whole.
        const nl = this.pending.lastIndexOf('\n');
        const tail = this.pending.slice(nl + 1);
        const ticks = tail.match(/`+$/)?.[0] ?? '';
        if (ticks.length >= 1 && ticks.length <= 3) {
          if (nl >= 0) this.write(this.pending.slice(0, nl + 1));
          this.pending = this.pending.slice(Math.max(0, nl + 1));
          return;
        }
        this.write(this.pending);
        this.pending = '';
        return;
      }
      // Flush prose before the fence opener.
      if (open > 0) {
        this.write(this.pending.slice(0, open));
        this.pending = this.pending.slice(open);
        continue;
      }
      // pending starts with triple-backticks — the opener line may arrive
      // split across tokens (e.g. a half-typed language tag). Hold a line
      // with NO newline yet until it completes, so the tag is never cut
      // mid-token.
      const nl = this.pending.indexOf('\n');
      if (nl < 0) return;
      const lineEnd = nl;
      const info = this.pending.slice(3, lineEnd).trim().toLowerCase().split(/\s+/)[0] ?? '';
      if (DIAGRAM_LANGS.has(info)) {
        this.fenceLang = info;
        this.fenceOpen = true;
        this.pending = this.pending.slice(lineEnd + 1); // consume the opener line
        continue;
      }
      // Not a diagram fence — emit the opener and keep scanning.
      this.write('```');
      this.pending = this.pending.slice(3);
    }
  }

  private emitWireframe(content: string): void {
    const rendered = this.fenceLang ? renderWireframe(content, this.fenceLang) : null;
    if (rendered) {
      this.write(`┌─ ${this.fenceLang} 流程图 · 线框渲染 ──────────────────────────\n`);
      this.write(rendered);
      this.write('\n└──────────────────────────────────────────────\n');
    } else {
      // Unparseable diagram — print the raw block so nothing is lost.
      this.write('```' + (this.fenceLang ?? '') + '\n');
      this.write(content);
      this.write('```\n');
    }
  }

  /** Flush any trailing buffered text. An unclosed fence can only be a
   * truncated diagram — emit the RAW source (never a partial wireframe, which
   * would be a wrong picture); plain prose flushes as-is. */
  flush(): void {
    if (this.fenceOpen && this.fenceLang) {
      const content = this.pending;
      this.pending = '';
      this.fenceOpen = false;
      this.write('```' + this.fenceLang + '\n');
      this.write(content);
      this.write('```\n');
      this.fenceLang = null;
      return;
    }
    if (this.pending.length > 0) {
      this.write(this.pending);
      this.pending = '';
    }
  }
}

/** One-shot conversion of a complete assistant message: every ```mermaid /
 * ```puml block is replaced by its wireframe; everything else is untouched. */
export function renderWireframeFromMarkdown(text: string): string {
  if (!text.includes('```')) return text;
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('```', i);
    if (open < 0) {
      out.push(text.slice(i));
      break;
    }
    out.push(text.slice(i, open));
    const nl = text.indexOf('\n', open);
    const lineEnd = nl < 0 ? text.length : nl;
    const info = text.slice(open + 3, lineEnd).trim().toLowerCase().split(/\s+/)[0] ?? '';
    if (!DIAGRAM_LANGS.has(info)) {
      // Non-diagram fence: emit it verbatim and continue past it.
      const close = text.indexOf('```', lineEnd + 1);
      if (close < 0) {
        out.push(text.slice(open));
        break;
      }
      out.push(text.slice(open, close + 3));
      i = close + 3;
      continue;
    }
    const close = text.indexOf('```', lineEnd + 1);
    if (close < 0) {
      out.push(text.slice(open));
      break;
    }
    const content = text.slice(lineEnd + 1, close);
    const rendered = renderWireframe(content, info);
    if (rendered) {
      out.push(`┌─ ${info} 流程图 · 线框渲染 ──────────────────────────\n${rendered}\n└──────────────────────────────────────────────\n`);
    } else {
      out.push(text.slice(open, close + 3));
    }
    i = close + 3;
  }
  return out.join('');
}
