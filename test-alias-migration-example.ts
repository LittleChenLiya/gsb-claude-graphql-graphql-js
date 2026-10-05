/**
 * Migration rule examples for input field aliases.
 *
 * These examples demonstrate how to use the `aliases` feature to migrate
 * from old external field names to new schema field names while maintaining
 * backwards compatibility.
 *
 * Run with: npm run test:mocha
 */
import { describe, it } from 'node:test';
import { expect } from 'chai';
import { parse } from './src/language/index.ts';
import { buildSchema } from './src/utilities/index.ts';
import { execute } from './src/execution/index.ts';
import { getVariableValues } from './src/execution/index.ts';
import { applyInputFieldAliases } from './src/utilities/index.ts';
import {
  GraphQLInputObjectType,
  GraphQLString,
  GraphQLList,
} from './src/type/index.ts';

describe('Migration rule examples', () => {
  it('example 1: rename display_name to name', async () => {
    const schema = buildSchema(`
      input UserInput {
        name: String
        age: Int
      }
      type Query {
        users(input: [UserInput]): [String]
      }
    `);

    const userInput = schema.getType('UserInput') as GraphQLInputObjectType;
    userInput.getFields().name.aliases = ['display_name'];

    const document = parse(`
      query ($input: [UserInput]) {
        users(input: $input)
      }
    `);

    const variables = {
      input: [{ display_name: 'Alice', age: 30 }],
    };

    const result = await execute({
      schema,
      document,
      variableValues: variables,
      options: { inputFieldAliases: true },
      rootValue: {
        users: ({ input }: { input: Array<{ name: string; age: number }> }) =>
          input.map((u) => `${u.name} (${u.age})`),
      },
    });

    expect(result.errors).to.be.undefined;
    expect(result.data).to.deep.equal({ users: ['Alice (30)'] });
  });

  it('example 2: record deprecation locations for logging', () => {
    const schema = buildSchema(`
      input UserInput {
        name: String
      }
      type Query {
        users(input: [UserInput]): [String]
      }
    `);

    const userInput = schema.getType('UserInput') as GraphQLInputObjectType;
    userInput.getFields().name.aliases = ['display_name'];

    const document = parse(`
      query ($input: [UserInput]) {
        users(input: $input)
      }
    `);

    const variables = {
      input: [{ display_name: 'Alice' }],
    };

    const op = document.definitions[0];
    const result = getVariableValues(
      schema,
      op.kind === 'OperationDefinition' ? op.variableDefinitions ?? [] : [],
      variables,
      { inputFieldAliases: true },
    );

    expect('variableValues' in result).to.be.true;
    if ('variableValues' in result) {
      const deprecations = result.variableValues.inputFieldAliasDeprecations;
      expect(deprecations).to.have.lengthOf(1);
      const usage = deprecations![0];
      expect(usage.path).to.deep.equal(['input', 0, 'display_name']);
      expect(usage.alias).to.equal('display_name');
      expect(usage.fieldName).to.equal('name');
    }
  });

  it('example 3: reject ambiguous input when both keys are present', async () => {
    const schema = buildSchema(`
      input UserInput {
        name: String
      }
      type Query {
        users(input: [UserInput]): [String]
      }
    `);

    const userInput = schema.getType('UserInput') as GraphQLInputObjectType;
    userInput.getFields().name.aliases = ['display_name'];

    const document = parse(`
      query ($input: [UserInput]) {
        users(input: $input)
      }
    `);

    const variables = {
      input: [{ display_name: 'Alice', name: 'Alice' }],
    };

    let resolverCalled = false;
    const result = await execute({
      schema,
      document,
      variableValues: variables,
      options: { inputFieldAliases: true },
      rootValue: {
        users: () => {
          resolverCalled = true;
          return [];
        },
      },
    });

    expect(result.errors).to.not.be.undefined;
    expect(resolverCalled).to.be.false;
  });

  it('example 4: nested list paths retain actual indices', () => {
    const ItemInput = new GraphQLInputObjectType({
      name: 'ItemInput',
      fields: {
        label: { type: GraphQLString, aliases: ['old_label'] },
      },
    });

    const result = applyInputFieldAliases(
      [{ label: 'a' }, { old_label: 'b' }, { old_label: 'c' }],
      new GraphQLList(ItemInput),
    );

    expect(result.value).to.deep.equal([
      { label: 'a' },
      { label: 'b' },
      { label: 'c' },
    ]);
    expect(result.deprecations[0].path).to.deep.equal([1, 'old_label']);
    expect(result.deprecations[1].path).to.deep.equal([2, 'old_label']);
  });

  it('example 5: unknown keys fall through to original coercion', () => {
    const ItemInput = new GraphQLInputObjectType({
      name: 'ItemInput',
      fields: {
        name: { type: GraphQLString, aliases: ['display_name'] },
      },
    });

    const result = applyInputFieldAliases(
      { display_name: 'test', extra: 'unknown' },
      ItemInput,
    );

    expect(result.value).to.deep.equal({ name: 'test', extra: 'unknown' });
  });
});
