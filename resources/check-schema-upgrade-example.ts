/**
 * Example command that prints the diagnostics of a schema upgrade.
 *
 * Run it from the repository root (finishes in well under 90 seconds):
 *
 * ```shell
 * node --experimental-strip-types resources/check-schema-upgrade-example.ts
 * ```
 *
 * or via the npm script:
 *
 * ```shell
 * npm run example:schema-upgrade
 * ```
 */

import { parse } from '../src/language/parser.ts';
import { buildSchema } from '../src/utilities/buildASTSchema.ts';
import type { SchemaUpgradeDiagnostic } from '../src/validation/checkSchemaUpgrade.ts';
import { checkSchemaUpgrade } from '../src/validation/checkSchemaUpgrade.ts';

const oldSchema = buildSchema(/* GraphQL */ `
  type User {
    id: ID
    name: String
  }

  type Query {
    user(id: ID): User
  }
`);

const newSchema = buildSchema(/* GraphQL */ `
  type User {
    id: ID
    name: String
  }

  type Query {
    user(id: ID!): User
  }
`);

const report = checkSchemaUpgrade(oldSchema, newSchema, [
  // Missing the newly required argument: becomes a regression.
  { name: 'GetUserWithoutId', document: parse('{ user { id } }') },
  // Explicitly passes a legal id: stays valid after the upgrade.
  {
    name: 'GetUserWithId',
    document: parse('query GetUserWithId($id: ID!) { user(id: $id) { id } }'),
  },
  // References a field that never existed: pre-existing error only.
  {
    name: 'GetUserTypo',
    document: parse('{ user(id: "1") { idd } }'),
  },
]);

console.log('Schema changes:');
for (const change of report.breakingChanges) {
  console.log(`  [breaking:${change.type}] ${change.description}`);
}
for (const change of report.dangerousChanges) {
  console.log(`  [dangerous:${change.type}] ${change.description}`);
}

function printDiagnostics(
  title: string,
  diagnostics: ReadonlyArray<SchemaUpgradeDiagnostic>,
): void {
  console.log(title);
  if (diagnostics.length === 0) {
    console.log('  (none)');
  }
  for (const diagnostic of diagnostics) {
    const operation = diagnostic.operationName ?? '(anonymous)';
    const where = diagnostic.field ?? diagnostic.variable ?? 'unknown';
    const types =
      diagnostic.oldType === undefined
        ? ''
        : ` [${diagnostic.oldType} -> ${diagnostic.newType ?? 'removed'}]`;
    console.log(
      `  ${diagnostic.documentName} > ${operation} at ${where}${types}`,
    );
    console.log(`    [${diagnostic.rule}] ${diagnostic.message}`);
  }
}

printDiagnostics('Diagnostics before the upgrade (pre-existing):', [
  ...report.preExisting,
]);
printDiagnostics('Diagnostics after the upgrade (regressions):', [
  ...report.regressions,
]);

console.log(
  report.compatible
    ? 'The upgrade introduces no new incompatibilities.'
    : `The upgrade introduces ${report.regressions.length} regression(s).`,
);
