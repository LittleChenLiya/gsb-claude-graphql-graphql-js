/**
 * Audits default values in a GraphQL schema for conversion to valid literals.
 *
 * Usage:
 *   node --experimental-strip-types resources/audit-default-values.ts <schema.graphql>
 *
 * Exits with code 1 when one or more problems are found, 0 otherwise.
 */

import fs from 'node:fs';
import path from 'node:path';

import { auditDefaultValues } from '../src/utilities/auditDefaultValues.ts';
import { buildSchema } from '../src/utilities/buildASTSchema.ts';

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      'Usage: audit-default-values <schema.graphql> [schema2.graphql ...]',
    );
    process.exitCode = 2;
    return;
  }

  let hasIssues = false;

  for (const schemaPath of args) {
    const resolvedPath = path.resolve(schemaPath);
    const source = fs.readFileSync(resolvedPath, 'utf8');
    const schema = buildSchema(source, { noLocation: false });

    const issues = auditDefaultValues(schema);

    if (issues.length === 0) {
      console.log(`${schemaPath}: no problems found.`);
      continue;
    }

    hasIssues = true;
    console.log(
      `${schemaPath}: found ${issues.length} default value problem(s):`,
    );
    for (const issue of issues) {
      console.log(`  [${issue.type}] ${issue.message}`);
    }
  }

  if (hasIssues) {
    process.exitCode = 1;
  }
}

main();
