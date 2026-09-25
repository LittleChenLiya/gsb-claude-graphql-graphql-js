/**
 * Example: check a set of named operations against an old and a new schema
 * and print the diagnostics from before and after the upgrade.
 *
 * Run it with:
 *
 *   npm run example:schema-upgrade
 *
 * The check is purely static (no resolver is ever executed) and finishes in
 * well under 90 seconds.
 */

import { buildSchema } from '../src/utilities/buildASTSchema.ts';
import type { UpgradeDiagnostic } from '../src/validation/checkSchemaUpgrade.ts';
import { checkSchemaUpgrade } from '../src/validation/checkSchemaUpgrade.ts';

const oldSchema = buildSchema(/* GraphQL */ `
  type Query {
    user(id: ID): User
    usersByRole(role: Role): [User]
  }

  type User {
    id: ID!
    name: String
  }

  enum Role {
    ADMIN
    USER
    GUEST
  }
`);

const newSchema = buildSchema(/* GraphQL */ `
  type Query {
    user(id: ID!): User
    usersByRole(role: Role): [User]
  }

  type User {
    id: ID!
    name: String
  }

  enum Role {
    ADMIN
    USER
  }
`);

const operations = [
  {
    name: 'GetUser',
    document: 'query GetUser { user { id name } }',
  },
  {
    name: 'GetUserWithId',
    document: 'query GetUserWithId { user(id: "user-1") { id name } }',
  },
  {
    name: 'GetUserTypo',
    document: 'query GetUserTypo { user(id: "user-1") { id nickname } }',
  },
  {
    name: 'GetGuests',
    document:
      'query GetGuests($role: Role = GUEST) { usersByRole(role: $role) { id } }',
  },
];

const startedAt = performance.now();
const report = checkSchemaUpgrade(oldSchema, newSchema, operations);
const elapsedMs = (performance.now() - startedAt).toFixed(1);

function formatDiagnostic(diagnostic: UpgradeDiagnostic): string {
  const [location] = diagnostic.locations;
  const position =
    location === undefined
      ? 'unknown position'
      : 'line ' + location.line + ', column ' + location.column;
  const lines = [
    '  [' + diagnostic.rule + '] ' + diagnostic.message,
    '    at ' + diagnostic.operationName + ' (' + position + ')',
  ];
  if (diagnostic.oldType !== undefined) {
    lines.push('    old: ' + diagnostic.oldType);
  }
  if (diagnostic.newType !== undefined) {
    lines.push('    new: ' + diagnostic.newType);
  }
  return lines.join('\n');
}

console.log('Schema upgrade check finished in ' + elapsedMs + 'ms');
console.log('');

console.log('Diagnostics before the upgrade (pre-existing problems):');
if (report.preExisting.length === 0) {
  console.log('  (none)');
}
for (const diagnostic of report.preExisting) {
  console.log(formatDiagnostic(diagnostic));
}
console.log('');

console.log('Diagnostics after the upgrade (new regressions):');
if (report.regressions.length === 0) {
  console.log('  (none)');
}
for (const diagnostic of report.regressions) {
  console.log(formatDiagnostic(diagnostic));
}
console.log('');

console.log('Per-operation status:');
for (const operation of report.operations) {
  console.log('  ' + operation.name + ': ' + operation.status);
}
