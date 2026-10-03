/**
 * This is a standalone demo of `findVariableUsages`, a read-only AST utility
 * that reports where each variable of a selected operation is defined and
 * referenced. It parses a sample document, walks the operation and the
 * fragments reachable from it, and prints the variable definitions together
 * with the response field paths at which they are used. It never executes the
 * operation and never calls a resolver.
 *
 * Run it with:
 *
 * ```sh
 * node --experimental-strip-types resources/print-variable-usages.ts
 * ```
 */

import { parse } from '../src/language/parser.ts';
import { print } from '../src/language/printer.ts';
import type { VariableUsageLocation } from '../src/utilities/findVariableUsages.ts';
import { findVariableUsages } from '../src/utilities/findVariableUsages.ts';

const document = parse(`
  query GetUser($id: ID!, $first: Int = 10) {
    a: user(id: $id) {
      ...UserFields
    }
    b: user(id: $id) {
      ...UserFields
    }
  }

  fragment UserFields on User {
    friends(first: $first) {
      name
    }
  }
`);

const operationName = 'GetUser';
const report = findVariableUsages(document, operationName);

console.log('GraphQL document:');
console.log(print(document));
console.log(`Variable usage report for operation "${operationName}":`);

for (const variable of report.variables) {
  console.log(`\n  $${variable.name}`);
  if (variable.definition === undefined) {
    console.log('    defined: <none>');
  } else {
    const type = variable.definition.type;
    console.log(`    defined: ${print(type)}`);
  }

  if (variable.locations.length === 0) {
    console.log('    used:    <never>');
    continue;
  }

  for (const location of variable.locations) {
    console.log(`    used:    ${formatLocation(location)}`);
  }
}

function formatLocation(location: VariableUsageLocation): string {
  const path = location.path.length > 0 ? location.path.join('.') : '<root>';
  switch (location.kind) {
    case 'field-argument':
      return `field "${location.field}" argument "${location.argument}" at path "${path}"`;
    case 'directive-argument':
      return `directive "@${location.directive}" argument "${location.argument}" at path "${path}"`;
    case 'fragment-argument':
      return `fragment "...${location.fragmentSpread}" argument "${location.argument}" at path "${path}"`;
  }
}
