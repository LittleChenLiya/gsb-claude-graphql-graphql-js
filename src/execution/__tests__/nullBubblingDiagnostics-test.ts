import { describe, it } from 'node:test';

import { expect } from 'chai';

import { expectJSON } from '../../__testUtils__/expectJSON.ts';

import type { PromiseOrValue } from '../../jsutils/PromiseOrValue.ts';

import { parse } from '../../language/parser.ts';

import { buildSchema } from '../../utilities/buildASTSchema.ts';

import { execute } from '../execute.ts';
import type { ExecutionResult } from '../Executor.ts';

const schema = buildSchema(`
  type Query {
    users: [User!]!
    usersNullable: [User!]
    usersNullableElements: [User]
    twoErrorsA: Nested
    twoErrorsB: Nested
  }

  type User {
    name: String!
  }

  type Nested {
    bad: String!
  }
`);

function executeQuery(
  query: string,
  rootValue: unknown,
  options: { nullBubblingDiagnostics?: boolean } = {},
): PromiseOrValue<ExecutionResult> {
  return execute({
    schema,
    document: parse(query),
    rootValue,
    nullBubblingDiagnostics: options.nullBubblingDiagnostics,
  });
}

describe('null-bubbling diagnostics', () => {
  it('records the chain from a failing non-null field through list elements and parent fields to the root', async () => {
    const rootValue = {
      users: () => [{ name: null }, { name: 'Ada' }],
    };

    const result = await executeQuery('{ users { name } }', rootValue, {
      nullBubblingDiagnostics: true,
    });

    expectJSON(result).toDeepEqual({
      errors: [
        {
          message: 'Cannot return null for non-nullable field User.name.',
          path: ['users', 0, 'name'],
          locations: [{ line: 1, column: 11 }],
        },
      ],
      data: null,
      extensions: {
        nullBubbling: [
          [
            { path: ['users', 0, 'name'], type: 'String!' },
            { path: ['users', 0], type: 'User!' },
            { path: ['users'], type: '[User!]!' },
            { path: [], type: null },
          ],
        ],
      },
    });
  });

  it('stops the chain at the first nullable parent field', async () => {
    const rootValue = {
      usersNullable: () => [{ name: null }, { name: 'Ada' }],
    };

    const result = await executeQuery('{ usersNullable { name } }', rootValue, {
      nullBubblingDiagnostics: true,
    });

    expectJSON(result).toDeepEqual({
      errors: [
        {
          message: 'Cannot return null for non-nullable field User.name.',
          path: ['usersNullable', 0, 'name'],
          locations: [{ line: 1, column: 19 }],
        },
      ],
      data: { usersNullable: null },
      extensions: {
        nullBubbling: [
          [
            { path: ['usersNullable', 0, 'name'], type: 'String!' },
            { path: ['usersNullable', 0], type: 'User!' },
            { path: ['usersNullable'], type: '[User!]' },
          ],
        ],
      },
    });
  });

  it('stops the chain at a nullable list element', async () => {
    const rootValue = {
      usersNullableElements: () => [{ name: null }, { name: 'Ada' }],
    };

    const result = await executeQuery(
      '{ usersNullableElements { name } }',
      rootValue,
      { nullBubblingDiagnostics: true },
    );

    expectJSON(result).toDeepEqual({
      errors: [
        {
          message: 'Cannot return null for non-nullable field User.name.',
          path: ['usersNullableElements', 0, 'name'],
          locations: [{ line: 1, column: 27 }],
        },
      ],
      data: { usersNullableElements: [null, { name: 'Ada' }] },
      extensions: {
        nullBubbling: [
          [
            { path: ['usersNullableElements', 0, 'name'], type: 'String!' },
            { path: ['usersNullableElements', 0], type: 'User' },
          ],
        ],
      },
    });
  });

  it('shows aliases by response name along the chain', async () => {
    const rootValue = {
      users: () => [{ name: null }],
    };

    const result = await executeQuery(
      '{ aliasedUsers: users { aliasedName: name } }',
      rootValue,
      { nullBubblingDiagnostics: true },
    );

    expectJSON(result).toDeepEqual({
      errors: [
        {
          message: 'Cannot return null for non-nullable field User.name.',
          path: ['aliasedUsers', 0, 'aliasedName'],
          locations: [{ line: 1, column: 25 }],
        },
      ],
      data: null,
      extensions: {
        nullBubbling: [
          [
            { path: ['aliasedUsers', 0, 'aliasedName'], type: 'String!' },
            { path: ['aliasedUsers', 0], type: 'User!' },
            { path: ['aliasedUsers'], type: '[User!]!' },
            { path: [], type: null },
          ],
        ],
      },
    });
  });

  it('records a separate chain for each failing non-null field', async () => {
    const rootValue = {
      twoErrorsA: () => ({ bad: null }),
      twoErrorsB: () => ({ bad: null }),
    };

    const result = await executeQuery(
      '{ twoErrorsA { bad } twoErrorsB { bad } }',
      rootValue,
      { nullBubblingDiagnostics: true },
    );

    expect(result.errors).to.have.lengthOf(2);
    expect(result.data).to.deep.equal({
      twoErrorsA: null,
      twoErrorsB: null,
    });
    expect(result.extensions?.nullBubbling).to.have.lengthOf(2);
    expectJSON(result.extensions?.nullBubbling).toDeepEqual([
      [
        { path: ['twoErrorsA', 'bad'], type: 'String!' },
        { path: ['twoErrorsA'], type: 'Nested' },
      ],
      [
        { path: ['twoErrorsB', 'bad'], type: 'String!' },
        { path: ['twoErrorsB'], type: 'Nested' },
      ],
    ]);
  });

  it('does not re-invoke resolvers to explain a result', async () => {
    let callCount = 0;
    const rootValue = {
      users: () => [{ name: null }],
    };

    const result = await execute({
      schema,
      document: parse('{ users { name } }'),
      rootValue,
      fieldResolver: (source, _args, _context, info) => {
        callCount++;
        return source[info.fieldName];
      },
      nullBubblingDiagnostics: true,
    });

    expect(callCount).to.equal(1);
    expect(result.data).to.equal(null);
    expect(result.extensions?.nullBubbling).to.have.lengthOf(1);
  });

  it('leaves data and errors identical to execution without diagnostics', async () => {
    const rootValue = {
      usersNullable: () => [{ name: null }, { name: 'Ada' }],
    };
    const query = '{ usersNullable { name } }';

    const withoutDiagnostics = await executeQuery(query, rootValue);
    const withDiagnostics = await executeQuery(query, rootValue, {
      nullBubblingDiagnostics: true,
    });

    expect(withDiagnostics.data).to.deep.equal(withoutDiagnostics.data);
    expect(withDiagnostics.errors).to.deep.equal(withoutDiagnostics.errors);
    expect(withoutDiagnostics).to.not.have.property('extensions');
    expect(withDiagnostics.extensions).to.have.property('nullBubbling');
  });

  it('keeps the original error path unchanged', async () => {
    const rootValue = {
      users: () => [{ name: null }],
    };

    const result = await executeQuery('{ users { name } }', rootValue, {
      nullBubblingDiagnostics: true,
    });

    expect(result.errors?.[0].path).to.deep.equal(['users', 0, 'name']);
  });

  it('omits extensions when no non-null field fails', async () => {
    const rootValue = {
      users: () => [{ name: 'Ada' }],
    };

    const result = await executeQuery('{ users { name } }', rootValue, {
      nullBubblingDiagnostics: true,
    });

    expect(result).to.deep.equal({
      data: { users: [{ name: 'Ada' }] },
    });
  });
});
