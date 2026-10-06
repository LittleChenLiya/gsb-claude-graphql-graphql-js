import { describe, it } from 'node:test';

import { expect } from 'chai';

import { dedent } from '../../__testUtils__/dedent.ts';

import { GraphQLError } from '../../error/GraphQLError.ts';

import type { DocumentNode } from '../../language/ast.ts';
import { parse } from '../../language/parser.ts';
import { print } from '../../language/printer.ts';

import { GraphQLObjectType, GraphQLScalarType } from '../../type/definition.ts';
import { GraphQLSchema } from '../../type/schema.ts';

import { validate } from '../../validation/validate.ts';

import { executeSync } from '../../execution/execute.ts';

import { buildSchema } from '../buildASTSchema.ts';
import { inlineVariableValues } from '../inlineVariableValues.ts';

const schema = buildSchema(`
  directive @tag(name: String) on FIELD | FRAGMENT_DEFINITION | QUERY
  directive @marker on FIELD

  enum Color {
    RED
    GREEN
    BLUE
  }

  input ReviewInput {
    stars: Int = 5
    comment: String
  }

  type Query {
    field(
      a: Int
      b: Int
      color: Color
      list: [Int!]
      input: ReviewInput
      str: String
      flag: Boolean
    ): String
    extra: String
    user: User
  }

  type User {
    name: String
  }
`);

const rootValue = {
  field: (args: unknown) => `field:${JSON.stringify(args)}`,
  extra: () => 'extra',
  user: () => ({ name: 'Ann' }),
};

function inline(
  source: string,
  variableValues?: { [key: string]: unknown },
  operationName?: string,
): DocumentNode {
  return inlineVariableValues(
    schema,
    parse(source),
    variableValues,
    operationName,
  );
}

function expectValid(document: DocumentNode): void {
  expect(validate(schema, document)).to.deep.equal([]);
}

describe('inlineVariableValues', () => {
  it('throws for an unknown operation name', () => {
    expect(() => inline('{ extra }', {}, 'Missing')).to.throw(
      'Unknown operation named "Missing".',
    );
  });

  it('throws when the operation is ambiguous without a name', () => {
    expect(() => inline('query A { extra } query B { extra }')).to.throw(
      'Must provide an operation name if a document contains multiple operations.',
    );
  });

  it('substitutes provided values and removes their variable definitions', () => {
    const inlined = inline(
      'query Q($a: Int, $str: String) { field(a: $a, str: $str) }',
      { a: 4, str: 'hello' },
    );
    expect(print(inlined)).to.equal(
      'query Q {\n  field(a: 4, str: "hello")\n}',
    );
    expectValid(inlined);
  });

  it('escapes string values through AST printing', () => {
    const str = 'say "hi"\nnewline\\backslash';
    const inlined = inline('query Q($str: String) { field(str: $str) }', {
      str,
    });
    const printed = print(inlined);
    expect(printed).to.equal(
      'query Q {\n  field(str: "say \\"hi\\"\\nnewline\\\\backslash")\n}',
    );
    // The printed document parses back to the same value.
    const parsedAgain = parse(printed);
    expectValid(parsedAgain);
    const result = executeSync({ schema, document: parsedAgain, rootValue });
    expect(result).to.deep.equal({
      data: { field: `field:${JSON.stringify({ str })}` },
    });
  });

  it('distinguishes null from not provided', () => {
    const inlined = inline(
      'query Q($a: Int, $b: Int) { field(a: $a, b: $b) }',
      { a: null },
    );
    expect(print(inlined)).to.equal(
      'query Q($b: Int) {\n  field(a: null, b: $b)\n}',
    );
    expectValid(inlined);
  });

  it('substitutes enum values as enum literals', () => {
    const inlined = inline('query Q($color: Color) { field(color: $color) }', {
      color: 'GREEN',
    });
    expect(print(inlined)).to.equal('query Q {\n  field(color: GREEN)\n}');
    expectValid(inlined);
  });

  it('coerces list variables, including a single value to a list of one', () => {
    const inlined = inline('query Q($list: [Int!]) { field(list: $list) }', {
      list: 5,
    });
    expect(print(inlined)).to.equal('query Q {\n  field(list: [5])\n}');
    expectValid(inlined);

    const inlinedList = inline(
      'query Q($list: [Int!]) { field(list: $list) }',
      { list: [1, 2] },
    );
    expect(print(inlinedList)).to.equal('query Q {\n  field(list: [1, 2])\n}');
    expectValid(inlinedList);
  });

  it('substitutes input objects, applying field defaults', () => {
    const inlined = inline(
      'query Q($input: ReviewInput) { field(input: $input) }',
      { input: { comment: 'hi' } },
    );
    expect(print(inlined)).to.equal(
      'query Q {\n  field(input: { stars: 5, comment: "hi" })\n}',
    );
    expectValid(inlined);
  });

  it('keeps variables which were not provided', () => {
    const inlined = inline(
      'query Q($a: Int, $b: Int = 7) { field(a: $a, b: $b) }',
      { a: 1 },
    );
    expect(print(inlined)).to.equal(
      'query Q($b: Int = 7) {\n  field(a: 1, b: $b)\n}',
    );
    expectValid(inlined);
  });

  it('substitutes variables nested inside list and object literals', () => {
    const inlined = inline(
      'query Q($a: Int, $str: String) { field(list: [1, $a], input: { comment: $str }) }',
      { a: 2, str: 'x' },
    );
    expect(print(inlined)).to.equal(
      'query Q {\n  field(list: [1, 2], input: { comment: "x" })\n}',
    );
    expectValid(inlined);
  });

  it('substitutes variables in custom directive arguments', () => {
    const inlined = inline(
      'query Q($str: String) { field(str: $str) @tag(name: $str) @marker }',
      { str: 'tagged' },
    );
    expect(print(inlined)).to.equal(
      'query Q {\n  field(str: "tagged") @tag(name: "tagged") @marker\n}',
    );
    expectValid(inlined);
  });

  it('does not modify the original document', () => {
    const document = parse(
      'query Q($a: Int) { field(a: $a) @tag(name: "keep") }',
    );
    const printedBefore = print(document);
    inlineVariableValues(schema, document, { a: 1 });
    expect(print(document)).to.equal(printedBefore);
  });

  it('evaluates @skip and @include with known boolean values', () => {
    const source = dedent`
      query Q($skipFlag: Boolean!, $includeFlag: Boolean!, $unknown: Boolean!) {
        a: extra @skip(if: $skipFlag)
        b: extra @skip(if: false)
        c: extra @include(if: $includeFlag)
        d: extra @include(if: true)
        e: extra @skip(if: $unknown)
      }
    `;
    const inlined = inline(source, { skipFlag: true, includeFlag: false });
    expect(print(inlined)).to.equal(dedent`
      query Q($unknown: Boolean!) {
        b: extra
        d: extra
        e: extra @skip(if: $unknown)
      }
    `);
    expectValid(inlined);
  });

  it('evaluates literal boolean directives even without variable values', () => {
    const inlined = inline(
      '{ a: extra @skip(if: true), b: extra @include(if: true) }',
    );
    expect(print(inlined)).to.equal('{\n  b: extra\n}');
    expectValid(inlined);
  });

  it('keeps directives depending on unknown variables', () => {
    const inlined = inline(
      'query Q($flag: Boolean!) { extra @include(if: $flag) }',
    );
    expect(print(inlined)).to.equal(
      'query Q($flag: Boolean!) {\n  extra @include(if: $flag)\n}',
    );
    expectValid(inlined);
  });

  it('leaves a @skip directive without an if argument untouched', () => {
    // Not a valid document, but the utility only rewrites what it knows.
    const inlined = inline('{ extra @skip }');
    expect(print(inlined)).to.equal('{\n  extra @skip\n}');
  });

  it('removes variable definitions unused after directive evaluation', () => {
    const inlined = inline(
      'query Q($flag: Boolean!) { extra @include(if: $flag) }',
      { flag: true },
    );
    expect(print(inlined)).to.equal('query Q {\n  extra\n}');
    expectValid(inlined);
  });

  it('executes the same as the original query (fragment and input defaults)', () => {
    const source = dedent`
      query Get($full: Boolean!, $input: ReviewInput) {
        field(input: $input)
        ...More @include(if: $full)
      }

      fragment More on Query {
        extra
      }
    `;
    for (const full of [true, false]) {
      const variableValues = { full, input: { comment: 'hi' } };
      const document = parse(source);
      const inlined = inlineVariableValues(schema, document, variableValues);
      expectValid(inlined);

      const expected = executeSync({
        schema,
        document,
        rootValue,
        variableValues,
      });
      const actual = executeSync({ schema, document: inlined, rootValue });
      expect(actual).to.deep.equal(expected);
    }

    // With `full: false` the fragment spread is removed and its now unused
    // fragment definition is dropped.
    const inlined = inline(source, { full: false, input: {} });
    expect(print(inlined)).to.equal(dedent`
      query Get {
        field(input: { stars: 5 })
      }
    `);
  });

  it('keeps a fragment used in multiple positions when one spread is removed', () => {
    const inlined = inline(
      dedent`
        query Q($flag: Boolean!) {
          ...Parts @include(if: $flag)
          ...Parts
        }

        fragment Parts on Query {
          extra
        }
      `,
      { flag: false },
    );
    expect(print(inlined)).to.equal(dedent`
      query Q {
        ...Parts
      }

      fragment Parts on Query {
        extra
      }
    `);
    expectValid(inlined);
  });

  it('handles multi-operation documents, duplicating shared fragments', () => {
    const source = dedent`
      query A($x: Int!) {
        a: field(a: $x)
        ...Shared
      }

      query B($x: Int!) {
        b: field(a: $x)
        ...Shared
      }

      fragment Shared on Query {
        shared: field(a: $x)
      }
    `;
    const document = parse(source);
    const inlined = inlineVariableValues(schema, document, { x: 1 }, 'A');
    expectValid(inlined);
    expect(print(inlined)).to.equal(dedent`
      query A {
        a: field(a: 1)
        ...Shared__inlined
      }

      query B($x: Int!) {
        b: field(a: $x)
        ...Shared
      }

      fragment Shared on Query {
        shared: field(a: $x)
      }

      fragment Shared__inlined on Query {
        shared: field(a: 1)
      }
    `);

    // Both operations still execute as before.
    const expectedA = executeSync({
      schema,
      document,
      rootValue,
      variableValues: { x: 1 },
      operationName: 'A',
    });
    const actualA = executeSync({
      schema,
      document: inlined,
      rootValue,
      operationName: 'A',
    });
    expect(actualA).to.deep.equal(expectedA);

    const expectedB = executeSync({
      schema,
      document,
      rootValue,
      variableValues: { x: 2 },
      operationName: 'B',
    });
    const actualB = executeSync({
      schema,
      document: inlined,
      rootValue,
      variableValues: { x: 2 },
      operationName: 'B',
    });
    expect(actualB).to.deep.equal(expectedB);
  });

  it('generates a unique name when the default copy name is taken', () => {
    const source = dedent`
      query A($x: Int!) {
        ...Shared
      }

      query B($x: Int!) {
        ...Shared
      }

      fragment Shared on Query {
        field(a: $x)
      }

      fragment Shared__inlined on Query {
        extra
      }
    `;
    const inlined = inline(source, { x: 1 }, 'A');
    expect(print(inlined)).to.contain('fragment Shared__inlined1 on Query');
    expectValid(inlined);
  });

  it('transforms nested fragments transitively', () => {
    const source = dedent`
      query Q($x: Int!) {
        ...Outer
      }

      fragment Outer on Query {
        ...Inner
      }

      fragment Inner on Query {
        field(a: $x)
      }
    `;
    const inlined = inline(source, { x: 3 });
    expect(print(inlined)).to.equal(dedent`
      query Q {
        ...Outer
      }

      fragment Outer on Query {
        ...Inner
      }

      fragment Inner on Query {
        field(a: 3)
      }
    `);
    expectValid(inlined);
  });

  it('evaluates directives on inline fragments', () => {
    const inlined = inline(
      'query Q($flag: Boolean!) { ... on Query @skip(if: $flag) { extra } extra }',
      { flag: true },
    );
    expect(print(inlined)).to.equal('query Q {\n  extra\n}');
    expectValid(inlined);
  });

  it('respects fragment scoped variables shadowing operation variables', () => {
    const document = parse(
      dedent`
        query Q($v: Int!) {
          ...F(v: $v)
        }

        fragment F($v: Int = 0) on Query {
          field(a: $v)
        }
      `,
      { experimentalFragmentArguments: true },
    );
    const inlined = inlineVariableValues(schema, document, { v: 9 });
    // The operation variable is inlined into the fragment spread argument,
    // while the fragment scoped variable is left untouched.
    expect(print(inlined)).to.equal(dedent`
      query Q {
        ...F(v: 9)
      }

      fragment F($v: Int = 0) on Query {
        field(a: $v)
      }
    `);
  });

  it('passes through documents with missing fragment definitions', () => {
    const source = dedent`
      query A($x: Int!) {
        field(a: $x)
        ...MissingA
      }

      query B {
        ...MissingB
      }
    `;
    const inlined = inline(source, { x: 1 }, 'A');
    expect(print(inlined)).to.equal(dedent`
      query A {
        field(a: 1)
        ...MissingA
      }

      query B {
        ...MissingB
      }
    `);
  });

  it('preserves non-executable definitions', () => {
    const document = parse(dedent`
      query Q($x: Int!) {
        field(a: $x)
      }

      extend schema @tag(name: "schema")
    `);
    const inlined = inlineVariableValues(schema, document, { x: 1 });
    expect(print(inlined)).to.equal(dedent`
      query Q {
        field(a: 1)
      }

      extend schema @tag(name: "schema")
    `);
  });

  it('transforms directives on operations and fragment definitions', () => {
    const inlined = inline(
      dedent`
        query Q($str: String) @tag(name: $str) {
          ...F
        }

        fragment F on Query @tag(name: $str) {
          extra
        }
      `,
      { str: 'op' },
    );
    expect(print(inlined)).to.equal(dedent`
      query Q @tag(name: "op") {
        ...F
      }

      fragment F on Query @tag(name: "op") {
        extra
      }
    `);
    expectValid(inlined);
  });

  it('throws with the original position for invalid variable values', () => {
    const document = parse('query Q($x: Int) { field(a: $x) }');
    let error: unknown;
    try {
      inlineVariableValues(schema, document, { x: 'not-an-int' });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(GraphQLError);
    const graphqlError = error as GraphQLError;
    expect(graphqlError.message).to.equal(
      'Variable "$x" got invalid value "not-an-int".',
    );
    expect(graphqlError.locations).to.deep.equal([{ line: 1, column: 9 }]);
  });

  it('throws with the original position for unknown variable types', () => {
    const document = parse('query Q($x: Missing) { field(a: $x) }');
    let error: unknown;
    try {
      inlineVariableValues(schema, document, { x: 1 });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(GraphQLError);
    const graphqlError = error as GraphQLError;
    expect(graphqlError.message).to.equal(
      'Variable "$x" cannot be inlined because its type is not a defined input type.',
    );
    expect(graphqlError.locations).to.deep.equal([{ line: 1, column: 13 }]);
  });

  it('throws when a coerced value cannot be converted to a literal', () => {
    const weirdScalar = new GraphQLScalarType({
      name: 'Weird',
      coerceInputValue: () => () => null,
    });
    const weirdSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          field: { type: weirdScalar },
        },
      }),
      types: [weirdScalar],
    });
    const document = parse('query Q($x: Weird) { field }');
    expect(() =>
      inlineVariableValues(weirdSchema, document, { x: 1 }),
    ).to.throw('Variable "$x" got invalid value 1.');
  });

  it('throws with the original position when the final selection set is empty', () => {
    const document = parse(
      'query Q($flag: Boolean!) { extra @skip(if: $flag) }',
    );
    let error: unknown;
    try {
      inlineVariableValues(schema, document, { flag: true });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(GraphQLError);
    const graphqlError = error as GraphQLError;
    expect(graphqlError.message).to.equal(
      'Inlining variable values produces an empty selection set, which cannot be expressed as a valid GraphQL document.',
    );
    // Points at the selection set of the original operation.
    expect(graphqlError.locations).to.deep.equal([{ line: 1, column: 26 }]);
  });

  it('throws when a nested selection set becomes empty', () => {
    const document = parse(
      'query Q($flag: Boolean!) { user { name @include(if: $flag) } }',
    );
    let error: unknown;
    try {
      inlineVariableValues(schema, document, { flag: false });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(GraphQLError);
    expect((error as GraphQLError).message).to.contain('empty selection set');
    expect((error as GraphQLError).locations).to.deep.equal([
      { line: 1, column: 33 },
    ]);
  });

  it('evaluates directives inside fragment definitions', () => {
    const inlined = inline(
      dedent`
        query Q($flag: Boolean!) {
          ...F
        }

        fragment F on Query {
          extra @include(if: $flag)
          user {
            name
          }
        }
      `,
      { flag: false },
    );
    expect(print(inlined)).to.equal(dedent`
      query Q {
        ...F
      }

      fragment F on Query {
        user {
          name
        }
      }
    `);
    expectValid(inlined);
  });

  it('keeps inline fragments whose directives always pass', () => {
    const inlined = inline(
      dedent`
        query Q($flag: Boolean!) {
          ... on Query @include(if: $flag) {
            extra
          }
        }
      `,
      { flag: true },
    );
    expect(print(inlined)).to.equal(dedent`
      query Q {
        ... on Query {
          extra
        }
      }
    `);
    expectValid(inlined);
  });

  it('substitutes other operation variables inside fragments with scoped variables', () => {
    const document = parse(
      dedent`
        query Q($v: Int!, $w: Int!) {
          ...F(v: $v)
        }

        fragment F($v: Int = 0) on Query {
          field(a: $v, b: $w)
        }
      `,
      { experimentalFragmentArguments: true },
    );
    const inlined = inlineVariableValues(schema, document, { v: 9, w: 2 });
    expect(print(inlined)).to.equal(dedent`
      query Q {
        ...F(v: 9)
      }

      fragment F($v: Int = 0) on Query {
        field(a: $v, b: 2)
      }
    `);
  });

  it('follows fragment spreads nested inside field selection sets', () => {
    const inlined = inline(
      dedent`
        query Q($x: Int!) {
          field(a: $x)
          user {
            ...F
          }
        }

        fragment F on User {
          name
        }
      `,
      { x: 1 },
    );
    expect(print(inlined)).to.equal(dedent`
      query Q {
        field(a: 1)
        user {
          ...F
        }
      }

      fragment F on User {
        name
      }
    `);
    expectValid(inlined);
  });
});
