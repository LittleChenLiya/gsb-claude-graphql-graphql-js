/* eslint-disable camelcase -- deprecated external keys intentionally use snake_case. */
/**
 * Tests for explicit input object field alias rules (deprecated external key
 * migration) applied to variable values before coercion.
 *
 * Migration rule example used throughout this file:
 *
 *   const inputFieldAliases = [
 *     // Clients still sending "display_name" are migrated to "ItemInput.name".
 *     { typeName: 'ItemInput', alias: 'display_name', field: 'name' },
 *   ];
 *
 * Run only these tests locally (node:test runner; mocha-style single-file
 * invocation):
 *
 *   npm run node:test -- "src/execution/__tests__/input-field-alias-test.ts"
 */

import { describe, it } from 'node:test';

import { assert, expect } from 'chai';

import { expectJSON } from '../../__testUtils__/expectJSON.ts';

import { printPathArray } from '../../jsutils/printPathArray.ts';

import type { OperationDefinitionNode } from '../../language/ast.ts';
import { parse } from '../../language/parser.ts';

import {
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
} from '../../type/definition.ts';
import { GraphQLString } from '../../type/scalars.ts';
import { GraphQLSchema } from '../../type/schema.ts';

import { executeSync } from '../execute.ts';
import type {
  InputFieldAliasDeprecation,
  InputFieldAliasRule,
} from '../inputFieldAliases.ts';
import { getVariableValues } from '../values.ts';

const ItemInput = new GraphQLInputObjectType({
  name: 'ItemInput',
  fields: {
    name: { type: GraphQLString },
    nickname: { type: GraphQLString, default: { value: 'none' } },
  },
});

const ItemsInput = new GraphQLInputObjectType({
  name: 'ItemsInput',
  fields: {
    items: { type: new GraphQLList(new GraphQLNonNull(ItemInput)) },
  },
});

/** Migration rules: map deprecated external key "display_name" to "name". */
const migrationRules: ReadonlyArray<InputFieldAliasRule> = [
  { typeName: 'ItemInput', alias: 'display_name', field: 'name' },
];

let resolverCalls: number;
let receivedArgs: unknown;

const QueryType = new GraphQLObjectType({
  name: 'Query',
  fields: {
    item: {
      type: GraphQLString,
      args: { input: { type: ItemInput } },
      resolve(_source, args) {
        resolverCalls++;
        receivedArgs = args;
        return 'ok';
      },
    },
  },
});

const schema = new GraphQLSchema({ query: QueryType, types: [ItemsInput] });

function operationOf(query: string): OperationDefinitionNode {
  const operation = parse(query).definitions[0];
  assert(operation.kind === 'OperationDefinition');
  return operation;
}

function jsonSnapshot(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('input field alias rules', () => {
  it('maps deprecated "display_name" to "name" before coercion', () => {
    const operation = operationOf(
      'query ($input: ItemInput) { item(input: $input) }',
    );
    const inputs = { input: { display_name: 'Ada' } };
    const snapshot = jsonSnapshot(inputs);
    const deprecations: Array<InputFieldAliasDeprecation> = [];

    const result = getVariableValues(
      schema,
      operation.variableDefinitions ?? [],
      inputs,
      {
        inputFieldAliases: migrationRules,
        onInputFieldAliasDeprecation: (deprecation) => {
          deprecations.push(deprecation);
        },
      },
    );

    assert('variableValues' in result);
    // The alias is remapped and the schema still fills the default value.
    expectJSON(result.variableValues.coerced).toDeepEqual({
      input: { name: 'Ada', nickname: 'none' },
    });
    // The deprecation location is recorded.
    expect(deprecations).to.deep.equal([
      {
        variableName: 'input',
        path: ['display_name'],
        rule: migrationRules[0],
      },
    ]);
    // The original variables object is left untouched.
    expect(inputs).to.deep.equal(snapshot);
  });

  it('reports the full path with the actual index for nested list items', () => {
    const operation = operationOf('query ($input: ItemsInput) { item }');
    const inputs = {
      input: { items: [{ display_name: 'first' }, { name: 'second' }] },
    };
    const snapshot = jsonSnapshot(inputs);
    const deprecations: Array<InputFieldAliasDeprecation> = [];

    const result = getVariableValues(
      schema,
      operation.variableDefinitions ?? [],
      inputs,
      {
        inputFieldAliases: migrationRules,
        onInputFieldAliasDeprecation: (deprecation) => {
          deprecations.push(deprecation);
        },
      },
    );

    assert('variableValues' in result);
    expectJSON(result.variableValues.coerced).toDeepEqual({
      input: {
        items: [
          { name: 'first', nickname: 'none' },
          { name: 'second', nickname: 'none' },
        ],
      },
    });
    // The first nested item reports the complete path, keeping index 0.
    expect(deprecations).to.have.lengthOf(1);
    expect(deprecations[0].variableName).to.equal('input');
    expect(deprecations[0].path).to.deep.equal(['items', 0, 'display_name']);
    expect(printPathArray(deprecations[0].path)).to.equal(
      ' at .items[0].display_name',
    );
    expect(inputs).to.deep.equal(snapshot);
  });

  it('rejects when both alias and schema field are present, even with equal values', () => {
    resolverCalls = 0;
    const variables = { input: { display_name: 'Ada', name: 'Ada' } };
    const snapshot = jsonSnapshot(variables);

    const result = executeSync({
      schema,
      document: parse('query ($input: ItemInput) { item(input: $input) }'),
      variableValues: variables,
      inputFieldAliases: migrationRules,
    });

    // The request is rejected before execution: the resolver never runs.
    expect(resolverCalls).to.equal(0);
    expectJSON(result).toDeepNestedProperty(
      'errors.0.message',
      'Variable "$input" must not provide both deprecated input field alias ' +
        '"display_name" and field "name" of input object type "ItemInput" ' +
        'at .display_name.',
    );
    // The failed coercion did not modify the original variables.
    expect(variables).to.deep.equal(snapshot);
  });

  it('does not accept deprecated keys at the default execution entry', () => {
    resolverCalls = 0;

    const result = executeSync({
      schema,
      document: parse('query ($input: ItemInput) { item(input: $input) }'),
      variableValues: { input: { display_name: 'Ada' } },
    });

    expect(resolverCalls).to.equal(0);
    expectJSON(result).toDeepNestedProperty(
      'errors.0.message',
      'Variable "$input" has invalid value: Expected value of ' +
        'type "ItemInput" not to include unknown field "display_name", ' +
        'found: { display_name: "Ada" }.',
    );
  });

  it('leaves unknown keys to the original coercion rules', () => {
    const operation = operationOf(
      'query ($input: ItemInput) { item(input: $input) }',
    );
    const inputs = { input: { unknown_key: 'value' } };
    const snapshot = jsonSnapshot(inputs);

    const result = getVariableValues(
      schema,
      operation.variableDefinitions ?? [],
      inputs,
      { inputFieldAliases: migrationRules },
    );

    assert('errors' in result);
    expect(result.errors[0].message).to.include(
      'not to include unknown field "unknown_key"',
    );
    expect(inputs).to.deep.equal(snapshot);
  });

  it('executes with remapped variables when rules are provided explicitly', () => {
    resolverCalls = 0;
    receivedArgs = undefined;
    const deprecations: Array<InputFieldAliasDeprecation> = [];

    const result = executeSync({
      schema,
      document: parse('query ($input: ItemInput) { item(input: $input) }'),
      variableValues: { input: { display_name: 'Ada' } },
      inputFieldAliases: migrationRules,
      onInputFieldAliasDeprecation: (deprecation) => {
        deprecations.push(deprecation);
      },
    });

    expectJSON(result).toDeepEqual({ data: { item: 'ok' } });
    expect(resolverCalls).to.equal(1);
    expectJSON(receivedArgs).toDeepEqual({
      input: { name: 'Ada', nickname: 'none' },
    });
    expect(deprecations).to.have.lengthOf(1);
    expect(deprecations[0].path).to.deep.equal(['display_name']);
  });
});
