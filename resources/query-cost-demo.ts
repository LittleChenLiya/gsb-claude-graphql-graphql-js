import type { QueryCostNode } from '../src/execution/queryCost.ts';
import { estimateQueryCost } from '../src/execution/queryCost.ts';
import { parse } from '../src/language/parser.ts';
import { buildSchema } from '../src/utilities/buildASTSchema.ts';

const schema = buildSchema(`
  type User {
    id: ID!
    name: String
    friends(first: Int!): [User!]!
  }

  type Query {
    users(first: Int!): [User!]!
  }
`);

const document = parse(`
  {
    users(first: 2) {
      id
      name
      friends(first: 3) {
        id
      }
    }
  }
`);

const result = estimateQueryCost({
  schema,
  document,
  costConfig: {
    list: { argumentName: 'first', defaultLimit: 10, maxLimit: 100 },
    maxCost: 10,
  },
});

if ('errors' in result) {
  for (const error of result.errors) {
    console.error(error.message);
  }
  process.exitCode = 1;
} else {
  const { totalCost, costTree, diagnostics } = result.estimate;
  console.log(`Total cost: ${totalCost}`);
  console.log('Cost tree:');
  printTree(costTree, '  ');
  if (diagnostics.length === 0) {
    console.log('Within budget.');
  } else {
    console.log('Over-budget paths:');
    for (const diagnostic of diagnostics) {
      console.log(`  ${diagnostic.path}: ${diagnostic.message}`);
    }
  }
}

function printTree(nodes: ReadonlyArray<QueryCostNode>, indent: string): void {
  for (const node of nodes) {
    console.log(`${indent}${node.path} (cost ${node.cost})`);
    printTree(node.children, indent + '  ');
  }
}
