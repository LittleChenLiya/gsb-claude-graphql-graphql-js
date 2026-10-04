import { describe, it } from 'node:test';

import { expect } from 'chai';

import { Kind } from '../../language/kinds.ts';

import {
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLObjectType,
  GraphQLScalarType,
} from '../../type/definition.ts';
import { GraphQLInt, GraphQLString } from '../../type/scalars.ts';
import { GraphQLSchema } from '../../type/schema.ts';

import {
  AuditDefaultValueIssueType,
  auditDefaultValues,
} from '../auditDefaultValues.ts';
import { buildSchema } from '../buildASTSchema.ts';

describe('auditDefaultValues', () => {
  it('returns no issues when there are no default values', () => {
    const schema = buildSchema(`
      input EmptyInput {
        value: Int
      }

      type Query {
        noDefault(arg: Int): String
      }
    `);

    expect(auditDefaultValues(schema)).to.deep.equal([]);
  });

  it('returns no issues for valid empty defaults', () => {
    const schema = buildSchema(`
      input EmptyInput {
        value: Int = null
      }

      type Query {
        noDefault(arg: Int = null): String
      }
    `);

    expect(auditDefaultValues(schema)).to.deep.equal([]);
  });

  it('reports an Int field defaulting to a string', () => {
    const schema = buildSchema(`
      input ReviewInput {
        stars: Int = "bad"
      }

      type Query {
        review(input: ReviewInput): String
      }
    `);

    expect(auditDefaultValues(schema)).to.deep.equal([
      {
        type: AuditDefaultValueIssueType.INVALID,
        path: ['ReviewInput', 'stars'],
        message:
          'ReviewInput.stars: Expected value of type "Int", found: "bad".',
      },
    ]);
  });

  it('reports an Int argument defaulting to a string', () => {
    const schema = buildSchema(`
      type Query {
        review(stars: Int = "bad"): String
      }
    `);

    expect(auditDefaultValues(schema)).to.deep.equal([
      {
        type: AuditDefaultValueIssueType.INVALID,
        path: ['Query', 'review', 'stars'],
        message:
          'Query.review.stars: Expected value of type "Int", found: "bad".',
      },
    ]);
  });

  it('locates an illegal second item in a nested list', () => {
    const schema = buildSchema(`
      input ReviewInput {
        tags: [String] = ["ok", 42, "fine"]
      }

      type Query {
        review(input: ReviewInput): String
      }
    `);

    expect(auditDefaultValues(schema)).to.deep.equal([
      {
        type: AuditDefaultValueIssueType.INVALID,
        path: ['ReviewInput', 'tags', 1],
        message:
          'ReviewInput.tags[1]: Expected value of type "String", found: 42.',
      },
    ]);
  });

  it('locates an illegal value nested inside input objects and lists', () => {
    const schema = buildSchema(`
      input ItemInput {
        name: String
        quantity: Int
      }

      input ReviewInput {
        items: [ItemInput] = [
          { name: "first", quantity: 1 },
          { name: "second", quantity: "bad" }
        ]
      }

      type Query {
        review(input: ReviewInput): String
      }
    `);

    expect(auditDefaultValues(schema)).to.deep.equal([
      {
        type: AuditDefaultValueIssueType.INVALID,
        path: ['ReviewInput', 'items', 1, 'quantity'],
        message:
          'ReviewInput.items[1].quantity: Expected value of type "Int", found: "bad".',
      },
    ]);
  });

  it('passes for a valid enum value', () => {
    const schema = buildSchema(`
      enum Episode {
        NEW_HOPE
        EMPIRE
        JEDI
      }

      input ReviewInput {
        episode: Episode = NEW_HOPE
      }

      type Query {
        review(episode: Episode = EMPIRE): String
      }
    `);

    expect(auditDefaultValues(schema)).to.deep.equal([]);
  });

  it('reports an invalid enum value', () => {
    const schema = buildSchema(`
      enum Episode {
        NEW_HOPE
        EMPIRE
      }

      input ReviewInput {
        episode: Episode = "ROGUE"
      }

      type Query {
        review(episode: Episode = ROGUE): String
      }
    `);

    expect(auditDefaultValues(schema).map((issue) => issue.path)).to.deep.equal(
      [
        ['ReviewInput', 'episode'],
        ['Query', 'review', 'episode'],
      ],
    );
  });

  it('reports non-null fields defaulting to null', () => {
    const schema = buildSchema(`
      input ReviewInput {
        stars: Int! = null
      }

      type Query {
        review(stars: Int! = null): String
      }
    `);

    expect(auditDefaultValues(schema)).to.deep.equal([
      {
        type: AuditDefaultValueIssueType.INVALID,
        path: ['ReviewInput', 'stars'],
        message:
          'ReviewInput.stars: Expected value of non-null type "Int!" not to be null, found: null.',
      },
      {
        type: AuditDefaultValueIssueType.INVALID,
        path: ['Query', 'review', 'stars'],
        message:
          'Query.review.stars: Expected value of non-null type "Int!" not to be null, found: null.',
      },
    ]);
  });

  it('reports missing required fields in input object defaults', () => {
    const schema = buildSchema(`
      input ReviewInput {
        stars: Int!
        commentary: String
      }

      type Query {
        review(input: ReviewInput = { commentary: "ok" }): String
      }
    `);

    expect(auditDefaultValues(schema)).to.deep.equal([
      {
        type: AuditDefaultValueIssueType.INVALID,
        path: ['Query', 'review', 'input', 'stars'],
        message:
          'Query.review.input.stars: Expected value of type "ReviewInput" to include required field "stars", found: { commentary: "ok" }.',
      },
    ]);
  });

  it('reports unknown fields in input object defaults', () => {
    const schema = buildSchema(`
      input ReviewInput {
        stars: Int
      }

      type Query {
        review(input: ReviewInput = { stars: 5, unknown: 1 }): String
      }
    `);

    expect(auditDefaultValues(schema)).to.deep.equal([
      {
        type: AuditDefaultValueIssueType.INVALID,
        path: ['Query', 'review', 'input'],
        message:
          'Query.review.input: Expected value of type "ReviewInput" not to include unknown field "unknown", found: { stars: 5, unknown: 1 }.',
      },
    ]);
  });

  it('reports a custom scalar without an adapter as unknown', () => {
    const DateTime = new GraphQLScalarType({ name: 'DateTime' });

    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          review: {
            type: GraphQLString,
            args: {
              at: { type: DateTime, defaultValue: '2024-01-01' },
            },
          },
        },
      }),
    });

    expect(auditDefaultValues(schema)).to.deep.equal([
      {
        type: AuditDefaultValueIssueType.UNKNOWN_SCALAR,
        path: ['Query', 'review', 'at'],
        message:
          'Query.review.at: Cannot audit default value of custom scalar "DateTime" without an adapter; provide a scalar adapter to audit this value.',
      },
    ]);
  });

  it('does not invoke scalar logic when no adapter is provided', () => {
    let serializeCalls = 0;
    const DateTime = new GraphQLScalarType({
      name: 'DateTime',
      serialize(value) {
        serializeCalls++;
        return value;
      },
    });

    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          review: {
            type: GraphQLString,
            args: {
              at: { type: DateTime, defaultValue: '2024-01-01' },
            },
          },
        },
      }),
    });

    let scalarAuditCount = 0;
    auditDefaultValues(schema, {
      onScalarAudit: () => {
        scalarAuditCount++;
      },
    });

    expect(serializeCalls).to.equal(0);
    expect(scalarAuditCount).to.equal(0);
  });

  it('invokes the adapter for custom scalars and counts audits', () => {
    const DateTime = new GraphQLScalarType({ name: 'DateTime' });

    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          review: {
            type: GraphQLString,
            args: {
              at: { type: DateTime, defaultValue: '2024-01-01' },
              badAt: { type: DateTime, defaultValue: 'not-a-date' },
            },
          },
        },
      }),
    });

    let scalarAuditCount = 0;
    const issues = auditDefaultValues(schema, {
      scalarAdapters: {
        DateTime: (value) => {
          scalarAuditCount++;
          if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
            return { kind: Kind.STRING, value, block: false };
          }
          return undefined;
        },
      },
    });

    expect(scalarAuditCount).to.equal(2);
    expect(issues).to.deep.equal([
      {
        type: AuditDefaultValueIssueType.INVALID,
        path: ['Query', 'review', 'badAt'],
        message:
          'Query.review.badAt: Expected value of type "DateTime", found: "not-a-date".',
      },
    ]);
  });

  it('audits runtime values and literals consistently', () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          review: {
            type: GraphQLString,
            args: {
              runtime: { type: GraphQLInt, defaultValue: 'bad' },
              literal: {
                type: GraphQLInt,
                default: { literal: { kind: Kind.STRING, value: 'bad' } },
              },
            },
          },
        },
      }),
    });

    expect(
      auditDefaultValues(schema).map((issue) => issue.message),
    ).to.deep.equal([
      'Query.review.runtime: Expected value of type "Int", found: "bad".',
      'Query.review.literal: Expected value of type "Int", found: "bad".',
    ]);
  });

  it('audits nested input object defaults built programmatically', () => {
    const ItemInput = new GraphQLInputObjectType({
      name: 'ItemInput',
      fields: {
        name: { type: GraphQLString },
        quantity: { type: GraphQLInt },
      },
    });

    const ReviewInput = new GraphQLInputObjectType({
      name: 'ReviewInput',
      fields: {
        items: {
          type: new GraphQLList(ItemInput),
          defaultValue: [
            { name: 'first', quantity: 1 },
            { name: 'second', quantity: 'bad' },
          ],
        },
      },
    });

    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          review: {
            type: GraphQLString,
            args: { input: { type: ReviewInput } },
          },
        },
      }),
    });

    expect(auditDefaultValues(schema)).to.deep.equal([
      {
        type: AuditDefaultValueIssueType.INVALID,
        path: ['ReviewInput', 'items', 1, 'quantity'],
        message:
          'ReviewInput.items[1].quantity: Expected value of type "Int", found: "bad".',
      },
    ]);
  });

  it('does not flag every level of a recursive type, only the actual bad value', () => {
    const NodeInput: GraphQLInputObjectType = new GraphQLInputObjectType({
      name: 'NodeInput',
      fields: () => ({
        value: { type: GraphQLInt },
        children: { type: new GraphQLList(NodeInput) },
      }),
    });

    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          tree: {
            type: GraphQLString,
            args: {
              root: {
                type: NodeInput,
                defaultValue: {
                  value: 1,
                  children: [
                    { value: 2, children: [{ value: 'bad' }] },
                    { value: 3 },
                  ],
                },
              },
            },
          },
        },
      }),
    });

    expect(auditDefaultValues(schema)).to.deep.equal([
      {
        type: AuditDefaultValueIssueType.INVALID,
        path: ['Query', 'tree', 'root', 'children', 0, 'children', 0, 'value'],
        message:
          'Query.tree.root.children[0].children[0].value: Expected value of type "Int", found: "bad".',
      },
    ]);
  });

  it('does not recurse infinitely on cyclic values', () => {
    const NodeInput: GraphQLInputObjectType = new GraphQLInputObjectType({
      name: 'NodeInput',
      fields: () => ({
        value: { type: GraphQLInt },
        children: { type: new GraphQLList(NodeInput) },
      }),
    });

    const cyclic: any = { value: 1 };
    cyclic.children = [cyclic];

    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          tree: {
            type: GraphQLString,
            args: { root: { type: NodeInput, defaultValue: cyclic } },
          },
        },
      }),
    });

    expect(auditDefaultValues(schema)).to.deep.equal([]);
  });

  it('does not modify the schema or its default values', () => {
    const schema = buildSchema(`
      input ReviewInput {
        stars: Int = "bad"
      }

      type Query {
        review(input: ReviewInput): String
      }
    `);

    const issues = auditDefaultValues(schema);

    expect(issues).to.have.lengthOf(1);
    const reviewInput = schema.getTypeMap()
      .ReviewInput as GraphQLInputObjectType;
    const starsField = reviewInput.toConfig().fields.stars;
    expect(starsField.defaultValue).to.equal(undefined);
    const literal = starsField.default?.literal;
    expect(literal?.kind).to.equal(Kind.STRING);
    expect(literal?.kind === Kind.STRING && literal.value).to.equal('bad');
  });

  it('audits directive arguments', () => {
    const schema = buildSchema(`
      directive @tag(name: String = 42) on FIELD_DEFINITION

      type Query {
        review: String
      }
    `);

    expect(auditDefaultValues(schema)).to.deep.equal([
      {
        type: AuditDefaultValueIssueType.INVALID,
        path: ['@tag', 'name'],
        message: '@tag.name: Expected value of type "String", found: 42.',
      },
    ]);
  });

  it('covers non-null, list, enum, and input object combinations', () => {
    const schema = buildSchema(`
      enum Color {
        RED
        GREEN
        BLUE
      }

      input PaletteInput {
        colors: [Color!]! = [RED, "bad", GREEN]
        name: String! = null
      }

      type Query {
        palette(input: PaletteInput): String
      }
    `);

    expect(auditDefaultValues(schema).map((issue) => issue.path)).to.deep.equal(
      [
        ['PaletteInput', 'colors', 1],
        ['PaletteInput', 'name'],
      ],
    );
  });
});
