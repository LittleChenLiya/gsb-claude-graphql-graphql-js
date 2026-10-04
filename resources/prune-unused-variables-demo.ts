/**
 * Offline demo for {@link pruneUnusedVariables}: prints a document with
 * multiple operations before and after per-operation variable pruning.
 *
 * Run with:
 *
 * ```sh
 * node --experimental-strip-types resources/prune-unused-variables-demo.ts
 * ```
 *
 * No schema or resolver is involved; the transformation is purely syntactic.
 */
import { parse } from '../src/language/parser.ts';
import { print } from '../src/language/printer.ts';
import { pruneUnusedVariables } from '../src/utilities/pruneUnusedVariables.ts';

const documentSource = `
  query GetUser($id: ID!, $include: Boolean, $unused: String) {
    user(id: $id) @include(if: $include) {
      ...UserFields
    }
  }

  fragment UserFields on User {
    id
    name
  }

  query GetStatus($unused: String, $active: Boolean!) {
    status(active: $active)
  }
`;

const document = parse(documentSource);

console.log('=== Before pruning ===');
console.log(print(document));

const prunedDocument = pruneUnusedVariables(document);

console.log('=== After pruning ===');
console.log(print(prunedDocument));
