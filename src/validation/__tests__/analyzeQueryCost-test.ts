import { describe, it } from 'node:test';

import { expect } from 'chai';

import { parse } from '../../language/parser.ts';

import {
  GraphQLInterfaceType,
  GraphQLObjectType,
  GraphQLUnionType,
} from '../../type/definition.ts';
import { GraphQLString } from '../../type/scalars.ts';
import { GraphQLSchema } from '../../type/schema.ts';

import { buildSchema } from '../../utilities/buildASTSchema.ts';

import type { QueryCostConfig } from '../analyzeQueryCost.ts';
import { analyzeQueryCost } from '../analyzeQueryCost.ts';

const schemaSDL = `
  type User {
    id: ID
    name: String
  }

  type Query {
    users(first: Int = 10): [User]
    scalarField: String
    container(first: Int = 10): [Container]
  }

  type Container {
    users(first: Int = 10): [User]
  }
`;

function analyze(
  query: string,
  config: QueryCostConfig = {},
  variableValues?: { readonly [key: string]: unknown },
  operationName?: string,
) {
  return analyzeQueryCost(
    buildTestSchema(),
    parse(query),
    operationName,
    variableValues ?? {},
    config,
  );
}

function buildTestSchema(): GraphQLSchema {
  return buildSchema(schemaSDL);
}

const usersListConfig: QueryCostConfig = {
  fields: {
    'Query.users': {
      list: { argument: 'first', defaultCount: 10, maxCount: 100 },
    },
  },
};

describe('analyzeQueryCost', () => {
  it('charges 1 + n times the subtree cost for list fields', () => {
    const result = analyze('{ users(first: 2) { id name } }', usersListConfig);
    expect('errors' in result).to.equal(false);
    if ('errors' in result) {
      return;
    }
    expect(result.totalCost).to.equal(5);
    expect(result.withinBudget).to.equal(true);
    expect(result.costTree).to.have.lengthOf(1);

    const users = result.costTree[0];
    expect(users.key).to.equal('users');
    expect(users.fixedCost).to.equal(1);
    expect(users.listCount).to.equal(2);
    expect(users.multiplicity).to.equal(1);
    expect(users.cost).to.equal(5);
    expect(users.children?.map((child) => child.key)).to.deep.equal([
      'id',
      'name',
    ]);
    expect(users.children?.map((child) => child.cost)).to.deep.equal([2, 2]);
    expect(users.children?.map((child) => child.multiplicity)).to.deep.equal([
      2, 2,
    ]);
  });

  it('does not bill fields skipped by @skip with a coerced variable', () => {
    const result = analyze(
      'query ($skip: Boolean!) { users(first: 2) { id name @skip(if: $skip) } }',
      usersListConfig,
      { skip: true },
    );
    if ('errors' in result) {
      throw result.errors[0];
    }
    expect(result.totalCost).to.equal(3);
    expect(
      result.costTree[0].children?.map((child) => child.key),
    ).to.deep.equal(['id']);
  });

  it('bills distinct aliases independently', () => {
    const result = analyze(
      '{ a: users(first: 2) { id name } b: users(first: 2) { id name } }',
      usersListConfig,
    );
    if ('errors' in result) {
      throw result.errors[0];
    }
    expect(result.totalCost).to.equal(10);
    expect(result.costTree.map((node) => node.key)).to.deep.equal(['a', 'b']);
  });

  it('merges repeated fragment spreads by response field', () => {
    const result = analyze(
      `
        fragment UserFields on User { id name }
        { users(first: 2) { ...UserFields ...UserFields id } }
      `,
      usersListConfig,
    );
    if ('errors' in result) {
      throw result.errors[0];
    }
    expect(result.totalCost).to.equal(5);
    expect(
      result.costTree[0].children?.map((child) => child.key),
    ).to.deep.equal(['id', 'name']);
  });

  it('does not bill fragment spreads removed by @skip', () => {
    const result = analyze(
      `
        fragment UserFields on User { id name }
        query ($skip: Boolean!) {
          users(first: 2) { ...UserFields @skip(if: $skip) }
        }
      `,
      usersListConfig,
      { skip: true },
    );
    if ('errors' in result) {
      throw result.errors[0];
    }
    expect(result.totalCost).to.equal(1);
  });

  it('requires an operation name when the document contains several', () => {
    const document = parse(`
      query One { users(first: 1) { id } }
      query Two { users(first: 1) { id name } }
    `);
    const result = analyzeQueryCost(
      buildTestSchema(),
      document,
      undefined,
      {},
      usersListConfig,
    );
    expect('errors' in result).to.equal(true);
    if ('errors' in result) {
      expect(result.errors[0].message).to.equal(
        'Must provide operation name if query contains multiple operations.',
      );
    }

    const selected = analyzeQueryCost(
      buildTestSchema(),
      document,
      'Two',
      {},
      usersListConfig,
    );
    if ('errors' in selected) {
      throw selected.errors[0];
    }
    expect(selected.totalCost).to.equal(3);
  });

  it('reports unknown operation names', () => {
    const result = analyze(
      '{ users(first: 1) { id } }',
      usersListConfig,
      {},
      'Missing',
    );
    expect('errors' in result).to.equal(true);
    if ('errors' in result) {
      expect(result.errors[0].message).to.equal(
        'Unknown operation named "Missing".',
      );
    }
  });

  it('returns standard validation errors', () => {
    const result = analyze('{ missingField }', usersListConfig);
    expect('errors' in result).to.equal(true);
    if ('errors' in result) {
      expect(result.errors[0].message).to.equal(
        'Cannot query field "missingField" on type "Query".',
      );
    }
  });

  it('rejects invalid variables with execution-style coercion errors', () => {
    const result = analyze(
      'query ($first: Int!) { users(first: $first) { id } }',
      usersListConfig,
      { first: 'not-an-int' },
    );
    expect('errors' in result).to.equal(true);
    if ('errors' in result) {
      expect(result.errors[0].message).to.match(
        /Variable "\$first" has invalid value/,
      );
    }
  });

  it('rejects missing non-null variables', () => {
    const result = analyze(
      'query ($first: Int!) { users(first: $first) { id } }',
      usersListConfig,
      {},
    );
    expect('errors' in result).to.equal(true);
    if ('errors' in result) {
      expect(result.errors[0].message).to.equal(
        'Variable "$first" has invalid value: Expected a value of non-null type "Int!" to be provided.',
      );
    }
  });

  it('uses the explicit default count when the argument is omitted', () => {
    const result = analyze('{ users { id } }', usersListConfig);
    if ('errors' in result) {
      throw result.errors[0];
    }
    expect(result.totalCost).to.equal(11);
    expect(result.costTree[0].listCount).to.equal(10);
  });

  it('prefers the schema argument default over the configured default', () => {
    const result = analyze('{ users { id } }', {
      fields: {
        'Query.users': {
          list: { argument: 'first', defaultCount: 99, maxCount: 100 },
        },
      },
    });
    if ('errors' in result) {
      throw result.errors[0];
    }
    expect(result.costTree[0].listCount).to.equal(10);
  });

  it('rejects negative list counts from coerced variables', () => {
    const result = analyze(
      'query ($first: Int!) { users(first: $first) { id } }',
      usersListConfig,
      { first: -1 },
    );
    expect('errors' in result).to.equal(true);
    if ('errors' in result) {
      expect(result.errors[0].message).to.equal(
        'List count argument "first" must be a non-negative integer.',
      );
    }
  });

  it('rejects list counts above the configured maximum', () => {
    const literal = analyze('{ users(first: 101) { id } }', usersListConfig);
    expect('errors' in literal).to.equal(true);
    if ('errors' in literal) {
      expect(literal.errors[0].message).to.match(
        /exceeds the configured maximum/,
      );
    }

    const variable = analyze(
      'query ($first: Int!) { users(first: $first) { id } }',
      usersListConfig,
      { first: 101 },
    );
    expect('errors' in variable).to.equal(true);
  });

  it('accepts a budget exactly equal to the cost', () => {
    const result = analyze('{ users(first: 2) { id name } }', {
      budget: 5,
      ...usersListConfig,
    });
    if ('errors' in result) {
      throw result.errors[0];
    }
    expect(result.totalCost).to.equal(5);
    expect(result.withinBudget).to.equal(true);
    expect(result.overBudgetPath).to.equal(undefined);
  });

  it('diagnoses the first path crossing a smaller budget', () => {
    const result = analyze('{ users(first: 4) { id name } }', {
      budget: 8,
      ...usersListConfig,
    });
    if ('errors' in result) {
      throw result.errors[0];
    }
    expect(result.totalCost).to.equal(9);
    expect(result.withinBudget).to.equal(false);
    expect(result.overBudgetPath).to.deep.equal(['users', 'name', 3]);
  });

  it('takes the maximum cost over reachable concrete abstract types', () => {
    const node = new GraphQLInterfaceType({
      name: 'Node',
      fields: { id: { type: GraphQLString } },
    });
    const image = new GraphQLObjectType({
      name: 'Image',
      interfaces: [node],
      fields: {
        id: { type: GraphQLString },
        url: { type: GraphQLString },
      },
    });
    const article = new GraphQLObjectType({
      name: 'Article',
      interfaces: [node],
      fields: {
        id: { type: GraphQLString },
        title: { type: GraphQLString },
        body: { type: GraphQLString },
      },
    });
    const searchResult = new GraphQLUnionType({
      name: 'SearchResult',
      types: [image, article],
    });
    const query = new GraphQLObjectType({
      name: 'Query',
      fields: {
        search: { type: searchResult },
      },
    });
    const abstractSchema = new GraphQLSchema({ query });

    const result = analyzeQueryCost(
      abstractSchema,
      parse(`
        {
          search {
            ... on Image { id url }
            ... on Article { id title body }
          }
        }
      `),
    );
    if ('errors' in result) {
      throw result.errors[0];
    }
    // One root field plus the most expensive concrete type (Article: 3 fields).
    expect(result.totalCost).to.equal(4);
    expect(result.costTree[0].concreteType).to.equal('Article');
    expect(
      result.costTree[0].children?.map((child) => child.key),
    ).to.deep.equal(['id', 'title', 'body']);
  });

  it('never executes resolvers or type resolvers', () => {
    const query = new GraphQLObjectType({
      name: 'Query',
      fields: {
        dangerous: {
          type: GraphQLString,
          resolve() {
            throw new Error('resolver must not run');
          },
        },
      },
    });
    const nonExecutableSchema = new GraphQLSchema({ query });
    const result = analyzeQueryCost(
      nonExecutableSchema,
      parse('{ dangerous }'),
    );
    if ('errors' in result) {
      throw result.errors[0];
    }
    expect(result.totalCost).to.equal(1);
  });

  it('honors field-specific fixed costs and the default field cost', () => {
    const result = analyze('{ scalarField users(first: 1) { id } }', {
      defaultFieldCost: 2,
      fields: {
        'Query.users': {
          cost: 5,
          list: { argument: 'first', defaultCount: 10, maxCount: 100 },
        },
      },
    });
    if ('errors' in result) {
      throw result.errors[0];
    }
    // users = 5 + 1 * 2 (id uses the default cost); scalarField = 2.
    expect(result.totalCost).to.equal(9);
  });

  it('bounds the amount of expansion work', () => {
    const result = analyze('{ users(first: 100) { id } }', {
      maxExpansion: 50,
      ...usersListConfig,
    });
    expect('errors' in result).to.equal(true);
    if ('errors' in result) {
      expect(result.errors[0].message).to.match(/expansion exceeds limit/);
    }
  });

  it('detects arithmetic overflow from enormous list estimates', () => {
    const hugeConfig: QueryCostConfig = {
      maxExpansion: Number.MAX_SAFE_INTEGER,
      fields: {
        'Query.container': {
          list: {
            argument: 'first',
            defaultCount: Number.MAX_SAFE_INTEGER,
            maxCount: Number.MAX_SAFE_INTEGER,
          },
        },
        'Container.users': {
          list: {
            argument: 'first',
            defaultCount: Number.MAX_SAFE_INTEGER,
            maxCount: Number.MAX_SAFE_INTEGER,
          },
        },
      },
    };
    const result = analyze(
      'query ($first: Int!) { container(first: $first) { users(first: $first) { id name } } }',
      hugeConfig,
      { first: 2_147_483_647 },
    );
    expect('errors' in result).to.equal(true);
    if ('errors' in result) {
      expect(result.errors[0].message).to.match(/arithmetic overflow/);
    }
  });

  it('rejects malformed cost configuration', () => {
    expect(() => analyze('{ scalarField }', { defaultFieldCost: -1 })).to.throw(
      /defaultFieldCost/,
    );
  });
});
