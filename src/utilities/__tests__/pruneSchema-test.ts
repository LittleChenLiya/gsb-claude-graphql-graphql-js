import { describe, it } from 'node:test';

import { expect } from 'chai';

import { dedent } from '../../__testUtils__/dedent.ts';

import { parse } from '../../language/parser.ts';

import type { GraphQLInterfaceType } from '../../type/definition.ts';
import { validateSchema } from '../../type/validate.ts';

import { buildSchema } from '../buildASTSchema.ts';
import { extendSchema } from '../extendSchema.ts';
import { printSchema } from '../printSchema.ts';
import { pruneSchema } from '../pruneSchema.ts';

describe('pruneSchema', () => {
  it('keeps only the selected query entry points and their dependencies', () => {
    const schema = buildSchema(`
      type Query {
        user(id: ID!): User
        admin: Admin
      }

      type User {
        id: ID!
        name: String
        friend: User
      }

      type Admin {
        id: ID!
        level: Int
      }
    `);

    const prunedSchema = pruneSchema(schema, { query: ['user'] });
    const printed = printSchema(prunedSchema);

    expect(printed).to.include('user(id: ID!): User');
    expect(printed).to.not.include('admin');
    expect(printed).to.not.include('Admin');
    // The types reachable from the retained entry point are kept in full.
    expect(printed).to.include(dedent`
      type User {
        id: ID!
        name: String
        friend: User
      }
    `);
    expect(validateSchema(prunedSchema)).to.deep.equal([]);
  });

  it('does not modify the original schema', () => {
    const schema = buildSchema(`
      type Query {
        user: User
        admin: Admin
      }

      type User {
        name: String
      }

      type Admin {
        level: Int
      }
    `);
    const printedBefore = printSchema(schema);

    pruneSchema(schema, { query: ['user'] });

    expect(printSchema(schema)).to.equal(printedBefore);
    expect(schema.getQueryType()?.getFields()).to.have.all.keys(
      'user',
      'admin',
    );
    expect(schema.getType('Admin')).to.not.equal(undefined);
  });

  it('keeps mutation and subscription roots untouched when not listed', () => {
    const schema = buildSchema(`
      type Query {
        user: String
        admin: String
      }

      type Mutation {
        updateUser: String
      }

      type Subscription {
        userChanged: String
      }
    `);

    const prunedSchema = pruneSchema(schema, { query: ['user'] });

    expect(prunedSchema.getMutationType()?.getFields()).to.have.all.keys(
      'updateUser',
    );
    expect(prunedSchema.getSubscriptionType()?.getFields()).to.have.all.keys(
      'userChanged',
    );
  });

  it('filters mutation and subscription entry points and can drop them', () => {
    const schema = buildSchema(`
      type Query {
        user: String
      }

      type Mutation {
        updateUser: String
        purge: Boolean
      }

      type Subscription {
        userChanged: String
        adminAlert: String
      }
    `);

    const prunedSchema = pruneSchema(schema, {
      mutation: ['updateUser'],
      subscription: [],
    });
    const printed = printSchema(prunedSchema);

    expect(printed).to.include('updateUser: String');
    expect(printed).to.not.include('purge');
    expect(printed).to.not.include('userChanged');
    expect(prunedSchema.getSubscriptionType()).to.equal(undefined);
    expect(validateSchema(prunedSchema)).to.deep.equal([]);
  });

  it('collects the full dependency graph of the retained entry points', () => {
    const schema = buildSchema(`
      "Tags retained schema elements."
      directive @tag(name: String! = "default") on OBJECT | FIELD_DEFINITION

      directive @transform(rule: TransformRule) on FIELD_DEFINITION

      directive @unused on SCALAR

      input TransformRule {
        pattern: String
      }

      interface Node {
        id: ID!
      }

      type User implements Node @tag(name: "user") {
        id: ID!
        name: String @deprecated(reason: "Use fullName")
        fullName: String @transform(rule: { pattern: "x" })
        friend: User
        posts(first: Int = 10, filter: PostFilter): [Post!]
        role: Role
      }

      type Org implements Node {
        id: ID!
        name: String
        members: [User!]
      }

      type Post implements Node {
        id: ID!
        title: String
        author: User
      }

      input PostFilter {
        term: String = "all"
        range: DateRange
      }

      input DateRange {
        from: String
        to: String
      }

      enum Role {
        ADMIN
        USER @deprecated(reason: "legacy")
      }

      union SearchResult = User | Post

      type Query {
        user(id: ID!): User
        search(text: String!): SearchResult
        node(id: ID!): Node
        admin: AdminPanel
      }

      type AdminPanel {
        stats: Int
      }

      type Mutation {
        updateUser(filter: PostFilter!): User
      }
    `);

    const prunedSchema = pruneSchema(schema, {
      query: ['user', 'search', 'node'],
    });
    const printed = printSchema(prunedSchema);

    // Only the selected entry points remain.
    expect(printed).to.not.include('admin');
    expect(printed).to.not.include('AdminPanel');

    // Mutually referencing object types are kept in full (User <-> Post).
    expect(printed).to.include(
      'posts(first: Int = 10, filter: PostFilter): [Post!]',
    );
    expect(printed).to.include('author: User');

    // All possible types of the retained interface are kept.
    expect(
      prunedSchema
        .getPossibleTypes(prunedSchema.getType('Node') as GraphQLInterfaceType)
        .map((type) => type.name),
    ).to.have.members(['User', 'Org', 'Post']);

    // Union members are kept.
    expect(printed).to.include('union SearchResult = User | Post');

    // Nested input objects and default values are kept.
    expect(printed).to.include('term: String = "all"');
    expect(printed).to.include('range: DateRange');

    // Enum values and deprecation reasons are kept.
    expect(printed).to.include('USER @deprecated(reason: "legacy")');
    expect(printed).to.include(
      'name: String @deprecated(reason: "Use fullName")',
    );

    // Used custom directives are kept, unused ones are dropped.
    expect(printed).to.include(
      'directive @tag(name: String! = "default") on OBJECT | FIELD_DEFINITION',
    );
    // Types only referenced by the arguments of used directives are kept.
    expect(printed).to.include(
      'directive @transform(rule: TransformRule) on FIELD_DEFINITION',
    );
    expect(printed).to.include('input TransformRule');
    expect(printed).to.not.include('@unused');

    expect(validateSchema(prunedSchema)).to.deep.equal([]);
  });

  it('keeps directives applied through schema extensions', () => {
    const schema = extendSchema(
      buildSchema(`
        directive @tag on OBJECT

        type Query {
          user: User
        }

        type User {
          name: String
        }
      `),
      parse('extend type User @tag'),
    );

    const prunedSchema = pruneSchema(schema, { query: ['user'] });

    expect(printSchema(prunedSchema)).to.include('directive @tag on OBJECT');
    expect(validateSchema(prunedSchema)).to.deep.equal([]);
  });

  it('round-trips through printSchema and buildSchema with equal relations', () => {
    const schema = buildSchema(`
      directive @tag(name: String! = "default") on OBJECT

      interface Node {
        id: ID!
      }

      type User implements Node @tag(name: "user") {
        id: ID!
        friend: User
        posts: [Post!]
      }

      type Org implements Node {
        id: ID!
      }

      type Post implements Node {
        id: ID!
        author: User
      }

      union SearchResult = User | Post

      type Query {
        node(id: ID!): Node
        search(text: String!): SearchResult
        admin: String
      }
    `);

    const prunedSchema = pruneSchema(schema, {
      query: ['node', 'search'],
    });
    const printed = printSchema(prunedSchema);
    const rebuiltSchema = buildSchema(printed);

    expect(validateSchema(rebuiltSchema)).to.deep.equal([]);
    expect(printSchema(rebuiltSchema)).to.equal(printed);
    expect(
      rebuiltSchema
        .getPossibleTypes(rebuiltSchema.getType('Node') as GraphQLInterfaceType)
        .map((type) => type.name),
    ).to.have.members(
      prunedSchema
        .getPossibleTypes(prunedSchema.getType('Node') as GraphQLInterfaceType)
        .map((type) => type.name),
    );
    expect(rebuiltSchema.getQueryType()?.getFields()).to.have.all.keys(
      'node',
      'search',
    );
  });

  it('reports unknown entry points', () => {
    const schema = buildSchema(`
      type Query {
        user: String
      }
    `);

    expect(() => pruneSchema(schema, { query: ['unknown'] })).to.throw(
      'Cannot prune schema: unknown query root field(s) "unknown" on type "Query".',
    );
  });

  it('reports entry points for a missing root type', () => {
    const schema = buildSchema(`
      type Query {
        user: String
      }
    `);

    expect(() => pruneSchema(schema, { mutation: ['updateUser'] })).to.throw(
      'Cannot prune schema: the schema does not define a mutation root type, ' +
        'but fields were provided: "updateUser".',
    );

    // An empty list for a missing root type simply removes that root.
    const prunedSchema = pruneSchema(schema, { mutation: [] });
    expect(prunedSchema.getMutationType()).to.equal(undefined);
  });

  it('reports a result without any query entry point', () => {
    const schema = buildSchema(`
      type Query {
        user: String
      }
    `);

    expect(() => pruneSchema(schema, { query: [] })).to.throw(
      'Cannot prune schema: the pruned schema must retain at least one field ' +
        'on the query root type.',
    );
  });
});
