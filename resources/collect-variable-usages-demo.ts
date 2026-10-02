/**
 * Demo: prints the read-only AST variable-usage report for a GraphQL
 * operation. No schema is built and no resolver is executed; the report is
 * computed purely by walking the parsed document.
 *
 * Run with:
 *   node --experimental-strip-types resources/collect-variable-usages-demo.ts
 */
import { parse } from '../src/language/parser.ts';
import { collectVariableUsages } from '../src/utilities/collectVariableUsages.ts';

const document = parse(`
  query Q($id: ID!, $format: String = "short", $withName: Boolean) {
    a: user(id: $id) { ...F }
    b: user(id: $id) { ...F }
  }
  fragment F on User {
    name(format: $format) @include(if: $withName)
  }
`);

const report = collectVariableUsages(document, 'Q');

console.log(`Operation: ${report.operationName ?? '(anonymous)'}`);

console.log('Variable definitions:');
for (const definition of report.variableDefinitions) {
  const suffix = definition.hasDefaultValue ? ' (has default value)' : '';
  console.log(`  $${definition.name}: ${definition.type}${suffix}`);
}

console.log('Variable usages:');
for (const [name, locations] of report.usages) {
  if (locations.length === 0) {
    console.log(`  $${name}: no usages`);
    continue;
  }
  for (const location of locations) {
    const path =
      location.path.length === 0 ? '(operation)' : location.path.join('.');
    if (location.kind === 'argument') {
      console.log(
        `  $${name}: argument "${location.argumentName}" of field ` +
          `"${location.fieldName}" at ${path}`,
      );
    } else {
      console.log(
        `  $${name}: argument "${location.argumentName}" of directive ` +
          `"@${location.directiveName}" on ${location.appliedTo} at ${path}`,
      );
    }
  }
}
