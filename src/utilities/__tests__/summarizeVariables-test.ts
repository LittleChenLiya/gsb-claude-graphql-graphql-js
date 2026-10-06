import { describe, it } from 'node:test';

import { expect } from 'chai';

import type { OperationDefinitionNode } from '../../language/ast.ts';
import { parse } from '../../language/parser.ts';

import {
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLObjectType,
} from '../../type/definition.ts';
import { GraphQLString } from '../../type/scalars.ts';
import { GraphQLSchema } from '../../type/schema.ts';

import { buildSchema } from '../buildASTSchema.ts';
import type { VariableSummaryResult } from '../summarizeVariables.ts';
import { MASKED_VALUE, summarizeVariables } from '../summarizeVariables.ts';

const schema = buildSchema(`
  input UserInput {
    name: String
    password: String
  }

  enum Role {
    ADMIN
    USER
  }

  input Credentials @oneOf {
    username: String
    password: String
  }

  type Query {
    search(
      users: [UserInput!]!
      role: Role
      credentials: Credentials
    ): String
  }
`);

const document = parse(`
  query Search(
    $users: [UserInput!]!
    $fallback: UserInput = { name: "backup", password: "default-secret" }
    $role: Role
    $credentials: Credentials
    $nickname: String
  ) {
    search(users: $users, role: $role, credentials: $credentials)
  }
`);

const sensitivePaths = [
  'users.*.password',
  'fallback.password',
  'credentials.password',
];

function summarize(
  inputs: { readonly [variable: string]: unknown },
  options?: { sensitivePaths?: ReadonlyArray<string> },
): VariableSummaryResult {
  return summarizeVariables(schema, document, inputs, {
    sensitivePaths,
    ...options,
  });
}

function expectSummary(result: VariableSummaryResult) {
  expect(result).to.have.property('summary');
  expect(result).to.not.have.property('errors');
  if (result.summary === undefined) {
    throw new Error('Expected a summary result.');
  }
  return result.summary;
}

function expectErrors(result: VariableSummaryResult) {
  expect(result).to.have.property('errors');
  expect(result).to.not.have.property('summary');
  if (result.errors === undefined) {
    throw new Error('Expected an errors result.');
  }
  return result.errors;
}

describe('summarizeVariables', () => {
  it('masks every sensitive scalar in a nested users list', () => {
    const inputs = {
      users: [
        { name: 'Ann', password: 'pw-1' },
        { name: 'Bob', password: 'pw-2' },
        { name: 'Cy', password: 'pw-3' },
      ],
      role: 'ADMIN',
      credentials: { password: 'oneof-secret' },
      nickname: 'buddy',
    };
    const snapshot = JSON.parse(JSON.stringify(inputs));

    const summary = expectSummary(summarize(inputs));

    expect(summary.variables).to.deep.equal({
      users: {
        provided: true,
        fromDefault: false,
        value: [
          { name: 'Ann', password: MASKED_VALUE },
          { name: 'Bob', password: MASKED_VALUE },
          { name: 'Cy', password: MASKED_VALUE },
        ],
      },
      fallback: {
        provided: false,
        fromDefault: true,
        value: { name: 'backup', password: MASKED_VALUE },
      },
      role: { provided: true, fromDefault: false, value: 'ADMIN' },
      credentials: {
        provided: true,
        fromDefault: false,
        value: { password: MASKED_VALUE },
      },
      nickname: { provided: true, fromDefault: false, value: 'buddy' },
    });

    // The list wildcard masked every element, not just the first one.
    const users = summary.variables.users.value as Array<{
      password: unknown;
    }>;
    expect(users).to.have.lengthOf(3);
    expect(users.map((user) => user.password)).to.deep.equal([
      MASKED_VALUE,
      MASKED_VALUE,
      MASKED_VALUE,
    ]);

    // The original variables object was not mutated.
    expect(inputs).to.deep.equal(snapshot);
  });

  it('distinguishes not provided, null, and default values', () => {
    const summary = expectSummary(
      summarize({
        users: [{ name: null, password: null }],
        role: null,
      }),
    );

    expect(summary.variables.users).to.deep.equal({
      provided: true,
      fromDefault: false,
      value: [{ name: null, password: null }],
    });
    // Explicitly provided null is preserved, not masked.
    expect(summary.variables.role).to.deep.equal({
      provided: true,
      fromDefault: false,
      value: null,
    });
    // Defaulted variable reports fromDefault and is masked.
    expect(summary.variables.fallback).to.deep.equal({
      provided: false,
      fromDefault: true,
      value: { name: 'backup', password: MASKED_VALUE },
    });
    // Nullable variable which was not provided and has no default.
    expect(summary.variables.nickname).to.deep.equal({
      provided: false,
      fromDefault: false,
      value: undefined,
    });
  });

  it('masks a sensitive path pointing at a whole list', () => {
    const summary = expectSummary(
      summarize(
        {
          users: [
            { name: 'Ann', password: 'pw-1' },
            { name: null, password: null },
          ],
        },
        { sensitivePaths: ['users'] },
      ),
    );

    expect(summary.variables.users).to.deep.equal({
      provided: true,
      fromDefault: false,
      value: [
        { name: MASKED_VALUE, password: MASKED_VALUE },
        { name: null, password: null },
      ],
    });
  });

  it('masks a sensitive path pointing at a whole object', () => {
    const summary = expectSummary(
      summarize(
        { users: [{ name: 'Ann', password: 'pw-1' }] },
        { sensitivePaths: ['fallback', 'users.*.password'] },
      ),
    );

    expect(summary.variables.fallback).to.deep.equal({
      provided: false,
      fromDefault: true,
      value: { name: MASKED_VALUE, password: MASKED_VALUE },
    });
  });

  it('supports documents with an operation name', () => {
    const multiOpDocument = parse(`
      query First($users: [UserInput!]!) {
        search(users: $users)
      }

      query Second($users: [UserInput!]!) {
        search(users: $users)
      }
    `);

    const result = summarizeVariables(
      schema,
      multiOpDocument,
      { users: [{ name: 'Ann', password: 'pw-1' }] },
      { sensitivePaths, operationName: 'Second' },
    );
    const summary = expectSummary(result);
    expect(summary.variables.users).to.deep.equal({
      provided: true,
      fromDefault: false,
      value: [{ name: 'Ann', password: MASKED_VALUE }],
    });

    const ambiguous = summarizeVariables(schema, multiOpDocument, {
      users: [],
    });
    expect(ambiguous).to.have.property('errors');
  });

  it('accepts an operation definition node directly', () => {
    const operation = document.definitions[0] as OperationDefinitionNode;
    const summary = expectSummary(
      summarizeVariables(
        schema,
        operation,
        { users: [{ name: 'Ann', password: 'pw-1' }] },
        { sensitivePaths },
      ),
    );
    expect(summary.variables.users).to.deep.equal({
      provided: true,
      fromDefault: false,
      value: [{ name: 'Ann', password: MASKED_VALUE }],
    });
  });

  it('summarizes without masking when no options are provided', () => {
    const summary = expectSummary(
      summarizeVariables(schema, document, {
        users: [{ name: 'Ann', password: 'pw-1' }],
      }),
    );
    expect(summary.variables.users).to.deep.equal({
      provided: true,
      fromDefault: false,
      value: [{ name: 'Ann', password: 'pw-1' }],
    });
  });

  it('summarizes operations without variable definitions', () => {
    const summary = expectSummary(
      summarizeVariables(schema, parse('{ search(users: []) }'), {}),
    );
    expect(summary.variables).to.deep.equal({});
  });

  it('does not execute any resolvers', () => {
    let resolveCalls = 0;
    const UserInput = new GraphQLInputObjectType({
      name: 'UserInput',
      fields: {
        name: { type: GraphQLString },
        password: { type: GraphQLString },
      },
    });
    const resolverSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          search: {
            type: GraphQLString,
            args: { users: { type: new GraphQLList(UserInput) } },
            resolve() {
              resolveCalls++;
              return 'secret-result';
            },
          },
        },
      }),
      types: [UserInput],
    });
    const operation = parse(`
      query ($users: [UserInput]) {
        search(users: $users)
      }
    `);

    const summary = expectSummary(
      summarizeVariables(
        resolverSchema,
        operation,
        { users: [{ name: 'Ann', password: 'pw-1' }] },
        { sensitivePaths: ['users.*.password'] },
      ),
    );

    expect(summary.variables.users.value).to.deep.equal([
      { name: 'Ann', password: MASKED_VALUE },
    ]);
    expect(resolveCalls).to.equal(0);
  });

  it('reports a safe error for a missing required variable', () => {
    const errors = expectErrors(summarize({}));

    expect(errors).to.have.lengthOf(1);
    expect(errors[0].message).to.equal(
      'Variable "$users" of required type "[UserInput!]!" was not provided.',
    );
  });

  it('reports a safe error for an unknown field without leaking values', () => {
    const errors = expectErrors(
      summarize({
        users: [{ name: 'Ann', password: 'super-secret', typo: 1 }],
      }),
    );

    expect(errors).to.have.lengthOf(1);
    expect(errors[0].message).to.equal(
      'Variable "$users" has invalid value at "$users[0]": expected type "UserInput!".',
    );
    // The raw validation message would embed the whole object, including the
    // sensitive password; the safe diagnostic must not.
    expect(errors[0].message).to.not.include('super-secret');
    expect(JSON.stringify(errors)).to.not.include('super-secret');
  });

  it('reports a safe error for an invalid enum value', () => {
    const errors = expectErrors(
      summarize({
        users: [],
        role: 'SUPERUSER',
      }),
    );

    expect(errors).to.have.lengthOf(1);
    expect(errors[0].message).to.equal(
      'Variable "$role" has invalid value at "$role": expected type "Role".',
    );
    expect(errors[0].message).to.not.include('SUPERUSER');
  });

  it('reports safe errors with paths through nullable types', () => {
    const errors = expectErrors(
      summarize({ users: [], fallback: { name: 'Ann', password: 42 } }),
    );

    expect(errors).to.have.lengthOf(1);
    expect(errors[0].message).to.equal(
      'Variable "$fallback" has invalid value at "$fallback.password": expected type "String".',
    );
  });

  it('does not leak sensitive values referenced by coercion errors', () => {
    const errors = expectErrors(
      summarize({
        users: [{ name: 'Ann', password: { oops: 'nested-secret' } }],
      }),
    );

    expect(errors).to.have.lengthOf(1);
    expect(errors[0].message).to.equal(
      'Variable "$users" has invalid value at "$users[0].password": expected type "String".',
    );
    // The raw coercion message would inspect the offending object.
    expect(JSON.stringify(errors)).to.not.include('nested-secret');
  });

  it('handles oneOf inputs, masking valid ones and safely reporting invalid ones', () => {
    const validSummary = expectSummary(
      summarize({ users: [], credentials: { username: 'ann' } }),
    );
    expect(validSummary.variables.credentials).to.deep.equal({
      provided: true,
      fromDefault: false,
      value: { username: 'ann' },
    });

    const maskedSummary = expectSummary(
      summarize({ users: [], credentials: { password: 'oneof-secret' } }),
    );
    expect(maskedSummary.variables.credentials).to.deep.equal({
      provided: true,
      fromDefault: false,
      value: { password: MASKED_VALUE },
    });

    const errors = expectErrors(
      summarize({
        users: [],
        credentials: { username: 'ann', password: 'oneof-secret' },
      }),
    );
    expect(errors).to.have.lengthOf(1);
    expect(errors[0].message).to.equal(
      'Variable "$credentials" has invalid value at "$credentials": expected type "Credentials".',
    );
    expect(JSON.stringify(errors)).to.not.include('oneof-secret');
  });

  it('reports a safe error for variables of a non-input type', () => {
    const badDocument = parse(`
      query ($query: Query) {
        search(users: [])
      }
    `);

    const errors = expectErrors(
      summarizeVariables(schema, badDocument, { query: {} }),
    );
    expect(errors).to.have.lengthOf(1);
    expect(errors[0].message).to.equal(
      'Variable "$query" expected value of type "Query" which cannot be used as an input type.',
    );
  });
});
