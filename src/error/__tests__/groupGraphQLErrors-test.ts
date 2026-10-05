import { describe, it } from 'node:test';

import { expect } from 'chai';

import { parse } from '../../language/parser.ts';

import { execute } from '../../execution/execute.ts';

import { buildSchema } from '../../utilities/buildASTSchema.ts';

import { GraphQLError } from '../GraphQLError.ts';
import {
  formatGroupedErrors,
  groupGraphQLErrors,
} from '../groupGraphQLErrors.ts';

const schema = buildSchema(`
  type Query {
    thing: Thing
    things: [Thing]
  }

  type Thing {
    name: String
  }
`);

function throwingThing(): never {
  throw new Error('resolver failed');
}

function throwingName(): never {
  throw new Error('name failed');
}

function executeQuery(query: string, rootValue: unknown) {
  return execute({ schema, document: parse(query), rootValue });
}

function getErrors(result: Awaited<ReturnType<typeof executeQuery>>) {
  const { errors } = result;
  if (errors == null) {
    throw new Error('Expected errors to be present');
  }
  return errors;
}

describe('groupGraphQLErrors', () => {
  it('demo: groups three errors by operation, path, and category', async () => {
    // Two aliases of the same throwing resolver plus one list item error.
    const result = await executeQuery(
      `
        query Demo {
          first: thing { name }
          second: thing { name }
          things { name }
        }
      `,
      {
        thing: throwingThing,
        things: () => [{ get name() { return throwingName(); } }],
      },
    );

    expect(result.errors).to.have.lengthOf(3);

    const groups = groupGraphQLErrors(getErrors(result), { operation: 'Demo' });

    // Each path is distinct, so the three errors form three groups.
    expect(groups).to.have.lengthOf(3);
    expect(groups.map((g) => g.path)).to.deep.equal([
      ['first'],
      ['second'],
      ['things', 0, 'name'],
    ]);
    expect(groups.map((g) => g.category)).to.deep.equal([
      'INTERNAL',
      'INTERNAL',
      'INTERNAL',
    ]);
    expect(groups.map((g) => g.operation)).to.deep.equal([
      'Demo',
      'Demo',
      'Demo',
    ]);
    // Each group keeps its original errors and locations.
    for (const group of groups) {
      expect(group.errors).to.have.lengthOf(1);
      expect(group.errors[0]).to.be.instanceOf(GraphQLError);
      expect(group.errors[0].locations).to.not.equal(undefined);
    }
  });

  it('keeps two events when the same resolver error appears under two aliases', async () => {
    const result = await executeQuery(
      `
        query Aliases {
          first: thing { name }
          second: thing { name }
        }
      `,
      { thing: throwingThing },
    );

    expect(result.errors).to.have.lengthOf(2);

    const groups = groupGraphQLErrors(getErrors(result), {
      operation: 'Aliases',
    });

    // Aliases are preserved verbatim, so the two errors are separate events.
    expect(groups).to.have.lengthOf(2);
    expect(groups[0].path).to.deep.equal(['first']);
    expect(groups[1].path).to.deep.equal(['second']);
    expect(groups[0].errors[0]).to.equal(getErrors(result)[0]);
    expect(groups[1].errors[0]).to.equal(getErrors(result)[1]);
  });
  it('does not merge list items 0 and 1', async () => {
    const result = await executeQuery(
      `
        query Lists {
          things { name }
        }
      `,
      {
        things: () => [
          { get name() { return throwingName(); } },
          { get name() { return throwingName(); } },
        ],
      },
    );

    expect(result.errors).to.have.lengthOf(2);

    const groups = groupGraphQLErrors(getErrors(result), { operation: 'Lists' });

    // List indices are preserved verbatim, so items 0 and 1 are not merged.
    expect(groups).to.have.lengthOf(2);
    expect(groups[0].path).to.deep.equal(['things', 0, 'name']);
    expect(groups[1].path).to.deep.equal(['things', 1, 'name']);
  });

  it('treats the same cause at different locations as separate events', () => {
    const cause = new Error('shared cause');
    const errors = [
      new GraphQLError('one', {
        path: ['a'],
        cause,
        extensions: { code: 'INTERNAL' },
      }),
      new GraphQLError('two', {
        path: ['b'],
        cause,
        extensions: { code: 'INTERNAL' },
      }),
    ];

    const groups = groupGraphQLErrors(errors);

    expect(groups).to.have.lengthOf(2);
    expect(groups[0].path).to.deep.equal(['a']);
    expect(groups[1].path).to.deep.equal(['b']);
  });

  it('groups errors that share operation, path, and category', () => {
    const errors = [
      new GraphQLError('first', {
        path: ['a'],
        extensions: { code: 'INTERNAL' },
      }),
      new GraphQLError('second', {
        path: ['a'],
        extensions: { code: 'INTERNAL' },
      }),
    ];

    const groups = groupGraphQLErrors(errors, { operation: 'Op' });

    expect(groups).to.have.lengthOf(1);
    expect(groups[0].errors).to.have.lengthOf(2);
    expect(groups[0].errors[0]).to.equal(errors[0]);
    expect(groups[0].errors[1]).to.equal(errors[1]);
  });

  it('orders groups by first occurrence in the original errors array', () => {
    const errors = [
      new GraphQLError('z', { path: ['z'], extensions: { code: 'INTERNAL' } }),
      new GraphQLError('a', { path: ['a'], extensions: { code: 'INTERNAL' } }),
      new GraphQLError('m', { path: ['m'], extensions: { code: 'INTERNAL' } }),
    ];

    const groups = groupGraphQLErrors(errors);

    expect(groups.map((g) => g.path)).to.deep.equal([
      ['z'],
      ['a'],
      ['m'],
    ]);
  });
  it('never rewrites the original errors', () => {
    const errors = [
      new GraphQLError('original message', {
        path: ['a', 0],
        extensions: { code: 'INTERNAL' },
      }),
    ];
    const snapshot = JSON.parse(JSON.stringify(errors));

    groupGraphQLErrors(errors, { operation: 'Op' });
    formatGroupedErrors(groupGraphQLErrors(errors), { redact: true });

    expect(JSON.parse(JSON.stringify(errors))).to.deep.equal(snapshot);
    expect(errors[0].message).to.equal('original message');
    expect(errors[0].path).to.deep.equal(['a', 0]);
  });

  it('preserves path and category in occlusion mode while omitting message', () => {
    const errors = [
      new GraphQLError('secret message', {
        path: ['first'],
        extensions: { code: 'INTERNAL' },
      }),
      new GraphQLError('another secret', {
        path: ['things', 0, 'name'],
        extensions: { code: 'NOT_FOUND' },
      }),
    ];

    const groups = groupGraphQLErrors(errors, { operation: 'Op' });
    const redacted = formatGroupedErrors(groups, { redact: true });

    expect(redacted).to.have.lengthOf(2);
    // Path and category are preserved in occlusion mode.
    expect(redacted[0].path).to.deep.equal(['first']);
    expect(redacted[0].category).to.equal('INTERNAL');
    expect(redacted[1].path).to.deep.equal(['things', 0, 'name']);
    expect(redacted[1].category).to.equal('NOT_FOUND');
    // Message text is omitted in occlusion mode.
    expect(redacted[0].events[0].message).to.equal(undefined);
    expect(redacted[1].events[0].message).to.equal(undefined);
    // Locations are preserved.
    expect(redacted[0].events[0].locations).to.equal(undefined);
  });

  it('includes message text when not in occlusion mode', () => {
    const errors = [
      new GraphQLError('visible message', {
        path: ['first'],
        extensions: { code: 'INTERNAL' },
      }),
    ];

    const groups = groupGraphQLErrors(errors, { operation: 'Op' });
    const formatted = formatGroupedErrors(groups);

    expect(formatted[0].events[0].message).to.equal('visible message');
    expect(formatted[0].path).to.deep.equal(['first']);
    expect(formatted[0].category).to.equal('INTERNAL');
  });

  it('supports a custom category derivation', () => {
    const errors = [
      new GraphQLError('one', { path: ['a'] }),
      new GraphQLError('two', { path: ['b'] }),
    ];

    const groups = groupGraphQLErrors(errors, {
      getCategory: (error) =>
        error.message === 'one' ? 'CUSTOM_ONE' : 'CUSTOM_TWO',
    });

    expect(groups[0].category).to.equal('CUSTOM_ONE');
    expect(groups[1].category).to.equal('CUSTOM_TWO');
  });
});
