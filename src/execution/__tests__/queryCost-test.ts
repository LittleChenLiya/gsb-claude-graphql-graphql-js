import { describe, it } from 'node:test';

import { expect } from 'chai';

import { parse } from '../../language/parser.ts';

import { GraphQLObjectType } from '../../type/definition.ts';
import { GraphQLString } from '../../type/scalars.ts';
import { GraphQLSchema } from '../../type/schema.ts';

import { buildSchema } from '../../utilities/buildASTSchema.ts';

import type {
  QueryCostConfig,
  QueryCostEstimate,
  QueryCostResult,
} from '../queryCost.ts';
import { estimateQueryCost } from '../queryCost.ts';

const schema = buildSchema(`
  type Query {
    users(first: Int!): [User!]!
    pagedUsers(first: Int): [User!]!
    ratioUsers(ratio: Float): [User!]!
    tokenUsers(token: String): [User!]!
    node: Node
    search: SearchResult
    greeting: String
  }

  interface Node {
    id: ID!
  }

  type Photo implements Node {
    id: ID!
  }

  type User implements Node {
    id: ID!
    name: String
  }

  union SearchResult = User | Photo

  type Mutation {
    updateName: String
  }

  type Subscription {
    nameChanged: String
  }
`);

const listConfig = { argumentName: 'first', defaultLimit: 10, maxLimit: 100 };

function estimate(
  query: string,
  options?: {
    operationName?: string;
    variableValues?: { readonly [variable: string]: unknown };
    costConfig?: QueryCostConfig;
  },
): QueryCostResult {
  return estimateQueryCost({
    schema,
    document: parse(query),
    operationName: options?.operationName,
    variableValues: options?.variableValues,
    costConfig: options?.costConfig ?? { list: listConfig },
  });
}

function expectEstimate(
  query: string,
  options?: {
    operationName?: string;
    variableValues?: { readonly [variable: string]: unknown };
    costConfig?: QueryCostConfig;
  },
): QueryCostEstimate {
  const result = estimate(query, options);
  if ('errors' in result) {
    expect.fail(
      'Expected a cost estimate, got errors: ' +
        result.errors.map((error) => error.message).join(', '),
    );
  }
  return result.estimate;
}

function expectErrors(
  query: string,
  options?: {
    operationName?: string;
    variableValues?: { readonly [variable: string]: unknown };
    costConfig?: QueryCostConfig;
  },
): ReadonlyArray<string> {
  const result = estimate(query, options);
  if ('estimate' in result) {
    expect.fail('Expected errors, got a cost estimate.');
  }
  return result.errors.map((error) => error.message);
}

describe('estimateQueryCost', () => {
  it('estimates a list field as 1 + n times the sub-selection cost', () => {
    const result = expectEstimate('{ users(first: 2) { id name } }');

    expect(result.totalCost).to.equal(5);
    expect(result.costTree).to.deep.equal([
      {
        responseKey: 'users',
        path: 'users',
        cost: 5,
        children: [
          { responseKey: 'id', path: 'users.id', cost: 1, children: [] },
          { responseKey: 'name', path: 'users.name', cost: 1, children: [] },
        ],
      },
    ]);
    expect(result.diagnostics).to.deep.equal([]);
  });

  it('does not charge fields skipped via @skip or @include', () => {
    expect(
      expectEstimate('{ users(first: 2) { id name @skip(if: true) } }')
        .totalCost,
    ).to.equal(3);
    expect(
      expectEstimate('{ users(first: 2) { id name @include(if: false) } }')
        .totalCost,
    ).to.equal(3);
  });

  it('uses coerced variable values for @skip and @include', () => {
    const query =
      'query ($skipName: Boolean!) {' +
      ' users(first: 2) { id name @skip(if: $skipName) } }';

    expect(
      expectEstimate(query, { variableValues: { skipName: true } }).totalCost,
    ).to.equal(3);
    expect(
      expectEstimate(query, { variableValues: { skipName: false } }).totalCost,
    ).to.equal(5);
  });

  it('charges different aliases separately', () => {
    const result = expectEstimate(
      '{ a: users(first: 2) { id name } b: users(first: 2) { id name } }',
    );

    expect(result.totalCost).to.equal(10);
  });

  it('merges repeated fragment spreads like response fields', () => {
    const result = expectEstimate(`
      { users(first: 1) { ...F ...F } }
      fragment F on User { id name }
    `);

    expect(result.totalCost).to.equal(3);
  });

  it('merges identical fields from different fragments', () => {
    const result = expectEstimate(`
      { users(first: 1) { ...A ...B } }
      fragment A on User { id name }
      fragment B on User { name }
    `);

    expect(result.totalCost).to.equal(3);
  });

  it('charges the maximum cost over concrete types of an interface', () => {
    const result = expectEstimate('{ node { id ... on User { name } } }');

    expect(result.totalCost).to.equal(3);
  });

  it('charges the maximum cost over concrete types of a union', () => {
    const result = expectEstimate(
      '{ search { ... on User { id name } ... on Photo { id } } }',
    );

    expect(result.totalCost).to.equal(3);
  });

  it('estimates mutation and subscription operations', () => {
    expect(expectEstimate('mutation { updateName }').totalCost).to.equal(1);
    expect(expectEstimate('subscription { nameChanged }').totalCost).to.equal(
      1,
    );
  });

  it('selects the operation by name', () => {
    const result = expectEstimate(
      'query A { greeting } query B { greeting node { id } }',
      { operationName: 'B' },
    );

    expect(result.totalCost).to.equal(3);
  });

  it('reports an error when the operation name is missing', () => {
    const messages = expectErrors('query A { greeting } query B { greeting }');

    expect(messages).to.deep.equal([
      'Must provide operation name if query contains multiple operations.',
    ]);
  });

  it('reports an error for an unknown operation name', () => {
    const messages = expectErrors('query A { greeting }', {
      operationName: 'C',
    });

    expect(messages).to.deep.equal(['Unknown operation named "C".']);
  });

  it('reports validation errors', () => {
    const messages = expectErrors('{ users(first: 1) { missing } }');

    expect(messages).to.deep.equal([
      'Cannot query field "missing" on type "User".',
    ]);
  });

  it('reports variable coercion errors', () => {
    const query = 'query ($first: Int!) { users(first: $first) { id } }';

    expect(expectErrors(query)[0]).to.include('Variable "$first"');
    expect(
      expectErrors(query, { variableValues: { first: 'abc' } })[0],
    ).to.include('Variable "$first" has invalid value');
  });

  it('uses the default limit when the list size argument is not provided', () => {
    expect(expectEstimate('{ pagedUsers { id } }').totalCost).to.equal(11);
  });

  it('rejects negative or over-limit list size estimates', () => {
    expect(expectErrors('{ users(first: -1) { id } }')[0]).to.include(
      'List size argument "first" of field "users" must be an integer between 0 and 100, got: -1.',
    );
    expect(expectErrors('{ users(first: 101) { id } }')[0]).to.include(
      'must be an integer between 0 and 100, got: 101.',
    );
  });

  it('rejects non-integer list size estimates', () => {
    const costConfig = {
      list: { argumentName: 'ratio', defaultLimit: 10, maxLimit: 100 },
    };

    expect(
      expectErrors('{ ratioUsers(ratio: 1.5) { id } }', { costConfig })[0],
    ).to.include('must be an integer between 0 and 100, got: 1.5.');
  });

  it('rejects non-numeric list size estimates', () => {
    const costConfig = {
      list: { argumentName: 'token', defaultLimit: 10, maxLimit: 100 },
    };

    expect(
      expectErrors('{ tokenUsers(token: "abc") { id } }', { costConfig })[0],
    ).to.include('must be an integer between 0 and 100, got: "abc".');
  });

  it('rejects list fields without a list cost configuration', () => {
    const messages = expectErrors('{ users(first: 1) { id } }', {
      costConfig: {},
    });

    expect(messages).to.deep.equal([
      'Cannot estimate the cost of list field "users" without a "list" cost configuration.',
    ]);
  });

  it('rejects estimates that overflow safe integer arithmetic', () => {
    const costConfig = {
      list: {
        argumentName: 'ratio',
        defaultLimit: 10,
        maxLimit: Number.MAX_SAFE_INTEGER,
      },
    };
    const huge = Number.MAX_SAFE_INTEGER;

    expect(
      expectErrors(`{ ratioUsers(ratio: ${huge}) { id name } }`, {
        costConfig,
      })[0],
    ).to.include('overflowed the maximum safe integer');
    expect(
      expectErrors(`{ ratioUsers(ratio: ${huge}) { id } }`, {
        costConfig,
      })[0],
    ).to.include('overflowed the maximum safe integer');
  });

  it('aborts when the expansion work limit is exceeded', () => {
    const messages = expectErrors('{ users(first: 1) { id name } }', {
      costConfig: { list: listConfig, maxFields: 2 },
    });

    expect(messages).to.deep.equal([
      'Query cost estimation aborted after expanding 2 fields; the operation is too large to estimate.',
    ]);
  });

  it('reports no diagnostics when the budget equals the cost', () => {
    const result = expectEstimate('{ users(first: 2) { id name } }', {
      costConfig: { list: listConfig, maxCost: 5 },
    });

    expect(result.totalCost).to.equal(5);
    expect(result.diagnostics).to.deep.equal([]);
  });

  it('reports the exceeding path when the budget is below the cost', () => {
    const result = expectEstimate('{ users(first: 2) { id name } }', {
      costConfig: { list: listConfig, maxCost: 4 },
    });

    expect(result.totalCost).to.equal(5);
    expect(result.diagnostics).to.deep.equal([
      {
        path: 'users.name',
        message:
          'Estimated query cost exceeds the budget of 4 at path "users.name".',
      },
    ]);
  });

  it('supports a custom fixed field cost', () => {
    const result = expectEstimate('{ users(first: 1) { id } }', {
      costConfig: { fieldCost: 2, list: listConfig },
    });

    expect(result.totalCost).to.equal(4);
  });

  it('estimates queries without a cost config', () => {
    const result = estimateQueryCost({
      schema,
      document: parse('{ greeting }'),
    });

    if ('errors' in result) {
      expect.fail('Expected a cost estimate, got errors.');
    }
    expect(result.estimate.totalCost).to.equal(1);
  });

  it('does not execute resolvers', () => {
    const throwingSchema = new GraphQLSchema({
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

    const result = estimateQueryCost({
      schema: throwingSchema,
      document: parse('{ greeting }'),
    });

    if ('errors' in result) {
      expect.fail('Expected a cost estimate, got errors.');
    }
    expect(result.estimate.totalCost).to.equal(1);
  });
});
