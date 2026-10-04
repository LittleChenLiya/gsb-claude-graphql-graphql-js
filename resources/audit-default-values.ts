/**
 * Repeatable audit command for schema default values.
 *
 * Audits every argument and input field default value of a schema, reporting
 * any default that cannot be converted to a valid literal for its input type.
 * The audit is read-only and never executes custom scalar `serialize`
 * functions; custom scalar defaults are reported as unknown unless an audit
 * adapter is registered in `auditDefaultValues` options.
 *
 * Usage:
 *   npm run audit:defaults -- path/to/schema.graphql
 *   node --experimental-strip-types resources/audit-default-values.ts [schema.graphql]
 *
 * When no schema file is provided, a built-in example schema is audited.
 * Exits with a non-zero code when any invalid default value is found.
 */
import fs from 'node:fs';

import {
  auditDefaultValues,
  formatDefaultValueAuditPath,
} from '../src/utilities/auditDefaultValues.ts';
import { buildSchema } from '../src/utilities/buildASTSchema.ts';

const exampleSDL = /* GraphQL */ `
  type Query {
    review(stars: Int = 5, tags: [String] = ["featured"]): String
  }
`;

const schemaPath = process.argv[2];

const schema =
  schemaPath === undefined
    ? buildSchema(exampleSDL)
    : buildSchema(fs.readFileSync(schemaPath, 'utf8'));

if (schemaPath === undefined) {
  console.log('No schema file provided, auditing built-in example schema.\n');
}

const report = auditDefaultValues(schema);

console.log(`Audited ${report.auditedCount} default value(s).`);

if (report.issues.length > 0) {
  console.log(`\nFound ${report.issues.length} invalid default value(s):`);
  for (const issue of report.issues) {
    console.log(
      `  - ${formatDefaultValueAuditPath(issue.path)}: ${issue.reason}`,
    );
  }
}

if (report.unknowns.length > 0) {
  console.log(
    `\nSkipped ${report.unknowns.length} default value(s) of custom scalars without an audit adapter:`,
  );
  for (const unknown of report.unknowns) {
    console.log(
      `  - ${formatDefaultValueAuditPath(unknown.path)}: ${unknown.reason}`,
    );
  }
}

if (report.issues.length === 0 && report.unknowns.length === 0) {
  console.log('All default values can be converted to valid literals.');
}

process.exitCode = report.issues.length === 0 ? 0 : 1;
