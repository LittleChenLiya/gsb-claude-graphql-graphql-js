import { describe, it } from 'node:test';

import { expect } from 'chai';

import { GraphQLError } from '../../error/GraphQLError.ts';

import { parse } from '../../language/parser.ts';

import { buildSchema } from '../../utilities/buildASTSchema.ts';

import type {
  NamedOperationDocument,
  SchemaUpgradeReport,
} from '../checkSchemaUpgrade.ts';
import { checkSchemaUpgrade } from '../checkSchemaUpgrade.ts';
import { FieldsOnCorrectTypeRule } from '../rules/FieldsOnCorrectTypeRule.ts';
import type { ValidationRule } from '../ValidationContext.ts';

import {
  newSchemaSDL,
  oldSchemaSDL,
  operations,
} from './fixtures/schemaUpgrade.ts';

const oldSchema = buildSchema(oldSchemaSDL);
const newSchema = buildSchema(newSchemaSDL);

function check(
  names: ReadonlyArray<string>,
  options?: { operationName?: string; rules?: ReadonlyArray<ValidationRule> },
): SchemaUpgradeReport {
  const documents: Array<NamedOperationDocument> = names.map((name) => {
    const named: NamedOperationDocument = {
      name,
      document: parse(operations[name]),
    };
    if (options?.operationName !== undefined) {
      named.operationName = options.operationName;
    }
    return named;
  });
  return checkSchemaUpgrade(oldSchema, newSchema, documents, options);
}

describe('checkSchemaUpgrade', () => {
  it('reports newly required arguments as regressions in input order', () => {
    const report = check(['unknownField', 'noArgument', 'explicitId']);

    expect(report.compatible).to.equal(false);

    // The explicitly passing query produces no diagnostics at all, and the
    // already broken document produces no regressions.
    expect(report.regressions).to.have.lengthOf(1);
    const regression = report.regressions[0];
    expect(regression.documentName).to.equal('noArgument');
    expect(regression.operationName).to.equal('GetUser');
    expect(regression.rule).to.equal('ProvidedRequiredArgumentsRule');
    expect(regression.message).to.equal(
      'Argument "Query.user(id:)" of type "ID!" is required, but it was not provided.',
    );
    expect(regression.field).to.equal('Query.user');
    expect(regression.argument).to.equal('id');
    expect(regression.variable).to.equal(undefined);
    expect(regression.oldType).to.equal('ID');
    expect(regression.newType).to.equal('ID!');
    expect(regression.locations).to.have.lengthOf(1);
    expect(regression.locations[0]).to.deep.include({ line: 3, column: 7 });
  });

  it('flags documents that were already invalid as pre-existing errors', () => {
    const report = check(['unknownField']);

    expect(report.compatible).to.equal(true);
    expect(report.regressions).to.deep.equal([]);

    const rules = report.preExisting.map((diagnostic) => diagnostic.rule);
    expect(rules).to.deep.equal([
      'FieldsOnCorrectTypeRule',
      'UniqueArgumentNamesRule',
    ]);

    const [unknownField, duplicateArgument] = report.preExisting;
    expect(unknownField.operationName).to.equal('GetBroken');
    expect(unknownField.field).to.equal('Query.unknownField');
    expect(unknownField.oldType).to.equal(undefined);
    expect(unknownField.newType).to.equal(undefined);
    // The duplicated argument sits on a field below an unknown parent, so
    // no field coordinate can be determined for it.
    expect(duplicateArgument.field).to.equal(undefined);
    expect(duplicateArgument.message).to.equal(
      'There can be only one argument named "arg".',
    );
  });

  it('reports nullable variables used for newly required arguments', () => {
    const report = check(['nullableIdVariable']);

    expect(report.regressions).to.have.lengthOf(1);
    const regression = report.regressions[0];
    expect(regression.rule).to.equal('VariablesInAllowedPositionRule');
    expect(regression.operationName).to.equal('GetUser');
    expect(regression.field).to.equal('Query.user');
    expect(regression.argument).to.equal('id');
    expect(regression.variable).to.equal('id');
    expect(regression.oldType).to.equal('ID');
    expect(regression.newType).to.equal('ID!');
  });

  it('attributes shared fragments to each operation separately', () => {
    const report = check(['sharedFragment']);

    expect(
      report.regressions.map((diagnostic) => diagnostic.operationName),
    ).to.deep.equal(['FirstStatus', 'SecondStatus']);
    for (const regression of report.regressions) {
      expect(regression.documentName).to.equal('sharedFragment');
      expect(regression.rule).to.equal('ScalarLeafsRule');
      expect(regression.field).to.equal('Query.status');
      expect(regression.oldType).to.equal('String');
      expect(regression.newType).to.equal('Status');
    }
  });

  it('selects a single operation when an operation name is given', () => {
    const kept = check(['multiOperation'], { operationName: 'KeepVersion' });
    expect(kept.compatible).to.equal(true);
    expect(kept.regressions).to.deep.equal([]);
    expect(kept.preExisting).to.deep.equal([]);

    const dropped = check(['multiOperation'], { operationName: 'DropStatus' });
    expect(dropped.regressions).to.have.lengthOf(1);
    expect(dropped.regressions[0].operationName).to.equal('DropStatus');
  });

  it('throws when the selected operation does not exist', () => {
    expect(() =>
      check(['multiOperation'], { operationName: 'Missing' }),
    ).to.throw(
      'Document "multiOperation" does not contain an operation named "Missing".',
    );
  });

  it('covers variable default values narrowed by an enum', () => {
    const report = check(['variableDefault']);

    expect(report.regressions).to.have.lengthOf(1);
    const regression = report.regressions[0];
    expect(regression.rule).to.equal('ValuesOfCorrectTypeRule');
    expect(regression.variable).to.equal('role');
    expect(regression.field).to.equal(undefined);
    expect(regression.message).to.include('GUEST');
  });

  it('covers newly required input object fields', () => {
    const report = check(['inputObject']);

    expect(report.regressions).to.have.lengthOf(1);
    const regression = report.regressions[0];
    expect(regression.rule).to.equal('ValuesOfCorrectTypeRule');
    expect(regression.field).to.equal('Query.users');
    expect(regression.argument).to.equal('filter');
    expect(regression.oldType).to.equal(undefined);
    expect(regression.newType).to.equal(undefined);
    expect(regression.message).to.include('required field "tag"');
  });

  it('covers enum narrowing of literal argument values', () => {
    const report = check(['enumLiteral']);

    expect(report.regressions).to.have.lengthOf(1);
    const regression = report.regressions[0];
    expect(regression.rule).to.equal('ValuesOfCorrectTypeRule');
    expect(regression.field).to.equal('Query.users');
    expect(regression.argument).to.equal('role');
    expect(regression.message).to.include('GUEST');
  });

  it('covers field return type changes from object to scalar', () => {
    const report = check(['category']);

    expect(report.regressions).to.have.lengthOf(1);
    const regression = report.regressions[0];
    expect(regression.rule).to.equal('ScalarLeafsRule');
    expect(regression.field).to.equal('Query.category');
    expect(regression.oldType).to.equal('Category');
    expect(regression.newType).to.equal('String');
  });

  it('covers removed fields', () => {
    const report = check(['removedField']);

    expect(report.regressions).to.have.lengthOf(1);
    const regression = report.regressions[0];
    expect(regression.rule).to.equal('FieldsOnCorrectTypeRule');
    expect(regression.field).to.equal('User.nickname');
    expect(regression.oldType).to.equal('String');
    expect(regression.newType).to.equal(undefined);
  });

  it('covers fields on types that only exist in the new schema', () => {
    const report = check(['newType']);

    expect(report.regressions).to.have.lengthOf(1);
    const regression = report.regressions[0];
    expect(regression.rule).to.equal('ProvidedRequiredArgumentsRule');
    expect(regression.field).to.equal('Thing.label');
    expect(regression.argument).to.equal('code');
    expect(regression.oldType).to.equal(undefined);
    expect(regression.newType).to.equal('String!');

    // The same document was already invalid against the old schema.
    expect(report.preExisting).to.have.lengthOf(1);
    expect(report.preExisting[0].rule).to.equal('FieldsOnCorrectTypeRule');
  });

  it('attributes anonymous operations without a name', () => {
    const report = check(['anonymous']);

    expect(report.regressions).to.have.lengthOf(1);
    expect(report.regressions[0].operationName).to.equal(undefined);
    expect(report.regressions[0].rule).to.equal('ScalarLeafsRule');
  });

  it('locates variables that are not defined by the operation', () => {
    const report = check(['undefinedVariable']);

    expect(report.compatible).to.equal(true);
    expect(report.regressions).to.deep.equal([]);
    expect(report.preExisting).to.have.lengthOf(1);
    const diagnostic = report.preExisting[0];
    expect(diagnostic.rule).to.equal('NoUndefinedVariablesRule');
    expect(diagnostic.variable).to.equal('missing');
    expect(diagnostic.field).to.equal('Query.user');
    expect(diagnostic.argument).to.equal('id');
  });

  it('lists the breaking and dangerous schema changes', () => {
    const report = check(['explicitId']);

    expect(report.compatible).to.equal(true);
    expect(
      report.breakingChanges.map((change) => change.type),
    ).to.include.members([
      'TYPE_REMOVED',
      'VALUE_REMOVED_FROM_ENUM',
      'REQUIRED_INPUT_FIELD_ADDED',
      'FIELD_REMOVED',
      'FIELD_CHANGED_KIND',
      'ARG_CHANGED_KIND',
    ]);
    expect(report.dangerousChanges).to.deep.equal([]);
  });

  it('supports a custom list of validation rules', () => {
    const report = check(['removedField'], {
      rules: [FieldsOnCorrectTypeRule],
    });

    expect(report.regressions).to.have.lengthOf(1);
    expect(report.regressions[0].rule).to.equal('FieldsOnCorrectTypeRule');
  });

  it('locates fields on union parent types without field details', () => {
    const typenameRule: ValidationRule = (context) => ({
      Field(node) {
        if (node.name.value === '__typename') {
          context.reportError(
            new GraphQLError('No typename allowed.', { nodes: [node] }),
          );
        }
      },
    });
    const schemaSDL = /* GraphQL */ `
      union SearchResult = User
      type User {
        id: ID
      }
      type Query {
        search: SearchResult
      }
    `;
    const report = checkSchemaUpgrade(
      buildSchema(schemaSDL),
      buildSchema(schemaSDL),
      [
        {
          name: 'unionDoc',
          document: parse('{ search { ... on SearchResult { __typename } } }'),
        },
      ],
      { rules: [typenameRule] },
    );

    expect(report.regressions).to.deep.equal([]);
    expect(report.preExisting).to.have.lengthOf(1);
    const diagnostic = report.preExisting[0];
    expect(diagnostic.field).to.equal('SearchResult.__typename');
    expect(diagnostic.oldType).to.equal(undefined);
    expect(diagnostic.newType).to.equal(undefined);
  });

  it('handles custom rules that report errors without nodes', () => {
    const noNodesRule: ValidationRule = (context) => ({
      Document() {
        context.reportError(new GraphQLError('Always broken.'));
      },
    });

    const report = check(['explicitId'], { rules: [noNodesRule] });

    expect(report.compatible).to.equal(true);
    expect(report.regressions).to.deep.equal([]);
    expect(report.preExisting).to.have.lengthOf(1);
    const diagnostic = report.preExisting[0];
    expect(diagnostic.rule).to.equal('noNodesRule');
    expect(diagnostic.message).to.equal('Always broken.');
    expect(diagnostic.locations).to.deep.equal([]);
    expect(diagnostic.field).to.equal(undefined);
    expect(diagnostic.argument).to.equal(undefined);
    expect(diagnostic.variable).to.equal(undefined);
  });
});
