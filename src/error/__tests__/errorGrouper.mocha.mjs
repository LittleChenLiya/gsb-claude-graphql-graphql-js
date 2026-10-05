/**
 * Mocha spec for the read-only error grouper.
 *
 * Run it with the targeted command:
 *   npm run mocha:error-grouper
 *
 * The repo-wide unit tests use node:test; this file exists so the error
 * grouper can also be verified with Mocha without re-executing any query
 * beyond the single execution used to produce the fixture errors.
 */
import assert from 'node:assert/strict';

import { describe, it } from 'mocha';

import { parse } from '../../language/parser.ts';

import { GraphQLList, GraphQLObjectType } from '../../type/definition.ts';
import { GraphQLString } from '../../type/scalars.ts';
import { GraphQLSchema } from '../../type/schema.ts';

import { executeSync } from '../../execution/execute.ts';

import { groupGraphQLErrors } from '../errorGrouper.ts';

const sharedCause = new Error('shared resolver failure');

const ItemType = new GraphQLObjectType({
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

function errorsOf(source) {
  const result = executeSync({ schema, document: parse(source) });
  assert.ok(Array.isArray(result.errors));
  return result.errors;
}

describe('errorGrouper (mocha)', () => {
  it('keeps two events when one resolver fails under two aliases', () => {
    const errors = errorsOf('{ a: nickname, b: nickname }');
    assert.equal(errors.length, 2);

    const groups = groupGraphQLErrors(errors, { operation: 'Aliases' });

    assert.equal(groups.length, 2);
    // Aliases are preserved; the schema field name never replaces them.
    assert.deepEqual(groups[0].path, ['a']);
    assert.deepEqual(groups[1].path, ['b']);
    assert.equal(groups[0].events[0].error, errors[0]);
    assert.equal(groups[1].events[0].error, errors[1]);
  });

  it('does not merge array indices 0 and 1', () => {
    const errors = errorsOf('{ items { label } }');
    assert.equal(errors.length, 2);

    const groups = groupGraphQLErrors(errors);

    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].path, ['items', 0, 'label']);
    assert.deepEqual(groups[1].path, ['items', 1, 'label']);
  });

  it('masked mode keeps path and category but drops the message', () => {
    const errors = errorsOf('{ a: nickname, b: nickname }');

    const groups = groupGraphQLErrors(errors, { maskMessages: true });

    assert.equal(groups.length, 2);
    for (const group of groups) {
      assert.equal(group.category, 'resolver');
      assert.ok(Array.isArray(group.path));
      assert.equal(group.events[0].message, undefined);
      assert.ok(group.events[0].locations.length > 0);
    }
    // The original errors are not rewritten.
    assert.equal(errors[0].message, 'shared resolver failure');
  });
});
