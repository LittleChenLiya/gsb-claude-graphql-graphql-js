/**
 * Demonstrates the pre-execution query cost analysis API.
 *
 * Run with:
 *   node --experimental-strip-types resources/query-cost-demo.ts
 */

import { parse } from '../src/language/parser.ts';
import { buildSchema } from '../src/utilities/buildASTSchema.ts';
import type { QueryCostNode } from '../src/validation/analyzeQueryCost.ts';
import { analyzeQueryCost } from '../src/validation/analyzeQueryCost.ts';

const schema = buildSchema(`
  type User {
    id: ID
    name: String
  }

  type Query {
    users(first: Int!): [User]
  }
`);

const costConfig = {
  budget: 4,
  fields: {
    'Query.users': {
      list: { argument: 'first', defaultCount: 10, maxCount: 100 },
    },
  },
};

function printCostTree(nodes: ReadonlyArray<QueryCostNode>, indent = 0): void {
  for (const node of nodes) {
    const suffix =
      node.listCount === undefined ? '' : ` x${node.listCount} items`;
    console.log(
      `${'  '.repeat(indent)}- ${node.key}: ${node.cost} cost${suffix}`,
    );
    if (node.children) {
      printCostTree(node.children, indent + 1);
    }
  }
}

const result = analyzeQueryCost(
  schema,
  parse('{ users(first: 2) { id name } }'),
  undefined,
  {},
  costConfig,
);

if ('errors' in result) {
  for (const error of result.errors) {
    console.error(error.message);
  }
  process.exitCode = 1;
} else {
  console.log(`totalCost: ${result.totalCost}`);
  console.log(`budget: ${result.budget}`);
  console.log(`withinBudget: ${result.withinBudget}`);
  console.log('costTree:');
  printCostTree(result.costTree);
  console.log(`overBudgetPath: ${result.overBudgetPath?.join(' / ')}`);
}
