import { describe, it } from 'node:test';

import { expect } from 'chai';

import { dedent } from '../../__testUtils__/dedent.ts';

import { GraphQLError } from '../../error/GraphQLError.ts';

import type { DocumentNode } from '../../language/ast.ts';
import { parse } from '../../language/parser.ts';
import { print } from '../../language/printer.ts';

import { GraphQLObjectType, GraphQLScalarType } from '../../type/definition.ts';
import { GraphQLString } from '../../type/scalars.ts';
import { GraphQLSchema } from '../../type/schema.ts';

import { validate } from '../../validation/validate.ts';

import { executeSync } from '../../execution/execute.ts';

import { buildSchema } from '../buildASTSchema.ts';
import { substituteVariables } from '../substituteVariables.ts';

const schema = buildSchema(`
  directive @tag(name: String) on FIELD

  enum Color {
    RED
    GREEN
    BLUE
  }

  input ReviewFilter {
    stars: Int = 5
    tags: [String]
  }

  type Review {
    title: String
  }

  type Query {
    reviews(filter: ReviewFilter): [String]
    reviewCount(filter: ReviewFilter): Int
    review: Review
    field(a: Int, b: Int): Int
    echo(text: String): String
    colors(first: Color, list: [Color]): [Color]
    sum(numbers: [Int]): Int
  }
`);

const rootValue = {
  reviews: (args: { filter?: { stars: number; tags?: Array<string> } }) => [
    `stars:${args.filter?.stars ?? 'none'}`,
    ...(args.filter?.tags ?? []),
  ],
  reviewCount: (args: { filter?: { stars: number } }) =>
    (args.filter?.stars ?? 0) * 2,
  echo: (args: { text?: string }) => args.text ?? null,
};

function substitute(
  document: DocumentNode,
  variableValues: { readonly [variable: string]: unknown },
  operationName?: string,
): DocumentNode {
  const substituted = substituteVariables(
    schema,
    document,
    variableValues,
    operationName,
  );
  expect(validate(schema, substituted)).to.deep.equal([]);
  return substituted;
}

function substituteAndPrint(
  document: DocumentNode,
  variableValues: { readonly [variable: string]: unknown },
  operationName?: string,
): string {
  return print(substitute(document, variableValues, operationName));
}

describe('substituteVariables', () => {
  it('substitutes provided variables and prints a valid standalone document', () => {
    const document = parse(`
      query GetReviews($filter: ReviewFilter, $withCount: Boolean!) {
        reviews(filter: $filter)
        ...ReviewCount @include(if: $withCount)
      }

      fragment ReviewCount on Query {
        reviewCount
      }
    `);

    expect(
      substituteAndPrint(document, { filter: { stars: 4 }, withCount: false }),
    ).to.equal(dedent`
      query GetReviews {
        reviews(filter: { stars: 4 })
      }
    `);

    expect(
      substituteAndPrint(document, { filter: { stars: 4 }, withCount: true }),
    ).to.equal(dedent`
      query GetReviews {
        reviews(filter: { stars: 4 })
        ...ReviewCount
      }

      fragment ReviewCount on Query {
        reviewCount
      }
    `);
  });

  it('executes identically to the original document', () => {
    const document = parse(`
      query GetReviews($withCount: Boolean!, $filter: ReviewFilter) {
        reviews(filter: $filter)
        ...CountFragment @include(if: $withCount)
      }

      fragment CountFragment on Query {
        reviewCount(filter: $filter)
      }
    `);

    for (const withCount of [true, false]) {
      const variableValues = { withCount, filter: { tags: ['featured'] } };
      const expected = executeSync({
        schema,
        document,
        variableValues,
        rootValue,
      });

      const substituted = substitute(document, variableValues);
      const actual = executeSync({ schema, document: substituted, rootValue });

      expect(actual).to.deep.equal(expected);
    }
  });

  it('distinguishes an explicit null from a not provided variable', () => {
    const document = parse('query ($a: Int, $b: Int) { field(a: $a, b: $b) }');

    // An explicit null is substituted as a null literal.
    expect(substituteAndPrint(document, { a: null })).to.equal(dedent`
      query ($b: Int) {
        field(a: null, b: $b)
      }
    `);

    // An undefined entry is treated as not provided and left untouched.
    expect(substituteAndPrint(document, { a: undefined })).to.equal(dedent`
      query ($a: Int, $b: Int) {
        field(a: $a, b: $b)
      }
    `);
  });

  it('keeps variables without provided values, including their definitions', () => {
    const document = parse(
      'query Remaining($a: Int, $b: Int) { field(a: $a, b: $b) }',
    );

    expect(substituteAndPrint(document, { b: 2 })).to.equal(dedent`
      query Remaining($a: Int) {
        field(a: $a, b: 2)
      }
    `);
  });

  it('substitutes enum values as enum literals, not strings', () => {
    const document = parse(
      'query Pick($color: Color!) { colors(first: $color) }',
    );

    expect(substituteAndPrint(document, { color: 'GREEN' })).to.equal(dedent`
      query Pick {
        colors(first: GREEN)
      }
    `);
  });

  it('coerces single values into lists of the declared type', () => {
    const document = parse(
      'query Sum($numbers: [Int]) { sum(numbers: $numbers) }',
    );
    expect(substituteAndPrint(document, { numbers: 1 })).to.equal(dedent`
      query Sum {
        sum(numbers: [1])
      }
    `);

    const enumDocument = parse(
      'query Pick($colors: [Color]) { colors(list: $colors) }',
    );
    expect(substituteAndPrint(enumDocument, { colors: 'RED' })).to.equal(
      dedent`
        query Pick {
          colors(list: [RED])
        }
      `,
    );
  });

  it('escapes string values by going through the AST', () => {
    const document = parse('query Echo($text: String) { echo(text: $text) }');
    const variableValues = { text: 'say "hi"\nbye' };

    const substituted = substitute(document, variableValues);
    expect(print(substituted)).to.equal(
      'query Echo {\n  echo(text: "say \\"hi\\"\\nbye")\n}',
    );

    // The printed document parses back to the very same value.
    const expected = executeSync({
      schema,
      document,
      variableValues,
      rootValue,
    });
    const actual = executeSync({
      schema,
      document: parse(print(substituted)),
      rootValue,
    });
    expect(actual).to.deep.equal(expected);
  });

  it('folds @skip and @include directives with known conditions', () => {
    const document = parse(`
      query Flags($flag: Boolean!) {
        a: reviewCount @skip(if: $flag)
        b: reviewCount @include(if: $flag)
      }
    `);

    expect(substituteAndPrint(document, { flag: true })).to.equal(dedent`
      query Flags {
        b: reviewCount
      }
    `);

    expect(substituteAndPrint(document, { flag: false })).to.equal(dedent`
      query Flags {
        a: reviewCount
      }
    `);
  });

  it('folds @skip and @include directives with literal conditions', () => {
    const document = parse(`
      {
        a: reviewCount @skip(if: true)
        b: reviewCount @skip(if: false)
        c: reviewCount @include(if: true)
        d: reviewCount @include(if: false)
      }
    `);

    expect(substituteAndPrint(document, {})).to.equal(dedent`
      {
        b: reviewCount
        c: reviewCount
      }
    `);
  });

  it('folds directives on inline fragments', () => {
    const document = parse(`
      query Flags($flag: Boolean!) {
        ... on Query @include(if: $flag) {
          reviewCount
        }
      }
    `);

    expect(substituteAndPrint(document, { flag: true })).to.equal(dedent`
      query Flags {
        ... on Query {
          reviewCount
        }
      }
    `);
  });

  it('keeps @skip and @include directives with unknown conditions', () => {
    const document = parse(`
      query Flags($flag: Boolean!) {
        a: reviewCount @skip(if: $flag)
        ... on Query @include(if: $flag) {
          b: reviewCount
        }
      }
    `);

    expect(substituteAndPrint(document, {})).to.equal(dedent`
      query Flags($flag: Boolean!) {
        a: reviewCount @skip(if: $flag)
        ... on Query @include(if: $flag) {
          b: reviewCount
        }
      }
    `);
  });

  it('keeps other directives and malformed conditionals untouched', () => {
    const document = parse(`
      query Flags($flag: Boolean!) {
        reviewCount @tag(name: "top") @include(if: $flag)
      }
    `);

    expect(substituteAndPrint(document, { flag: true })).to.equal(dedent`
      query Flags {
        reviewCount @tag(name: "top")
      }
    `);

    // Not valid GraphQL, but left untouched as it cannot be folded.
    const invalid = parse('{ reviewCount @include }');
    expect(print(substituteVariables(schema, invalid, {}))).to.equal(dedent`
      {
        reviewCount @include
      }
    `);
  });

  it('leaves other operations and shared fragments untouched', () => {
    const document = parse(`
      query First($filter: ReviewFilter, $flag: Boolean!) {
        reviews(filter: $filter)
        ...Shared
        ...FirstOnly @include(if: $flag)
      }

      query Second($filter: ReviewFilter) {
        ...Shared
      }

      fragment Shared on Query {
        reviewCount(filter: $filter)
      }

      fragment FirstOnly on Query {
        extraCount: reviewCount
      }
    `);

    expect(
      substituteAndPrint(
        document,
        { filter: { stars: 1 }, flag: false },
        'First',
      ),
    ).to.equal(dedent`
      query First($filter: ReviewFilter) {
        reviews(filter: { stars: 1 })
        ...Shared
      }

      query Second($filter: ReviewFilter) {
        ...Shared
      }

      fragment Shared on Query {
        reviewCount(filter: $filter)
      }
    `);

    // Substituting nothing leaves the whole document unchanged.
    expect(substituteAndPrint(document, {}, 'First')).to.equal(print(document));
  });

  it('keeps a fragment definition used by a surviving spread', () => {
    const document = parse(`
      query Details($flag: Boolean!) {
        ...Details @include(if: $flag)
        ...Details
      }

      fragment Details on Query {
        reviewCount
      }
    `);

    expect(substituteAndPrint(document, { flag: false })).to.equal(dedent`
      query Details {
        ...Details
      }

      fragment Details on Query {
        reviewCount
      }
    `);
  });

  it('throws a located error when the operation selection set becomes empty', () => {
    const document = parse(`query Flags($flag: Boolean!) {
  ...Details @include(if: $flag)
}

fragment Details on Query {
  reviewCount
}`);

    let caughtError: unknown;
    try {
      substituteVariables(schema, document, { flag: false });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).to.be.instanceof(GraphQLError);
    const gqlError = caughtError as GraphQLError;
    expect(gqlError.message).to.equal(
      'Substituting the provided variables produces an empty selection set, so a valid document cannot be generated.',
    );
    expect(gqlError.locations).to.deep.equal([{ line: 1, column: 30 }]);
  });

  it('throws a located error when a nested selection set becomes empty', () => {
    const document = parse(`query Flags($flag: Boolean!) {
  review {
    title @include(if: $flag)
  }
}`);

    let caughtError: unknown;
    try {
      substituteVariables(schema, document, { flag: false });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).to.be.instanceof(GraphQLError);
    const gqlError = caughtError as GraphQLError;
    expect(gqlError.message).to.equal(
      'Substituting the provided variables produces an empty selection set, so a valid document cannot be generated.',
    );
    expect(gqlError.locations).to.deep.equal([{ line: 2, column: 10 }]);
  });

  it('reports coercion errors at the original variable definition', () => {
    const document = parse(
      'query Pick($color: Color!) { colors(first: $color) }',
    );

    let caughtError: unknown;
    try {
      substituteVariables(schema, document, { color: 'MAUVE' });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).to.be.instanceof(GraphQLError);
    const gqlError = caughtError as GraphQLError;
    expect(gqlError.message).to.include(
      'Variable "$color" has invalid value: ',
    );
    expect(gqlError.locations).to.deep.equal([{ line: 1, column: 12 }]);
  });

  it('throws a located error for values which cannot become literals', () => {
    const oddSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          odd: {
            type: GraphQLString,
            args: { value: { type: new GraphQLScalarType({ name: 'Odd' }) } },
          },
        },
      }),
    });
    const document = parse('query ($value: Odd) { odd(value: $value) }');

    // The default literal conversion cannot represent a function value.
    let caughtError: unknown;
    try {
      substituteVariables(oddSchema, document, { value: () => null });
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).to.be.instanceof(GraphQLError);
    expect((caughtError as GraphQLError).message).to.equal(
      'Variable "$value" has a value which cannot be represented as a GraphQL literal.',
    );
    expect((caughtError as GraphQLError).locations).to.deep.equal([
      { line: 1, column: 8 },
    ]);

    // A custom scalar may also decline to produce a literal.
    const unprintableSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          odd: {
            type: GraphQLString,
            args: {
              value: {
                type: new GraphQLScalarType({
                  name: 'Unprintable',
                  valueToLiteral() {
                    throw new Error('cannot print');
                  },
                }),
              },
            },
          },
        },
      }),
    });
    const otherDocument = parse(
      'query ($value: Unprintable) { odd(value: $value) }',
    );
    expect(() =>
      substituteVariables(unprintableSchema, otherDocument, { value: 1 }),
    ).to.throw(
      GraphQLError,
      'Variable "$value" has a value which cannot be represented as a GraphQL literal.',
    );
  });

  it('throws when the operation cannot be resolved', () => {
    const multiple = parse('{ reviewCount } query B { reviewCount }');
    expect(() => substituteVariables(schema, multiple, {})).to.throw(
      GraphQLError,
      'Must provide an operation name if the document contains multiple operations.',
    );

    const single = parse('query A { reviewCount }');
    expect(() => substituteVariables(schema, single, {}, 'Nope')).to.throw(
      GraphQLError,
      'Unknown operation named "Nope".',
    );
  });

  it('returns the same document when there is nothing to substitute', () => {
    const document = parse('{ reviewCount }');
    expect(substituteVariables(schema, document, {})).to.equal(document);
  });

  it('leaves documents with unknown fragment spreads untouched', () => {
    const document = parse('{ ...Missing }');
    expect(substituteVariables(schema, document, {})).to.equal(document);
  });

  it('does not modify the original document', () => {
    const document = parse(`
      query GetReviews($filter: ReviewFilter, $withCount: Boolean!) {
        reviews(filter: $filter)
        ...ReviewCount @include(if: $withCount)
      }

      fragment ReviewCount on Query {
        reviewCount
      }
    `);
    const originalSource = print(document);

    substituteVariables(schema, document, {
      filter: { stars: 4 },
      withCount: false,
    });

    expect(print(document)).to.equal(originalSource);
  });
});
