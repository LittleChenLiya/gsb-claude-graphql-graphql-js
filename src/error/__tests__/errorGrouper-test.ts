import { describe, it } from 'node:test';

import { expect } from 'chai';

import { parse } from '../../language/parser.ts';

import {
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
} from '../../type/definition.ts';
import { GraphQLString } from '../../type/scalars.ts';
import { GraphQLSchema } from '../../type/schema.ts';

import { executeSync } from '../../execution/execute.ts';

import { categorizeGraphQLError, groupGraphQLErrors } from '../errorGrouper.ts';
import { GraphQLError } from '../GraphQLError.ts';

const sharedCause = new Error('shared resolver failure');

const ItemType: GraphQLObjectType = new GraphQLObjectType({
  name: 'Item',
  fields: {
    label: {
      type: GraphQLString,
      resolve() {
        throw sharedCause;
      },
    },
  },
});

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      nickname: {
        type: GraphQLString,
        resolve() {
          throw sharedCause;
        },
      },
      items: {
        type: new GraphQLList(ItemType),
        resolve() {
          return [{}, {}];
        },
      },
    },
  }),
});

function executeErrors(source: string) {
  const result = executeSync({ schema, document: parse(source) });
  expect(result.errors).to.be.an('array');
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return result.errors!;
}

describe('categorizeGraphQLError', () => {
  it('classifies errors with an underlying cause as resolver errors', () => {
    const withCause = new GraphQLError('msg', {
      path: ['a'],
      cause: new Error('boom'),
    });
    expect(categorizeGraphQLError(withCause)).to.equal('resolver');

    const withOriginalError = new GraphQLError('msg', {
      originalError: new Error('boom'),
    });
    expect(categorizeGraphQLError(withOriginalError)).to.equal('resolver');
  });

  it('classifies path-only errors as execution errors', () => {
    const error = new GraphQLError('msg', { path: ['a', 0] });
    expect(categorizeGraphQLError(error)).to.equal('execution');
  });

  it('classifies errors without cause or path as request errors', () => {
    const error = new GraphQLError('msg');
    expect(categorizeGraphQLError(error)).to.equal('request');
  });
});

describe('groupGraphQLErrors', () => {
  it('keeps the same resolver error under two aliases as two events', () => {
    const errors = executeErrors('{ a: nickname, b: nickname }');
    expect(errors).to.have.lengthOf(2);

    const groups = groupGraphQLErrors(errors, { operation: 'TwoAliases' });

    expect(groups).to.have.lengthOf(2);
    expect(groups[0].operation).to.equal('TwoAliases');
    expect(groups[0].category).to.equal('resolver');
    // The response alias is preserved, not replaced by the schema field name.
    expect(groups[0].path).to.deep.equal(['a']);
    expect(groups[1].path).to.deep.equal(['b']);
    expect(groups[0].events).to.have.lengthOf(1);
    expect(groups[1].events).to.have.lengthOf(1);
    expect(groups[0].events[0].error).to.equal(errors[0]);
    expect(groups[1].events[0].error).to.equal(errors[1]);
  });

  it('does not merge errors at array indices 0 and 1', () => {
    const errors = executeErrors('{ items { label } }');
    expect(errors).to.have.lengthOf(2);

    const groups = groupGraphQLErrors(errors);

    expect(groups).to.have.lengthOf(2);
    expect(groups[0].path).to.deep.equal(['items', 0, 'label']);
    expect(groups[1].path).to.deep.equal(['items', 1, 'label']);
    expect(groups[0].events[0].index).to.equal(0);
    expect(groups[1].events[0].index).to.equal(1);
  });

  it('groups in original error order and merges identical keys', () => {
    const first = new GraphQLError('one', { path: ['a'] });
    const second = new GraphQLError('two', { path: ['b'] });
    const third = new GraphQLError('three', { path: ['a'] });

    const groups = groupGraphQLErrors([first, second, third]);

    expect(groups).to.have.lengthOf(2);
    expect(groups[0].path).to.deep.equal(['a']);
    expect(groups[0].count).to.equal(2);
    expect(groups[0].events.map((event) => event.index)).to.deep.equal([0, 2]);
    expect(groups[0].events[0].error).to.equal(first);
    expect(groups[0].events[1].error).to.equal(third);
    expect(groups[1].path).to.deep.equal(['b']);
    expect(groups[1].count).to.equal(1);
  });

  it('separates groups by operation label and cause category', () => {
    const resolverError = new GraphQLError('msg', {
      path: ['a'],
      cause: new Error('boom'),
    });
    const executionError = new GraphQLError('msg', { path: ['a'] });

    const byCategory = groupGraphQLErrors([resolverError, executionError]);
    expect(byCategory).to.have.lengthOf(2);
    expect(byCategory[0].category).to.equal('resolver');
    expect(byCategory[1].category).to.equal('execution');

    const byOperation = groupGraphQLErrors([executionError], {
      operation: 'Named',
    });
    expect(byOperation[0].operation).to.equal('Named');

    const defaultOperation = groupGraphQLErrors([executionError]);
    expect(defaultOperation[0].operation).to.equal('anonymous');
  });

  it('masked mode omits the message but keeps path and category', () => {
    const errors = executeErrors('{ a: nickname, b: nickname }');

    const groups = groupGraphQLErrors(errors, { maskMessages: true });

    expect(groups).to.have.lengthOf(2);
    for (const group of groups) {
      expect(group.category).to.equal('resolver');
      expect(group.path).to.be.an('array');
      const event = group.events[0];
      expect(event.message).to.equal(undefined);
      expect(event.path).to.deep.equal(group.path);
      expect(event.locations).to.equal(event.error.locations);
    }
    // The masked grouping output itself contains no message text.
    const summary = groups.map((group) => ({
      operation: group.operation,
      category: group.category,
      path: group.path,
      events: group.events.map((event) => ({
        index: event.index,
        message: event.message,
      })),
    }));
    expect(JSON.stringify(summary)).to.not.contain('shared resolver failure');
  });

  it('does not rewrite or mutate the original errors', () => {
    const cause = new Error('boom');
    const error = new GraphQLError('original message', {
      path: ['a', 0],
      cause,
    });
    const keysBefore = Object.keys(error);
    const locationsBefore = error.locations;

    const groups = groupGraphQLErrors([error], { maskMessages: true });

    expect(Object.keys(error)).to.deep.equal(keysBefore);
    expect(error.message).to.equal('original message');
    expect(error.cause).to.equal(cause);
    expect(error.locations).to.equal(locationsBefore);

    const event = groups[0].events[0];
    expect(event.error).to.equal(error);
    expect(event.locations).to.equal(locationsBefore);
    expect(event.path).to.deep.equal(['a', 0]);
    expect(event.path).to.not.equal(error.path);
  });

  it('handles errors without a path', () => {
    const requestError = new GraphQLError('Cannot query field "nope".');

    const groups = groupGraphQLErrors([requestError]);

    expect(groups).to.have.lengthOf(1);
    expect(groups[0].category).to.equal('request');
    expect(groups[0].path).to.equal(undefined);
    expect(groups[0].events[0].message).to.equal('Cannot query field "nope".');
  });

  it('keeps null-propagation execution errors distinct from resolver errors', () => {
    const nonNullSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          strict: {
            type: new GraphQLNonNull(GraphQLString),
            resolve() {
              throw sharedCause;
            },
          },
        },
      }),
    });
    const result = executeSync({
      schema: nonNullSchema,
      document: parse('{ strict }'),
    });
    const groups = groupGraphQLErrors(result.errors ?? []);
    expect(groups).to.have.lengthOf(1);
    expect(groups[0].category).to.equal('resolver');
    expect(groups[0].path).to.deep.equal(['strict']);
  });
});
