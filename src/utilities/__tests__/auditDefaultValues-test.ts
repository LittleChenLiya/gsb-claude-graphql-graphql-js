import { describe, it } from 'node:test';

import { expect } from 'chai';

import { DirectiveLocation } from '../../language/directiveLocation.ts';
import { parseConstValue } from '../../language/parser.ts';

import type { GraphQLInputType } from '../../type/definition.ts';
import {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
} from '../../type/definition.ts';
import { GraphQLDirective } from '../../type/directives.ts';
import { GraphQLInt, GraphQLString } from '../../type/scalars.ts';
import { GraphQLSchema } from '../../type/schema.ts';

import {
  auditDefaultValues,
  formatDefaultValueAuditPath,
} from '../auditDefaultValues.ts';
import { printSchema } from '../printSchema.ts';

const EpisodeEnum = new GraphQLEnumType({
  name: 'Episode',
  values: {
    NEW_HOPE: {},
    EMPIRE: {},
    JEDI: {},
  },
});

function schemaWithArg(
  argType: GraphQLInputType,
  argConfig: object,
): GraphQLSchema {
  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: {
        f: {
          type: GraphQLString,
          args: { a: { type: argType, ...argConfig } },
        },
      },
    }),
    directives: [],
  });
}

describe('auditDefaultValues', () => {
  it('reports zero audited defaults for a schema without defaults', () => {
    const schema = schemaWithArg(GraphQLInt, {});
    expect(auditDefaultValues(schema)).to.deep.equal({
      auditedCount: 0,
      issues: [],
      unknowns: [],
    });
  });

  it('reports an Int argument default of a string as an issue', () => {
    const schema = schemaWithArg(GraphQLInt, { defaultValue: 'bad' });
    expect(auditDefaultValues(schema)).to.deep.equal({
      auditedCount: 1,
      issues: [
        {
          path: ['Query', 'f', 'a'],
          reason:
            'Expected default value of type "Int" to be convertible to a valid literal, found: "bad".',
        },
      ],
      unknowns: [],
    });
  });

  it('accepts a valid Int default', () => {
    const schema = schemaWithArg(GraphQLInt, { defaultValue: 5 });
    expect(auditDefaultValues(schema)).to.deep.equal({
      auditedCount: 1,
      issues: [],
      unknowns: [],
    });
  });

  it('locates an invalid item within a nested list default', () => {
    const schema = schemaWithArg(new GraphQLList(new GraphQLList(GraphQLInt)), {
      defaultValue: [
        [0, 1],
        [2, 'bad'],
      ],
    });
    const report = auditDefaultValues(schema);
    expect(report.auditedCount).to.equal(1);
    expect(report.issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a', 1, 1],
        reason:
          'Expected default value of type "Int" to be convertible to a valid literal, found: "bad".',
      },
    ]);
  });

  it('locates an invalid second item within a list default', () => {
    const schema = schemaWithArg(new GraphQLList(GraphQLInt), {
      defaultValue: [1, 'bad', 3],
    });
    const report = auditDefaultValues(schema);
    expect(report.issues.map((issue) => issue.path)).to.deep.equal([
      ['Query', 'f', 'a', 1],
    ]);
  });

  it('treats a non-list default for a list type as a list of one', () => {
    const validSchema = schemaWithArg(new GraphQLList(GraphQLInt), {
      defaultValue: 5,
    });
    expect(auditDefaultValues(validSchema).issues).to.deep.equal([]);

    const invalidSchema = schemaWithArg(new GraphQLList(GraphQLInt), {
      defaultValue: 'bad',
    });
    const report = auditDefaultValues(invalidSchema);
    expect(report.issues.map((issue) => issue.path)).to.deep.equal([
      ['Query', 'f', 'a'],
    ]);
  });

  it('accepts a valid enum default', () => {
    const schema = schemaWithArg(EpisodeEnum, { defaultValue: 'JEDI' });
    expect(auditDefaultValues(schema)).to.deep.equal({
      auditedCount: 1,
      issues: [],
      unknowns: [],
    });
  });

  it('reports an invalid enum default', () => {
    const schema = schemaWithArg(EpisodeEnum, { defaultValue: 'UNKNOWN' });
    expect(auditDefaultValues(schema).issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason:
          'Expected default value of enum type "Episode" to be one of its values, found: "UNKNOWN".',
      },
    ]);
  });

  it('reports a null default for a non-null type', () => {
    const schema = schemaWithArg(new GraphQLNonNull(GraphQLInt), {
      defaultValue: null,
    });
    expect(auditDefaultValues(schema).issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason:
          'Expected default value of non-null type "Int!" not to be null.',
      },
    ]);
  });

  it('accepts a null default for a nullable type', () => {
    const schema = schemaWithArg(GraphQLInt, { defaultValue: null });
    expect(auditDefaultValues(schema)).to.deep.equal({
      auditedCount: 1,
      issues: [],
      unknowns: [],
    });
  });

  it('does not execute custom scalar serialize without an audit adapter', () => {
    let serializeCount = 0;
    const OddScalar = new GraphQLScalarType({
      name: 'Odd',
      serialize(value) {
        serializeCount++;
        return value;
      },
    });
    const schema = schemaWithArg(OddScalar, { defaultValue: 3 });

    const report = auditDefaultValues(schema);

    expect(serializeCount).to.equal(0);
    expect(report.auditedCount).to.equal(1);
    expect(report.issues).to.deep.equal([]);
    expect(report.unknowns).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason: 'No audit adapter registered for custom scalar "Odd".',
      },
    ]);
  });

  it('audits custom scalar defaults through a provided adapter', () => {
    const OddScalar = new GraphQLScalarType({ name: 'Odd' });
    const schema = schemaWithArg(OddScalar, { defaultValue: 4 });

    const seen: Array<unknown> = [];
    const report = auditDefaultValues(schema, {
      scalarAdapters: {
        Odd: (value, scalarType) => {
          seen.push([value, scalarType.name]);
          return typeof value === 'number' && value % 2 === 1
            ? true
            : `Expected an odd number, found: ${String(value)}.`;
        },
      },
    });

    expect(seen).to.deep.equal([[4, 'Odd']]);
    expect(report.unknowns).to.deep.equal([]);
    expect(report.issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason: 'Expected an odd number, found: 4.',
      },
    ]);
  });

  it('accepts a custom scalar default approved by an adapter', () => {
    const OddScalar = new GraphQLScalarType({ name: 'Odd' });
    const schema = schemaWithArg(OddScalar, { defaultValue: 3 });

    const report = auditDefaultValues(schema, {
      scalarAdapters: { Odd: () => true },
    });

    expect(report).to.deep.equal({
      auditedCount: 1,
      issues: [],
      unknowns: [],
    });
  });

  it('reports a generic reason when an adapter returns false', () => {
    const OddScalar = new GraphQLScalarType({ name: 'Odd' });
    const schema = schemaWithArg(OddScalar, { defaultValue: 4 });

    const report = auditDefaultValues(schema, {
      scalarAdapters: { Odd: () => false },
    });

    expect(report.issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason:
          'Audit adapter for custom scalar "Odd" rejected default value: 4.',
      },
    ]);
  });

  it('reports an issue when an adapter throws', () => {
    const OddScalar = new GraphQLScalarType({ name: 'Odd' });
    const schema = schemaWithArg(OddScalar, { defaultValue: 4 });

    const report = auditDefaultValues(schema, {
      scalarAdapters: {
        Odd: () => {
          throw new Error('adapter boom');
        },
      },
    });

    expect(report.issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason:
          'Audit adapter for custom scalar "Odd" threw an error: adapter boom',
      },
    ]);
  });

  it('inspects non-error values thrown by an adapter', () => {
    const OddScalar = new GraphQLScalarType({ name: 'Odd' });
    const schema = schemaWithArg(OddScalar, { defaultValue: 4 });

    const report = auditDefaultValues(schema, {
      scalarAdapters: {
        Odd: () => {
          // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error
          throw 'boom';
        },
      },
    });

    expect(report.issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason: 'Audit adapter for custom scalar "Odd" threw an error: "boom"',
      },
    ]);
  });

  it('accepts an empty options object', () => {
    const OddScalar = new GraphQLScalarType({ name: 'Odd' });
    const schema = schemaWithArg(OddScalar, { defaultValue: 3 });

    const report = auditDefaultValues(schema, {});
    expect(report.unknowns).to.have.lengthOf(1);
  });

  it('audits input object field defaults', () => {
    const ReviewInput = new GraphQLInputObjectType({
      name: 'ReviewInput',
      fields: {
        stars: { type: GraphQLInt, defaultValue: 'bad' },
      },
    });
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: { f: { type: GraphQLString } },
      }),
      types: [ReviewInput],
      directives: [],
    });

    expect(auditDefaultValues(schema).issues).to.deep.equal([
      {
        path: ['ReviewInput', 'stars'],
        reason:
          'Expected default value of type "Int" to be convertible to a valid literal, found: "bad".',
      },
    ]);
  });

  it('locates invalid values within nested input object defaults', () => {
    const ReviewInput = new GraphQLInputObjectType({
      name: 'ReviewInput',
      fields: {
        stars: { type: GraphQLInt },
        tags: { type: new GraphQLList(GraphQLString) },
      },
    });
    const schema = schemaWithArg(ReviewInput, {
      defaultValue: { stars: 'bad', tags: ['ok', { bad: 'object' }] },
    });

    expect(auditDefaultValues(schema).issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a', 'stars'],
        reason:
          'Expected default value of type "Int" to be convertible to a valid literal, found: "bad".',
      },
      {
        path: ['Query', 'f', 'a', 'tags', 1],
        reason:
          'Expected default value of type "String" to be convertible to a valid literal, found: { bad: "object" }.',
      },
    ]);
  });

  it('reports unknown fields within input object defaults', () => {
    const ReviewInput = new GraphQLInputObjectType({
      name: 'ReviewInput',
      fields: { stars: { type: GraphQLInt } },
    });
    const schema = schemaWithArg(ReviewInput, {
      defaultValue: { stars: 5, rating: 3, missing: undefined },
    });

    expect(auditDefaultValues(schema).issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason:
          'Expected default value of type "ReviewInput" not to include unknown field "rating".',
      },
    ]);
  });

  it('reports non-object defaults for input object types', () => {
    const ReviewInput = new GraphQLInputObjectType({
      name: 'ReviewInput',
      fields: { stars: { type: GraphQLInt } },
    });
    const scalarDefault = schemaWithArg(ReviewInput, { defaultValue: 5 });
    expect(auditDefaultValues(scalarDefault).issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason:
          'Expected default value of type "ReviewInput" to be an object, found: 5.',
      },
    ]);

    const arrayDefault = schemaWithArg(ReviewInput, { defaultValue: [] });
    expect(auditDefaultValues(arrayDefault).issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason:
          'Expected default value of type "ReviewInput" to be an object, found: [].',
      },
    ]);
  });

  it('reports bad values in recursive types only where they actually occur', () => {
    const TreeInput: GraphQLInputObjectType = new GraphQLInputObjectType({
      name: 'TreeInput',
      fields: () => ({
        value: { type: GraphQLInt },
        child: { type: TreeInput },
      }),
    });

    const badSchema = schemaWithArg(TreeInput, {
      defaultValue: { value: 1, child: { value: 'bad' } },
    });
    expect(auditDefaultValues(badSchema).issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a', 'child', 'value'],
        reason:
          'Expected default value of type "Int" to be convertible to a valid literal, found: "bad".',
      },
    ]);

    const goodSchema = schemaWithArg(TreeInput, {
      defaultValue: {
        value: 1,
        child: { value: 2, child: { value: 3 } },
      },
    });
    expect(auditDefaultValues(goodSchema).issues).to.deep.equal([]);
  });

  it('does not infinitely expand cyclic default values', () => {
    const TreeInput: GraphQLInputObjectType = new GraphQLInputObjectType({
      name: 'TreeInput',
      fields: () => ({
        value: { type: GraphQLInt },
        child: { type: TreeInput },
      }),
    });

    const cyclic: { value: number; child?: unknown } = { value: 1 };
    cyclic.child = cyclic;
    const schema = schemaWithArg(TreeInput, { defaultValue: cyclic });

    expect(auditDefaultValues(schema).issues).to.deep.equal([]);
  });

  it('audits interface field argument defaults', () => {
    const Iface = new GraphQLInterfaceType({
      name: 'Iface',
      fields: {
        f: {
          type: GraphQLString,
          args: { a: { type: GraphQLInt, defaultValue: 'bad' } },
        },
      },
    });
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: { f: { type: GraphQLString } },
      }),
      types: [Iface],
      directives: [],
    });

    expect(auditDefaultValues(schema).issues).to.deep.equal([
      {
        path: ['Iface', 'f', 'a'],
        reason:
          'Expected default value of type "Int" to be convertible to a valid literal, found: "bad".',
      },
    ]);
  });

  it('audits directive argument defaults', () => {
    const directive = new GraphQLDirective({
      name: 'limit',
      locations: [DirectiveLocation.FIELD_DEFINITION],
      args: { count: { type: GraphQLInt, defaultValue: 'bad' } },
    });
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: { f: { type: GraphQLString } },
      }),
      directives: [directive],
    });

    expect(auditDefaultValues(schema).issues).to.deep.equal([
      {
        path: ['@limit', 'count'],
        reason:
          'Expected default value of type "Int" to be convertible to a valid literal, found: "bad".',
      },
    ]);
  });

  it('audits the specified directives of a default schema', () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          f: {
            type: GraphQLString,
            args: { a: { type: GraphQLInt, defaultValue: 5 } },
          },
        },
      }),
    });

    const report = auditDefaultValues(schema);
    // The "a" argument plus @deprecated's "reason" default; introspection
    // types are skipped.
    expect(report.auditedCount).to.equal(2);
    expect(report.issues).to.deep.equal([]);
    expect(report.unknowns).to.deep.equal([]);
  });

  it('supports defaults provided as runtime values via "default"', () => {
    const schema = schemaWithArg(GraphQLInt, { default: { value: 'bad' } });
    expect(auditDefaultValues(schema).issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason:
          'Expected default value of type "Int" to be convertible to a valid literal, found: "bad".',
      },
    ]);
  });

  it('supports defaults provided as literals via "default"', () => {
    const validSchema = schemaWithArg(GraphQLInt, {
      default: { literal: parseConstValue('5') },
    });
    expect(auditDefaultValues(validSchema).issues).to.deep.equal([]);

    const invalidSchema = schemaWithArg(GraphQLInt, {
      default: { literal: parseConstValue('"bad"') },
    });
    expect(auditDefaultValues(invalidSchema).issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason: 'Int cannot represent non-integer value: "bad"',
      },
    ]);
  });

  it('validates null literals against non-null types', () => {
    const nonNullSchema = schemaWithArg(new GraphQLNonNull(GraphQLInt), {
      default: { literal: parseConstValue('null') },
    });
    expect(auditDefaultValues(nonNullSchema).issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason:
          'Expected default value of non-null type "Int!" not to be null.',
      },
    ]);

    const validNonNullSchema = schemaWithArg(new GraphQLNonNull(GraphQLInt), {
      default: { literal: parseConstValue('5') },
    });
    expect(auditDefaultValues(validNonNullSchema).issues).to.deep.equal([]);

    const nullableSchema = schemaWithArg(GraphQLInt, {
      default: { literal: parseConstValue('null') },
    });
    expect(auditDefaultValues(nullableSchema).issues).to.deep.equal([]);
  });

  it('locates invalid items within list literals', () => {
    const schema = schemaWithArg(new GraphQLList(GraphQLInt), {
      default: { literal: parseConstValue('[1, "bad"]') },
    });
    const report = auditDefaultValues(schema);
    expect(report.issues.map((issue) => issue.path)).to.deep.equal([
      ['Query', 'f', 'a', 1],
    ]);
  });

  it('treats a non-list literal for a list type as a list of one', () => {
    const schema = schemaWithArg(new GraphQLList(GraphQLInt), {
      default: { literal: parseConstValue('"bad"') },
    });
    const report = auditDefaultValues(schema);
    expect(report.issues.map((issue) => issue.path)).to.deep.equal([
      ['Query', 'f', 'a'],
    ]);
  });

  it('validates enum literals', () => {
    const validSchema = schemaWithArg(EpisodeEnum, {
      default: { literal: parseConstValue('JEDI') },
    });
    expect(auditDefaultValues(validSchema).issues).to.deep.equal([]);

    const unknownNameSchema = schemaWithArg(EpisodeEnum, {
      default: { literal: parseConstValue('UNKNOWN') },
    });
    expect(auditDefaultValues(unknownNameSchema).issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason:
          'Expected default value of enum type "Episode" to be one of its values, found: UNKNOWN.',
      },
    ]);

    const wrongKindSchema = schemaWithArg(EpisodeEnum, {
      default: { literal: parseConstValue('"JEDI"') },
    });
    expect(auditDefaultValues(wrongKindSchema).issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason:
          'Expected default value of enum type "Episode" to be one of its values, found: "JEDI".',
      },
    ]);
  });

  it('validates input object literals', () => {
    const ReviewInput = new GraphQLInputObjectType({
      name: 'ReviewInput',
      fields: {
        stars: { type: GraphQLInt },
        tags: { type: new GraphQLList(GraphQLString) },
      },
    });

    const validSchema = schemaWithArg(ReviewInput, {
      default: { literal: parseConstValue('{ stars: 5 }') },
    });
    expect(auditDefaultValues(validSchema).issues).to.deep.equal([]);

    const invalidSchema = schemaWithArg(ReviewInput, {
      default: {
        literal: parseConstValue('{ stars: "bad", rating: 3 }'),
      },
    });
    expect(auditDefaultValues(invalidSchema).issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a', 'stars'],
        reason: 'Int cannot represent non-integer value: "bad"',
      },
      {
        path: ['Query', 'f', 'a'],
        reason:
          'Expected default value of type "ReviewInput" not to include unknown field "rating".',
      },
    ]);

    const nonObjectSchema = schemaWithArg(ReviewInput, {
      default: { literal: parseConstValue('5') },
    });
    expect(auditDefaultValues(nonObjectSchema).issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason:
          'Expected default value of type "ReviewInput" to be an object, found: 5.',
      },
    ]);
  });

  it('marks custom scalar literals as unknown without an adapter', () => {
    let serializeCount = 0;
    const OddScalar = new GraphQLScalarType({
      name: 'Odd',
      serialize(value) {
        serializeCount++;
        return value;
      },
    });
    const schema = schemaWithArg(OddScalar, {
      default: { literal: parseConstValue('3') },
    });

    const report = auditDefaultValues(schema);

    expect(serializeCount).to.equal(0);
    expect(report.issues).to.deep.equal([]);
    expect(report.unknowns).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason: 'No audit adapter registered for custom scalar "Odd".',
      },
    ]);
  });

  it('audits custom scalar literals through a provided adapter', () => {
    const OddScalar = new GraphQLScalarType({ name: 'Odd' });
    const schema = schemaWithArg(OddScalar, {
      default: { literal: parseConstValue('4') },
    });

    const accepted = auditDefaultValues(schema, {
      scalarAdapters: { Odd: () => true },
    });
    expect(accepted.issues).to.deep.equal([]);
    expect(accepted.unknowns).to.deep.equal([]);

    const rejected = auditDefaultValues(schema, {
      scalarAdapters: { Odd: () => false },
    });
    expect(rejected.issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason:
          'Audit adapter for custom scalar "Odd" rejected default value: 4.',
      },
    ]);

    const reasoned = auditDefaultValues(schema, {
      scalarAdapters: { Odd: () => 'Not odd.' },
    });
    expect(reasoned.issues).to.deep.equal([
      { path: ['Query', 'f', 'a'], reason: 'Not odd.' },
    ]);

    const throwing = auditDefaultValues(schema, {
      scalarAdapters: {
        Odd: () => {
          // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error
          throw 'boom';
        },
      },
    });
    expect(throwing.issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason: 'Audit adapter for custom scalar "Odd" threw an error: "boom"',
      },
    ]);

    const throwingError = auditDefaultValues(schema, {
      scalarAdapters: {
        Odd: () => {
          throw new Error('adapter boom');
        },
      },
    });
    expect(throwingError.issues).to.deep.equal([
      {
        path: ['Query', 'f', 'a'],
        reason:
          'Audit adapter for custom scalar "Odd" threw an error: adapter boom',
      },
    ]);
  });

  it('does not modify the schema', () => {
    const schema = schemaWithArg(GraphQLInt, { defaultValue: 5 });
    const before = printSchema(schema);
    auditDefaultValues(schema);
    expect(printSchema(schema)).to.equal(before);
  });

  it('formats audit entry paths', () => {
    expect(
      formatDefaultValueAuditPath(['Query', 'review', 'stars', 1]),
    ).to.equal('Query.review.stars[1]');
    expect(formatDefaultValueAuditPath(['@deprecated', 'reason'])).to.equal(
      '@deprecated.reason',
    );
    expect(formatDefaultValueAuditPath([])).to.equal('');
  });
});
