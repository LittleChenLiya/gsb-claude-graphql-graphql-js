/**
 * Three-error demo for the read-only error grouper.
 *
 * Run it with:
 *   npm run demo:error-grouper
 *
 * A single query is executed once and produces exactly three errors that all
 * share the same underlying cause:
 *
 *   1. `renamed`      - an alias of the schema field `boom`
 *   2. `items.0.label` - the first list element
 *   3. `items.1.label` - the second list element
 *
 * The grouper is then fed the resulting errors (it never re-executes the
 * query) and prints the groups in both normal and masked mode, showing that
 * aliases and array indices are preserved, that the three same-cause errors
 * stay distinct events, and that masked mode drops the message text while
 * keeping paths and categories.
 */
import type { GraphQLErrorGroup } from '../src/error/errorGrouper.ts';
import { groupGraphQLErrors } from '../src/error/errorGrouper.ts';
import { executeSync } from '../src/execution/execute.ts';
import { parse } from '../src/language/parser.ts';
import { GraphQLList, GraphQLObjectType } from '../src/type/definition.ts';
import { GraphQLString } from '../src/type/scalars.ts';
import { GraphQLSchema } from '../src/type/schema.ts';

const sharedCause = new Error('database connection lost');

const ItemType: GraphQLObjectType = new GraphQLObjectType({
  name: 'Item',
  fields: {
    label: {
      type: GraphQLString,
      resolve() {
        throw sharedCause;
      },
    },
  },
});

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      boom: {
        type: GraphQLString,
        resolve() {
          throw sharedCause;
        },
      },
      items: {
        type: new GraphQLList(ItemType),
        resolve() {
          return [{}, {}];
        },
      },
    },
  }),
});

// Executed exactly once; the grouper only reads the produced errors.
const result = executeSync({
  schema,
  document: parse('{ renamed: boom, items { label } }'),
});
const errors = result.errors ?? [];

if (errors.length !== 3) {
  throw new Error(`Demo expected exactly 3 errors, got ${errors.length}.`);
}

function summarize(groups: ReadonlyArray<GraphQLErrorGroup>) {
  return groups.map((group) => ({
    operation: group.operation,
    category: group.category,
    path: group.path,
    count: group.count,
    events: group.events.map((event) => ({
      index: event.index,
      path: event.path,
      locations: event.locations,
      message: event.message,
    })),
  }));
}

const groups = groupGraphQLErrors(errors, { operation: 'DemoQuery' });
console.log('=== normal mode ===');
console.log(JSON.stringify(summarize(groups), null, 2));

const maskedGroups = groupGraphQLErrors(errors, {
  operation: 'DemoQuery',
  maskMessages: true,
});
const maskedSummary = summarize(maskedGroups);
console.log('=== masked mode (no message text) ===');
console.log(JSON.stringify(maskedSummary, null, 2));

if (JSON.stringify(maskedSummary).includes('database connection lost')) {
  throw new Error('Masked output must not contain the message text.');
}
if (
  maskedGroups.length !== 3 ||
  maskedGroups.some((group) => group.category !== 'resolver')
) {
  throw new Error('Masked output must keep all three paths and categories.');
}

console.log('Demo OK: 3 same-cause errors kept as 3 distinct events.');
