// Owner-scoped graph metrics use one read snapshot and iterative traversals.
import type { Store } from './store';
import { integer, optionalText, relativePath, text } from './store-values';

type Adjacency = Map<number, Set<number>>;
interface Graph {
  nodes: Map<number, { path: string; language: string | null }>;
  outgoing: Adjacency;
  incoming: Adjacency;
  undirected: Adjacency;
  unresolved: number;
}
export interface GraphHealthReport {
  project: string;
  agent: string;
  generatedAt: string;
  nodeCount: number;
  directedEdgeCount: number;
  undirectedEdgeCount: number;
  unresolvedImportCount: number;
  selfReferenceCount: number;
  density: number;
  orphanCount: number;
  componentCount: number;
  largestComponent: number;
  cyclicComponentCount: number;
  cycleSamples: Array<{ size: number; members: string[] }>;
  orphanSamples: string[];
  hubs: Array<{ path: string; degree: number }>;
  languages: Array<{ language: string | null; count: number }>;
  markdown: string;
}

export function buildHealthReport(store: Store): GraphHealthReport {
  const graph = store.db.transaction(() => loadGraph(store)).deferred();
  const nodes = [...graph.nodes.keys()];
  const connected = components(nodes, graph.undirected);
  const strong = stronglyConnected(graph);
  const orphans = nodes.filter((node) => graph.undirected.get(node)!.size === 0);
  const directedEdges = [...graph.outgoing.values()].reduce((count, next) => count + next.size, 0);
  const undirectedEdges =
    [...graph.undirected.values()].reduce((count, next) => count + next.size, 0) / 2;
  const report: GraphHealthReport = {
    project: store.project,
    agent: store.agent,
    generatedAt: new Date().toISOString(),
    nodeCount: nodes.length,
    directedEdgeCount: directedEdges,
    undirectedEdgeCount: undirectedEdges,
    unresolvedImportCount: graph.unresolved,
    selfReferenceCount: nodes.filter((node) => graph.outgoing.get(node)!.has(node)).length,
    density: nodes.length < 2 ? 0 : (undirectedEdges * 2) / (nodes.length * (nodes.length - 1)),
    orphanCount: orphans.length,
    componentCount: connected.count,
    largestComponent: connected.largest,
    cyclicComponentCount: strong.count,
    cycleSamples: strong.samples,
    orphanSamples: orphans.slice(0, 30).map((node) => graph.nodes.get(node)!.path),
    hubs: nodes
      .map((node) => ({
        path: graph.nodes.get(node)!.path,
        degree: graph.undirected.get(node)!.size,
      }))
      .filter((node) => node.degree > 0)
      .sort((a, b) => b.degree - a.degree || a.path.localeCompare(b.path))
      .slice(0, 10),
    languages: languageCounts(graph),
    markdown: '',
  };
  report.markdown = render(report);
  return report;
}

function loadGraph(store: Store): Graph {
  const graph: Graph = {
    nodes: new Map(),
    outgoing: new Map(),
    incoming: new Map(),
    undirected: new Map(),
    unresolved: 0,
  };
  const rows = store.db
    .prepare('SELECT id,path,language FROM arachne_files WHERE project=? AND agent=? ORDER BY path')
    .iterate(store.project, store.agent);
  for (const value of rows) {
    if (graph.nodes.size >= 100000)
      throw new Error('Graph health supports at most 100000 files per owner');
    const row = value as Record<string, unknown>;
    const id = integer(row.id, 'graph file ID');
    graph.nodes.set(id, {
      path: relativePath(text(row.path, 'graph path')),
      language: optionalText(row.language, 'graph language'),
    });
    graph.outgoing.set(id, new Set());
    graph.incoming.set(id, new Set());
    graph.undirected.set(id, new Set());
  }
  loadEdges(store, graph);
  return graph;
}

function loadEdges(store: Store, graph: Graph): void {
  const rows = store.db
    .prepare(
      `SELECT d.source_file_id,d.target_file_id,t.project AS target_project,t.agent AS target_agent
    FROM arachne_dependencies d JOIN arachne_files f ON f.id=d.source_file_id
    LEFT JOIN arachne_files t ON t.id=d.target_file_id WHERE f.project=? AND f.agent=? ORDER BY f.path,d.target_path`,
    )
    .iterate(store.project, store.agent);
  let count = 0;
  for (const value of rows) {
    if (++count > 1000000)
      throw new Error('Graph health supports at most 1000000 imports per owner');
    const row = value as Record<string, unknown>;
    const source = integer(row.source_file_id, 'graph source ID');
    if (row.target_file_id === null) {
      graph.unresolved++;
      continue;
    }
    const target = integer(row.target_file_id, 'graph target ID');
    if (
      !graph.nodes.has(source) ||
      !graph.nodes.has(target) ||
      row.target_project !== store.project ||
      row.target_agent !== store.agent
    )
      throw new Error('Resolved graph edge refers to a missing or foreign file');
    graph.outgoing.get(source)!.add(target);
    graph.incoming.get(target)!.add(source);
    if (source !== target) {
      graph.undirected.get(source)!.add(target);
      graph.undirected.get(target)!.add(source);
    }
  }
}

function components(nodes: number[], adjacency: Adjacency): { count: number; largest: number } {
  const seen = new Set<number>();
  let count = 0,
    largest = 0;
  for (const node of nodes) {
    if (seen.has(node)) continue;
    count++;
    largest = Math.max(largest, collectComponent(node, adjacency, seen).length);
  }
  return { count, largest };
}

function collectComponent(start: number, adjacency: Adjacency, seen: Set<number>): number[] {
  const queue = [start];
  seen.add(start);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const next of adjacency.get(queue[cursor]!)!) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return queue;
}

function finishOrder(graph: Graph): number[] {
  const order: number[] = [],
    seen = new Set<number>();
  for (const node of graph.nodes.keys()) {
    if (seen.has(node)) continue;
    const stack = [{ node, edges: graph.outgoing.get(node)!.values() }];
    seen.add(node);
    while (stack.length) {
      const current = stack.at(-1)!;
      const next = current.edges.next();
      if (next.done) {
        order.push(current.node);
        stack.pop();
      } else if (!seen.has(next.value)) {
        seen.add(next.value);
        stack.push({
          node: next.value,
          edges: graph.outgoing.get(next.value)!.values(),
        });
      }
    }
  }
  return order;
}

function stronglyConnected(graph: Graph): {
  count: number;
  samples: GraphHealthReport['cycleSamples'];
} {
  const order = finishOrder(graph).reverse(),
    seen = new Set<number>();
  const samples: GraphHealthReport['cycleSamples'] = [];
  let count = 0;
  for (const node of order) {
    if (seen.has(node)) continue;
    const members = collectComponent(node, graph.incoming, seen);
    if (members.length === 1 && !graph.outgoing.get(node)!.has(node)) continue;
    count++;
    if (samples.length < 5)
      samples.push({
        size: members.length,
        members: members
          .slice(0, 10)
          .map((id) => graph.nodes.get(id)!.path)
          .sort(),
      });
  }
  return { count, samples };
}

function languageCounts(graph: Graph): GraphHealthReport['languages'] {
  const counts = new Map<string | null, number>();
  for (const node of graph.nodes.values())
    counts.set(node.language, (counts.get(node.language) ?? 0) + 1);
  return [...counts]
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => b.count - a.count || (a.language ?? '').localeCompare(b.language ?? ''));
}

function render(report: GraphHealthReport): string {
  const lines = [
    '# Arachne Graph Health',
    '',
    `Project ${JSON.stringify(report.project)}, agent ${JSON.stringify(report.agent)}`,
    '',
    `- Indexed files ${report.nodeCount}`,
    `- Directed edges ${report.directedEdgeCount}`,
    `- Undirected edges ${report.undirectedEdgeCount}`,
    `- Unresolved imports ${report.unresolvedImportCount}`,
    `- Self references ${report.selfReferenceCount}`,
    `- Density ${report.density.toFixed(6)}`,
    `- Connected components ${report.componentCount}, largest ${report.largestComponent}`,
    `- Files with no connected peers ${report.orphanCount}`,
    `- Cyclic strongly connected components ${report.cyclicComponentCount}`,
    '',
    '## Languages',
    ...report.languages.map((entry) => `- ${entry.language ?? 'unknown'} — ${entry.count}`),
    '',
    '## Most connected files',
    ...report.hubs.map((entry) => `- ${JSON.stringify(entry.path)} — ${entry.degree} peers`),
    '',
    '## Unconnected file sample',
    ...report.orphanSamples.map((filename) => `- ${JSON.stringify(filename)}`),
    '',
    '## Cyclic component samples',
    ...report.cycleSamples.map(
      (sample) =>
        `- ${sample.size} files, showing ${sample.members.length}\n  ${sample.members.map((name) => JSON.stringify(name)).join(', ')}`,
    ),
  ];
  return lines.join('\n');
}
