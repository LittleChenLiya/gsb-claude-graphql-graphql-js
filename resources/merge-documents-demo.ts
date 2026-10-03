/**
 * Short demo of `mergeDocuments`, the safe document merge entry point.
 *
 * Run with:
 *   node --experimental-strip-types resources/merge-documents-demo.ts
 */

import { GraphQLError } from '../src/error/GraphQLError.ts';
import { parse } from '../src/language/parser.ts';
import { print } from '../src/language/printer.ts';
import { Source } from '../src/language/source.ts';
import { mergeDocuments } from '../src/utilities/mergeDocuments.ts';

// 1. Identical fragments defined at different locations merge into one.
const userQuery = parse(
  new Source('query GetUser { viewer { ...F } }', 'query.graphql'),
);
const fragmentA = parse(new Source('fragment F on User { id }', 'a.graphql'));
const fragmentB = parse(
  new Source('\n\n  fragment F on User { id }', 'b.graphql'),
);

const merged = mergeDocuments([userQuery, fragmentA, fragmentB]);
console.log('--- merged document (fragment F kept once) ---');
console.log(print(merged));

// 2. Same-named fragments with different type conditions are rejected,
//    reporting the locations of both definitions.
try {
  mergeDocuments([
    parse(new Source('fragment F on User { id }', 'a.graphql')),
    parse(new Source('\nfragment F on Admin { id }', 'b.graphql')),
  ]);
} catch (error) {
  console.log('--- conflicting fragments rejected ---');
  console.log(error instanceof GraphQLError && error.message);
  console.log('locations:', (error as GraphQLError).locations);
}

// 3. Same-named operations are always rejected, even when identical.
try {
  mergeDocuments([
    parse(new Source('query GetUser { viewer }', 'a.graphql')),
    parse(new Source('\n\nquery GetUser { viewer }', 'b.graphql')),
  ]);
} catch (error) {
  console.log('--- duplicate operation rejected ---');
  console.log(error instanceof GraphQLError && error.message);
  console.log('locations:', (error as GraphQLError).locations);
}
