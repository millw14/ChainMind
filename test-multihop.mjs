import { loadEnv } from './lib/load-env.js';
loadEnv();
import { getTursoClient } from './lib/turso.js';
import { expandFundingTreeInbound } from './lib/funding-tree-turso.js';

const client = getTursoClient();
const scope = 'Xqfwj8PrgpjksqgnopR9DwDuNZAXrqVHDbdcQ34pump';
const cutoff = Math.floor(Date.now() / 1000) - 168 * 3600;

// Start from known top fee payers
const seeds = [
  'EP49uUQ5xCde5mscmkhc4sj28MomPcXfeAJFD2oEaFFc',
  '9zvc5T2UP6y4NjNgNw34x5vGSEZMiYY8e3LARYYTYMCW',
  'yA9GYbaBx77bijswvbW3yN5rgCujh8mPViQvEPtmEnd',
  'BGrdEUwvYudqjL6HLGkEEzogM877gZmiD1Xsu5uQD2bh',
];

const tree = await expandFundingTreeInbound(client, scope, cutoff, seeds, {
  maxDepth: 3,
  maxNodes: 50,
});

console.log('Nodes found:', tree.nodeCount);
console.log('Edges found:', tree.edgeCount);
console.log('Max depth configured:', tree.maxDepthConfigured);
console.log('\nNodes by depth:');
tree.nodes.forEach(n => console.log(`  depth ${n.depth} | ${n.role} | ${n.address.slice(0,8)}…`));
console.log('\nEdges sample:');
tree.edges.slice(0, 5).forEach(e => console.log(`  hop ${e.hopDepth} | ${e.from.slice(0,8)}… → ${e.to.slice(0,8)}… | ${e.edge_type}`));
