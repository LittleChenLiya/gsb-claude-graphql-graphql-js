import { expect } from 'chai';
import { describe, it } from 'node:test';

import { GraphQLError } from '../../error/GraphQLError.ts';

import { parse } from '../../language/parser.ts';
import type { ASTVisitor } from '../../language/visitor.ts';

import { GraphQLObjectType } from '../../type/definition.ts';
import { GraphQLString } from '../../type/scalars.ts';
import { GraphQLSchema } from '../../type/schema.ts';

import { buildSchema } from '../../utilities/buildASTSchema.ts';

import { checkSchemaUpgrade } from '../checkSchemaUpgrade.ts';
import type { ValidationContext } from '../ValidationContext.ts';

import {
  getConfig,
  getGuestsByRoleLiteral,
  getLegacy,
  getUsersByRoleWithDefault,
  getUserWithId,
  getUserWithoutId,
  getUserWithUnknownField,
  newSchemaSDL,
  oldSchemaSDL,
  searchMissingRequiredField,
  searchWithDefaultFilter,
  searchWithRemovedField,
  sharedFragmentDocument,
} from './fixtures/schemaUpgrade.ts';

const oldSchema = buildSchema(oldSchemaSDL);
const newSchema = buildSchema(newSchemaSDL);

describe('checkSchemaUpgrade', () => {
  it('reports a newly required argument as a regression, keeps valid queries passing, and marks old errors separately', () => {
    const getUserWithVariable = {
      name: 'GetUserVar',
      document: /* GraphQL */ `
        query GetUserVar($id: ID!) {
          user(id: $id) {
            id
          }
        }
      `,
    };

    const report = checkSchemaUpgrade(oldSchema, newSchema, [
      getUserWithoutId,
      getUserWithId,
      getUserWithUnknownField,
      getUserWithVariable,
    ]);

    expect(
      report.operations.map((operation) => [operation.name, operation.status]),
    ).to.deep.equal([
      ['GetUser', 'regressed'],
      ['GetUserWithId', 'valid'],
      ['GetUserTypo', 'previouslyInvalid'],
      ['GetUserVar', 'valid'],
    ]);

    // Regressions are reported in input operation order.
    expect(report.regressions.map((item) => item.operationName)).to.deep.equal([
      'GetUser',
    ]);
    expect(report.regressions).to.have.lengthOf(1);

    const [regression] = report.regressions;
    expect(regression.rule).to.equal('ProvidedRequiredArguments');
    expect(regression.message).to.equal(
      'Argument "Query.user(id:)" of type "ID!" is required, but it was not provided.',
    );
    expect(regression.locations).to.deep.equal([{ line: 3, column: 7 }]);
    expect(regression.oldType).to.equal('Query.user(id: ID): User');
    expect(regression.newType).to.equal('Query.user(id: ID!): User');

    // Documents already invalid under the old schema are not regressions.
    expect(report.preExisting).to.have.lengthOf(1);
    const [preExisting] = report.preExisting;
    expect(preExisting.operationName).to.equal('GetUserTypo');
    expect(preExisting.rule).to.equal('FieldsOnCorrectType');
    expect(preExisting.message).to.equal(
      'Cannot query field "nickname" on type "User". Did you mean "name"?',
    );
    expect(preExisting.locations).to.deep.equal([{ line: 5, column: 9 }]);
    expect(preExisting.oldType).to.equal('User.nickname');
    expect(preExisting.newType).to.equal('User.nickname');

    const typoResult = report.operations[2];
    expect(typoResult.diagnostics).to.deep.equal([]);
    expect(typoResult.preExistingDiagnostics).to.have.lengthOf(1);
  });

  it('accepts parsed documents as well as source text', () => {
    const report = checkSchemaUpgrade(oldSchema, newSchema, [
      {
        name: getUserWithId.name,
        document: parse(getUserWithId.document),
      },
    ]);

    expect(report.operations[0].status).to.equal('valid');
    expect(report.regressions).to.deep.equal([]);
  });

  it('attributes errors inside shared fragments to each operation using them', () => {
    const report = checkSchemaUpgrade(oldSchema, newSchema, [
      { name: 'GetUserA', document: sharedFragmentDocument },
      { name: 'GetUserB', document: sharedFragmentDocument },
    ]);

    expect(
      report.operations.map((operation) => operation.status),
    ).to.deep.equal(['regressed', 'regressed']);

    expect(report.regressions.map((item) => item.operationName)).to.deep.equal([
      'GetUserA',
      'GetUserB',
    ]);
    for (const diagnostic of report.regressions) {
      expect(diagnostic.rule).to.equal('ProvidedRequiredArguments');
      expect(diagnostic.locations).to.deep.equal([{ line: 3, column: 5 }]);
      expect(diagnostic.oldType).to.equal('Query.user(id: ID): User');
      expect(diagnostic.newType).to.equal('Query.user(id: ID!): User');
    }
  });

  it('selects operations by name from multi-operation documents', () => {
    const document = /* GraphQL */ `
      query First {
        user(id: "user-1") {
          id
        }
      }

      query Second {
        user {
          id
        }
      }
    `;

    const first = checkSchemaUpgrade(oldSchema, newSchema, [
      { name: 'First', document },
    ]);
    expect(first.operations[0].status).to.equal('valid');

    const second = checkSchemaUpgrade(oldSchema, newSchema, [
      { name: 'Second', document },
    ]);
    expect(second.operations[0].status).to.equal('regressed');
    expect(second.regressions[0].operationName).to.equal('Second');
  });

  it('reports invalid variable default values after enum narrowing', () => {
    const report = checkSchemaUpgrade(oldSchema, newSchema, [
      getUsersByRoleWithDefault,
    ]);

    expect(report.operations[0].status).to.equal('regressed');
    const [diagnostic] = report.regressions;
    expect(diagnostic.rule).to.equal('ValuesOfCorrectType');
    expect(diagnostic.message).to.equal(
      'Value "GUEST" does not exist in "Role" enum. Did you mean the enum value "USER"?',
    );
    expect(diagnostic.locations).to.deep.equal([{ line: 2, column: 40 }]);
    expect(diagnostic.oldType).to.equal('enum Role { ADMIN USER GUEST }');
    expect(diagnostic.newType).to.equal('enum Role { ADMIN USER }');
  });

  it('reports removed enum values used as argument literals', () => {
    const report = checkSchemaUpgrade(oldSchema, newSchema, [
      getGuestsByRoleLiteral,
    ]);

    expect(report.operations[0].status).to.equal('regressed');
    const [diagnostic] = report.regressions;
    expect(diagnostic.rule).to.equal('ValuesOfCorrectType');
    expect(diagnostic.locations).to.deep.equal([{ line: 3, column: 25 }]);
    expect(diagnostic.oldType).to.equal('enum Role { ADMIN USER GUEST }');
    expect(diagnostic.newType).to.equal('enum Role { ADMIN USER }');
  });

  it('describes scalar variable types when reporting regressions', () => {
    const report = checkSchemaUpgrade(oldSchema, newSchema, [
      {
        name: 'GetUserConditional',
        document: /* GraphQL */ `
          query GetUserConditional($flag: Boolean!) {
            user @include(if: $flag) {
              id
            }
          }
        `,
      },
    ]);

    expect(report.operations[0].status).to.equal('regressed');
    const [diagnostic] = report.regressions;
    expect(diagnostic.rule).to.equal('ProvidedRequiredArguments');
    expect(diagnostic.oldType).to.equal('Query.user(id: ID): User');
    expect(diagnostic.newType).to.equal('Query.user(id: ID!): User');
  });

  it('reports removed input object fields', () => {
    const report = checkSchemaUpgrade(oldSchema, newSchema, [
      searchWithRemovedField,
    ]);

    expect(report.operations[0].status).to.equal('regressed');
    const [diagnostic] = report.regressions;
    expect(diagnostic.rule).to.equal('ValuesOfCorrectType');
    expect(diagnostic.message).to.equal(
      'Expected value of type "SearchFilter" not to include unknown field "tags", found: { term: "graphql", tags: ["a", "b"] }.',
    );
    expect(diagnostic.locations).to.deep.equal([{ line: 3, column: 41 }]);
    expect(diagnostic.oldType).to.equal('tags: [String]');
    expect(diagnostic.newType).to.equal(undefined);
  });

  it('reports newly required input object fields', () => {
    const report = checkSchemaUpgrade(oldSchema, newSchema, [
      searchMissingRequiredField,
    ]);

    expect(report.operations[0].status).to.equal('regressed');
    const [diagnostic] = report.regressions;
    expect(diagnostic.rule).to.equal('ValuesOfCorrectType');
    expect(diagnostic.message).to.equal(
      'Expected value of type "SearchFilter" to include required field "term", found: { limit: 10 }.',
    );
    expect(diagnostic.locations).to.deep.equal([{ line: 3, column: 22 }]);
    expect(diagnostic.oldType).to.equal(
      'input SearchFilter { term: String, limit: Int, tags: [String] }',
    );
    expect(diagnostic.newType).to.equal(
      'input SearchFilter { term: String!, limit: Int }',
    );
  });

  it('reports invalid input object fields in variable default values', () => {
    const report = checkSchemaUpgrade(oldSchema, newSchema, [
      searchWithDefaultFilter,
    ]);

    expect(report.operations[0].status).to.equal('regressed');
    const [diagnostic] = report.regressions;
    expect(diagnostic.rule).to.equal('ValuesOfCorrectType');
    expect(diagnostic.locations).to.deep.equal([{ line: 3, column: 44 }]);
    expect(diagnostic.oldType).to.equal('tags: [String]');
    expect(diagnostic.newType).to.equal(undefined);
  });

  it('reports changed field return types', () => {
    const report = checkSchemaUpgrade(oldSchema, newSchema, [getConfig]);

    expect(report.operations[0].status).to.equal('regressed');
    const [diagnostic] = report.regressions;
    expect(diagnostic.rule).to.equal('ScalarLeafs');
    expect(diagnostic.message).to.equal(
      'Field "config" must not have a selection since type "String" has no subfields.',
    );
    expect(diagnostic.locations).to.deep.equal([{ line: 3, column: 14 }]);
    expect(diagnostic.oldType).to.equal('Query.config: Config');
    expect(diagnostic.newType).to.equal('Query.config: String');
  });

  it('reports removed arguments', () => {
    const report = checkSchemaUpgrade(oldSchema, newSchema, [getLegacy]);

    expect(report.operations[0].status).to.equal('regressed');
    const [diagnostic] = report.regressions;
    expect(diagnostic.rule).to.equal('KnownArgumentNames');
    expect(diagnostic.message).to.equal(
      'Unknown argument "mode" on field "Query.legacy".',
    );
    expect(diagnostic.locations).to.deep.equal([{ line: 3, column: 14 }]);
    expect(diagnostic.oldType).to.equal('mode: Mode');
    expect(diagnostic.newType).to.equal(undefined);
  });

  it('never executes field resolvers', () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          greeting: {
            type: GraphQLString,
            resolve() {
              throw new Error('Resolver must not be executed.');
            },
          },
        },
      }),
    });

    const report = checkSchemaUpgrade(schema, schema, [
      { name: 'Hello', document: 'query Hello { greeting }' },
    ]);

    expect(report.operations[0].status).to.equal('valid');
    expect(report.regressions).to.deep.equal([]);
  });

  it('throws when the named operation is missing from the document', () => {
    expect(() =>
      checkSchemaUpgrade(oldSchema, newSchema, [
        { name: 'Missing', document: '{ user { id } }' },
      ]),
    ).to.throw('Document does not contain an operation named "Missing".');

    expect(() =>
      checkSchemaUpgrade(oldSchema, newSchema, [
        { name: 'Missing', document: 'schema { query: Query }' },
      ]),
    ).to.throw('Document does not contain an operation named "Missing".');
  });

  it('supports custom rule sets and reports rule names verbatim', () => {
    function alwaysFails(context: ValidationContext): ASTVisitor {
      return {
        Document() {
          context.reportError(new GraphQLError('Always fails.'));
        },
      };
    }

    const report = checkSchemaUpgrade(oldSchema, newSchema, [getUserWithId], {
      rules: [alwaysFails],
    });

    expect(report.operations[0].status).to.equal('previouslyInvalid');
    expect(report.regressions).to.deep.equal([]);

    const [diagnostic] = report.preExisting;
    expect(diagnostic.rule).to.equal('alwaysFails');
    expect(diagnostic.message).to.equal('Always fails.');
    expect(diagnostic.locations).to.deep.equal([]);
    expect(diagnostic.oldType).to.equal(undefined);
    expect(diagnostic.newType).to.equal(undefined);
  });

  it('handles unknown fragments, repeated spreads, and nested fragments', () => {
    const unknownFragment = checkSchemaUpgrade(oldSchema, newSchema, [
      { name: 'Broken', document: 'query Broken { ...Missing }' },
    ]);
    expect(unknownFragment.operations[0].status).to.equal('previouslyInvalid');
    expect(unknownFragment.preExisting[0].rule).to.equal('KnownFragmentNames');

    const document = /* GraphQL */ `
      query Valid {
        user(id: "user-1") {
          ...Bits
          ...Bits
          ... on User {
            name
          }
        }
      }

      fragment Bits on User {
        ...MoreBits
      }

      fragment MoreBits on User {
        id
      }
    `;
    const valid = checkSchemaUpgrade(oldSchema, newSchema, [
      { name: 'Valid', document },
    ]);
    expect(valid.operations[0].status).to.equal('valid');
  });

  it('reports fields on unknown parents without a type context', () => {
    const report = checkSchemaUpgrade(oldSchema, newSchema, [
      { name: 'Broken', document: 'query Broken { missing { sub } }' },
    ]);

    expect(report.operations[0].status).to.equal('previouslyInvalid');
    const [diagnostic] = report.preExisting;
    expect(diagnostic.rule).to.equal('FieldsOnCorrectType');
    expect(diagnostic.message).to.contain(
      'Cannot query field "missing" on type "Query".',
    );
    expect(diagnostic.oldType).to.equal('Query.missing');
  });

  it('reports variables whose type was removed from the new schema', () => {
    const oldSchemaWithLegacy = buildSchema(/* GraphQL */ `
      input Legacy {
        x: Int
      }

      type Query {
        legacy(filter: Legacy): String
      }
    `);
    const newSchemaWithoutLegacy = buildSchema(/* GraphQL */ `
      type Query {
        legacy: String
      }
    `);

    const report = checkSchemaUpgrade(
      oldSchemaWithLegacy,
      newSchemaWithoutLegacy,
      [
        {
          name: 'UseLegacy',
          document:
            'query UseLegacy($filter: Legacy) { legacy(filter: $filter) }',
        },
      ],
    );

    expect(report.operations[0].status).to.equal('regressed');
    const rules = report.regressions.map((diagnostic) => diagnostic.rule);
    expect(rules).to.include('KnownTypeNames');
  });
});
