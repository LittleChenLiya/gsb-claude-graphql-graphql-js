/**
 * Short demo for `mergeASTs`.
 *
 * Run with:
 *   node --experimental-strip-types resources/mergeASTs-demo.ts
 */

import { GraphQLError } from '../src/error/GraphQLError.ts';
import type { DefinitionNode, DocumentNode } from '../src/language/ast.ts';
import { parse } from '../src/language/parser.ts';
import { print } from '../src/language/printer.ts';
import { Source } from '../src/language/source.ts';
import { mergeASTs } from '../src/utilities/mergeASTs.ts';

function show(label: string, value: unknown) {
  console.log(`\n=== ${label} ===`);
  console.log(value);
}

// 1. Identical fragments at different positions merge into one.
const first = parse(
  new Source(
    `
      query GetUser {
        ...UserFields
      }

      fragment UserFields on User {
        id
        name
      }
    `,
    'get-user.graphql',
  ),
);

const second = parse(
  new Source(
    `
      fragment UserFields on User {
        id
        name
      }

      query GetAdmin {
        ...AdminFields
      }

      fragment AdminFields on Admin {
        id
        role
      }
    `,
    'get-admin.graphql',
  ),
);

const merged = mergeASTs([first, second]);
show('merged document (UserFields kept once, order preserved)', print(merged));

// 2. Same-named fragments with different type conditions are rejected.
const onUser = parse(new Source('fragment F on User { id }', 'on-user.graphql'));
const onAdmin = parse(
  new Source('fragment F on Admin { id }', 'on-admin.graphql'),
);

try {
  mergeASTs([onUser, onAdmin]);
} catch (error) {
  if (error instanceof GraphQLError) {
    show('fragment conflict', {
      message: error.message,
      locations: error.locations,
      sources: error.nodes?.map((node) => node.loc?.source.name),
    });
  }
}

// 3. Two operations with the same name are rejected independently.
const opA = parse(new Source('query A { x }', 'op-a.graphql'));
const opB = parse(new Source('query A { y }', 'op-b.graphql'));

try {
  mergeASTs([opA, opB]);
} catch (error) {
  if (error instanceof GraphQLError) {
    show('operation conflict', {
      message: error.message,
      locations: error.locations,
      sources: error.nodes?.map((node) => node.loc?.source.name),
    });
  }
}

// 4. The result is independent from the originals.
const original = parse(new Source('fragment F on User { id }', 'orig.graphql'));
const result = mergeASTs([original]) as DocumentNode & {
  definitions: Array<DefinitionNode>;
};
result.definitions.push(
  parse(new Source('fragment G on User { name }', 'mutated.graphql'))
    .definitions[0],
);
show('original unchanged after mutating the result', {
  originalDefinitions: original.definitions.length,
  resultDefinitions: result.definitions.length,
});
