import { describe, it } from 'node:test';

import { expect } from 'chai';

import { expectJSON } from '../../__testUtils__/expectJSON.ts';
import { resolveOnNextTick } from '../../__testUtils__/resolveOnNextTick.ts';

import { parse } from '../../language/parser.ts';

import { buildSchema } from '../../utilities/buildASTSchema.ts';

import { execute } from '../execute.ts';
import type { ExecutionResult } from '../Executor.ts';

// Three-field schema used to demonstrate null-bubbling diagnostics.
const schema = buildSchema(`
  type User {
    id: ID
    name: String!
    email: String
  }

  type Query {
    users: [User!]!
    nullableUsers: [User!]
    nullableItemUsers: [User]
  }
`);

interface ResolverCounts {
  users: number;
  nullableUsers: number;
  nullableItemUsers: number;
  name: number;
}

function makeRootValue(
  counts: ResolverCounts,
  badNames: ReadonlyArray<number> = [0],
  asyncName: boolean = false,
) {
  const makeUser = (index: number) => ({
    id: `user-${index}`,
    name() {
      counts.name++;
      const value = badNames.includes(index) ? null : `name-${index}`;
      return asyncName ? resolveOnNextTick().then(() => value) : value;
    },
    email: `user-${index}@example.com`,
  });
  return {
    users() {
      counts.users++;
      return [makeUser(0), makeUser(1)];
    },
    nullableUsers() {
      counts.nullableUsers++;
      return [makeUser(0), makeUser(1)];
    },
    nullableItemUsers() {
      counts.nullableItemUsers++;
      return [makeUser(0), makeUser(1)];
    },
  };
}

function freshCounts(): ResolverCounts {
  return { users: 0, nullableUsers: 0, nullableItemUsers: 0, name: 0 };
}

async function executeQuery(
  query: string,
  options: {
    nullBubblingDiagnostics?: boolean;
    badNames?: ReadonlyArray<number>;
    asyncName?: boolean;
    counts?: ResolverCounts;
  } = {},
): Promise<ExecutionResult> {
  const counts = options.counts ?? freshCounts();
  return execute({
    schema,
    document: parse(query),
    rootValue: makeRootValue(counts, options.badNames, options.asyncName),
    nullBubblingDiagnostics: options.nullBubblingDiagnostics,
  });
}

describe('null-bubbling diagnostics', () => {
  it('records the full propagation chain to the root for users: [User!]!', async () => {
    const result = await executeQuery('{ users { name } }', {
      nullBubblingDiagnostics: true,
    });

    expectJSON(result).toDeepEqual({
      data: null,
      errors: [
        {
          message: 'Cannot return null for non-nullable field User.name.',
          locations: [{ line: 1, column: 11 }],
          path: ['users', 0, 'name'],
        },
      ],
      extensions: {
        nullBubbling: [
          {
            path: ['users', 0, 'name'],
            propagation: [
              { path: ['users', 0, 'name'], type: 'String!', kind: 'field' },
              { path: ['users', 0], type: 'User!', kind: 'listItem' },
              { path: ['users'], type: '[User!]!', kind: 'field' },
              { path: [], type: 'data', kind: 'root' },
            ],
          },
        ],
      },
    });
  });

  it('stops the propagation chain at users when the field is nullable', async () => {
    const result = await executeQuery('{ nullableUsers { name } }', {
      nullBubblingDiagnostics: true,
    });

    expectJSON(result).toDeepEqual({
      data: { nullableUsers: null },
      errors: [
        {
          message: 'Cannot return null for non-nullable field User.name.',
          locations: [{ line: 1, column: 19 }],
          path: ['nullableUsers', 0, 'name'],
        },
      ],
      extensions: {
        nullBubbling: [
          {
            path: ['nullableUsers', 0, 'name'],
            propagation: [
              {
                path: ['nullableUsers', 0, 'name'],
                type: 'String!',
                kind: 'field',
              },
              { path: ['nullableUsers', 0], type: 'User!', kind: 'listItem' },
              { path: ['nullableUsers'], type: '[User!]', kind: 'field' },
            ],
          },
        ],
      },
    });
  });

  it('uses the response alias in the propagation chain', async () => {
    const result = await executeQuery('{ folks: users { name } }', {
      nullBubblingDiagnostics: true,
    });

    expectJSON(result).toDeepEqual({
      data: null,
      errors: [
        {
          message: 'Cannot return null for non-nullable field User.name.',
          locations: [{ line: 1, column: 18 }],
          path: ['folks', 0, 'name'],
        },
      ],
      extensions: {
        nullBubbling: [
          {
            path: ['folks', 0, 'name'],
            propagation: [
              { path: ['folks', 0, 'name'], type: 'String!', kind: 'field' },
              { path: ['folks', 0], type: 'User!', kind: 'listItem' },
              { path: ['folks'], type: '[User!]!', kind: 'field' },
              { path: [], type: 'data', kind: 'root' },
            ],
          },
        ],
      },
    });
  });

  it('stops the propagation chain at a nullable list element', async () => {
    const result = await executeQuery('{ nullableItemUsers { name } }', {
      nullBubblingDiagnostics: true,
    });

    expectJSON(result).toDeepEqual({
      data: { nullableItemUsers: [null, { name: 'name-1' }] },
      errors: [
        {
          message: 'Cannot return null for non-nullable field User.name.',
          locations: [{ line: 1, column: 23 }],
          path: ['nullableItemUsers', 0, 'name'],
        },
      ],
      extensions: {
        nullBubbling: [
          {
            path: ['nullableItemUsers', 0, 'name'],
            propagation: [
              {
                path: ['nullableItemUsers', 0, 'name'],
                type: 'String!',
                kind: 'field',
              },
              {
                path: ['nullableItemUsers', 0],
                type: 'User',
                kind: 'listItem',
              },
            ],
          },
        ],
      },
    });
  });

  it('records independent chains for two failures without overwriting', async () => {
    const result = await executeQuery('{ nullableItemUsers { name } }', {
      nullBubblingDiagnostics: true,
      badNames: [0, 1],
    });

    expectJSON(result).toDeepEqual({
      data: { nullableItemUsers: [null, null] },
      errors: [
        {
          message: 'Cannot return null for non-nullable field User.name.',
          locations: [{ line: 1, column: 23 }],
          path: ['nullableItemUsers', 0, 'name'],
        },
        {
          message: 'Cannot return null for non-nullable field User.name.',
          locations: [{ line: 1, column: 23 }],
          path: ['nullableItemUsers', 1, 'name'],
        },
      ],
      extensions: {
        nullBubbling: [
          {
            path: ['nullableItemUsers', 0, 'name'],
            propagation: [
              {
                path: ['nullableItemUsers', 0, 'name'],
                type: 'String!',
                kind: 'field',
              },
              {
                path: ['nullableItemUsers', 0],
                type: 'User',
                kind: 'listItem',
              },
            ],
          },
          {
            path: ['nullableItemUsers', 1, 'name'],
            propagation: [
              {
                path: ['nullableItemUsers', 1, 'name'],
                type: 'String!',
                kind: 'field',
              },
              {
                path: ['nullableItemUsers', 1],
                type: 'User',
                kind: 'listItem',
              },
            ],
          },
        ],
      },
    });
  });

  it('records chains for asynchronous failures as well', async () => {
    const result = await executeQuery('{ users { name } }', {
      nullBubblingDiagnostics: true,
      asyncName: true,
    });

    expectJSON(result).toDeepEqual({
      data: null,
      errors: [
        {
          message: 'Cannot return null for non-nullable field User.name.',
          locations: [{ line: 1, column: 11 }],
          path: ['users', 0, 'name'],
        },
      ],
      extensions: {
        nullBubbling: [
          {
            path: ['users', 0, 'name'],
            propagation: [
              { path: ['users', 0, 'name'], type: 'String!', kind: 'field' },
              { path: ['users', 0], type: 'User!', kind: 'listItem' },
              { path: ['users'], type: '[User!]!', kind: 'field' },
              { path: [], type: 'data', kind: 'root' },
            ],
          },
        ],
      },
    });
  });

  it('keeps data and errors identical and does not re-call resolvers', async () => {
    const query = '{ users { name } }';

    const countsWithout = freshCounts();
    const resultWithout = await executeQuery(query, { counts: countsWithout });

    const countsWith = freshCounts();
    const resultWith = await executeQuery(query, {
      nullBubblingDiagnostics: true,
      counts: countsWith,
    });

    // Diagnostics must not change data or errors...
    expectJSON({
      data: resultWith.data,
      errors: resultWith.errors,
    }).toDeepEqual({
      data: resultWithout.data,
      errors: resultWithout.errors,
    });
    // ...only add the extensions payload.
    expect(resultWithout.extensions).to.equal(undefined);
    expect(resultWith.extensions).to.deep.equal({
      nullBubbling: [
        {
          path: ['users', 0, 'name'],
          propagation: [
            { path: ['users', 0, 'name'], type: 'String!', kind: 'field' },
            { path: ['users', 0], type: 'User!', kind: 'listItem' },
            { path: ['users'], type: '[User!]!', kind: 'field' },
            { path: [], type: 'data', kind: 'root' },
          ],
        },
      ],
    });
    // ...and must not re-call any resolver to explain the result.
    expect(countsWith).to.deep.equal(countsWithout);
    expect(countsWith).to.deep.equal({
      users: 1,
      nullableUsers: 0,
      nullableItemUsers: 0,
      name: 1,
    });
  });

  it('omits the diagnostics extension when the option is not enabled', async () => {
    const result = await executeQuery('{ users { name } }');

    expectJSON(result).toDeepEqual({
      data: null,
      errors: [
        {
          message: 'Cannot return null for non-nullable field User.name.',
          locations: [{ line: 1, column: 11 }],
          path: ['users', 0, 'name'],
        },
      ],
    });
  });
});
