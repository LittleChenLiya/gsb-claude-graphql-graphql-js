import { describe, it } from 'node:test';
import { expect } from 'chai';
import { parse } from './src/language/index.ts';
import { buildSchema } from './src/utilities/index.ts';
import { execute } from './src/execution/index.ts';
import { getVariableValues } from './src/execution/index.ts';
import { applyInputFieldAliases } from './src/utilities/index.ts';
import { GraphQLInputObjectType, GraphQLString, GraphQLList } from './src/type/index.ts';

describe('Input field aliases', () => {
  it('maps old display_name to name', async () => {
    const schema = buildSchema(`
      input ItemInput {
        name: String
      }
      type Query {
        items(input: [ItemInput]): [String]
      }
    `);

    const itemInput = schema.getType('ItemInput') as GraphQLInputObjectType;
    itemInput.getFields().name.aliases = ['display_name'];

    let resolverCalls = 0;
    const document = parse(`
      query ($input: [ItemInput]) {
        items(input: $input)
      }
    `);

    const variables = {
      input: [
        { name: 'first' },
        { display_name: 'second' },
      ],
    };

    const result = await execute({
      schema,
      document,
      variableValues: variables,
      options: { inputFieldAliases: true },
      rootValue: {
        items: ({ input }: { input: Array<{ name: string }> }) => {
          resolverCalls++;
          return input.map((i) => i.name);
        },
      },
    });

    expect(result.errors).to.be.undefined;
    expect(result.data).to.deep.equal({ items: ['first', 'second'] });
    expect(resolverCalls).to.equal(1);

    const op = document.definitions[0];
    if (op.kind !== 'OperationDefinition') throw new Error('expected operation');
    const varResult = getVariableValues(
      schema,
      op.variableDefinitions ?? [],
      variables,
      { inputFieldAliases: true },
    );
    expect('variableValues' in varResult).to.be.true;
    if ('variableValues' in varResult) {
      const deps = varResult.variableValues.inputFieldAliasDeprecations;
      expect(deps).to.have.lengthOf(1);
      expect(deps![0].path).to.deep.equal(['input', 1, 'display_name']);
      expect(deps![0].alias).to.equal('display_name');
      expect(deps![0].fieldName).to.equal('name');
    }

    expect(variables.input[1]).to.deep.equal({ display_name: 'second' });
  });

  it('rejects when both old and new keys are present', async () => {
    const schema = buildSchema(`
      input ItemInput {
        name: String
      }
      type Query {
        items(input: [ItemInput]): [String]
      }
    `);

    const itemInput = schema.getType('ItemInput') as GraphQLInputObjectType;
    itemInput.getFields().name.aliases = ['display_name'];

    let resolverCalls = 0;
    const document = parse(`
      query ($input: [ItemInput]) {
        items(input: $input)
      }
    `);

    const variables = {
      input: [
        { name: 'first' },
        { display_name: 'second', name: 'second' },
      ],
    };

    const result = await execute({
      schema,
      document,
      variableValues: variables,
      options: { inputFieldAliases: true },
      rootValue: {
        items: () => {
          resolverCalls++;
          return [];
        },
      },
    });

    expect(result.errors).to.not.be.undefined;
    expect(resolverCalls).to.equal(0);
    expect(variables.input[1]).to.deep.equal({ display_name: 'second', name: 'second' });
  });

  it('default execution entry does not accept old keys', async () => {
    const schema = buildSchema(`
      input ItemInput {
        name: String
      }
      type Query {
        items(input: [ItemInput]): [String]
      }
    `);

    const itemInput = schema.getType('ItemInput') as GraphQLInputObjectType;
    itemInput.getFields().name.aliases = ['display_name'];

    const document = parse(`
      query ($input: [ItemInput]) {
        items(input: $input)
      }
    `);

    const variables = {
      input: [{ display_name: 'second' }],
    };

    const result = await execute({
      schema,
      document,
      variableValues: variables,
    });

    expect(result.errors).to.not.be.undefined;
  });

  it('default values still filled by schema', () => {
    const schema = buildSchema(`
      input ItemInput {
        name: String = "default"
      }
      type Query {
        items(input: [ItemInput]): [String]
      }
    `);

    const itemInput = schema.getType('ItemInput') as GraphQLInputObjectType;
    itemInput.getFields().name.aliases = ['display_name'];

    const document = parse(`
      query ($input: [ItemInput]) {
        items(input: $input)
      }
    `);

    const variables = {
      input: [{}],
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
      expect(result.variableValues.coerced.input).to.deep.equal([{ name: 'default' }]);
    }
  });

  it('applyInputFieldAliases preserves list indices', () => {
    const ItemInput = new GraphQLInputObjectType({
      name: 'ItemInput',
      fields: {
        name: { type: GraphQLString, aliases: ['display_name'] },
      },
    });

    const result = applyInputFieldAliases(
      [{ name: 'a' }, { display_name: 'b' }, { display_name: 'c' }],
      new GraphQLList(ItemInput),
    );

    expect(result.value).to.deep.equal([
      { name: 'a' },
      { name: 'b' },
      { name: 'c' },
    ]);
    expect(result.deprecations).to.have.lengthOf(2);
    expect(result.deprecations[0].path).to.deep.equal([1, 'display_name']);
    expect(result.deprecations[1].path).to.deep.equal([2, 'display_name']);
  });

  it('applyInputFieldAliases does not mutate input', () => {
    const ItemInput = new GraphQLInputObjectType({
      name: 'ItemInput',
      fields: {
        name: { type: GraphQLString, aliases: ['display_name'] },
      },
    });

    const input = { display_name: 'test' };
    const result = applyInputFieldAliases(input, ItemInput);

    expect(result.value).to.deep.equal({ name: 'test' });
    expect(input).to.deep.equal({ display_name: 'test' });
  });
});
