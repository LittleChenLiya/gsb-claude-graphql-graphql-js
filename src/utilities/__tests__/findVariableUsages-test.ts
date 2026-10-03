import { describe, it } from 'node:test';

import { expect } from 'chai';

import { GraphQLError } from '../../error/GraphQLError.ts';

import { parse } from '../../language/parser.ts';

import { findVariableUsages } from '../findVariableUsages.ts';
import { getOperationAST } from '../getOperationAST.ts';

describe('findVariableUsages', () => {
  it('reports variable definitions and field argument locations', () => {
    const document = parse(`
      query GetUser($id: ID!) {
        user(id: $id) {
          name
        }
      }
    `);

    const report = findVariableUsages(document, 'GetUser');

    expect(report.operation).to.equal(document.definitions[0]);
    expect(report.variables).to.have.length(1);
    expect(report.variables[0]).to.deep.equal({
      name: 'id',
      definition: report.operation.variableDefinitions?.[0],
      locations: [
        {
          path: ['user'],
          kind: 'field-argument',
          field: 'user',
          argument: 'id',
        },
      ],
    });
  });

  it('keeps both response paths when the same fragment is reached from two fields', () => {
    const document = parse(`
      query Q($id: ID!, $first: Int) {
        a: user(id: $id) {
          ...UserFields
        }
        b: user(id: $id) {
          ...UserFields
        }
      }

      fragment UserFields on User {
        friends(first: $first) {
          name
        }
      }
    `);

    const report = findVariableUsages(document, 'Q');

    const byName = new Map(report.variables.map((v) => [v.name, v]));

    expect(byName.get('id')?.locations).to.deep.equal([
      {
        path: ['a'],
        kind: 'field-argument',
        field: 'a',
        argument: 'id',
      },
      {
        path: ['b'],
        kind: 'field-argument',
        field: 'b',
        argument: 'id',
      },
    ]);

    expect(byName.get('first')?.locations).to.deep.equal([
      {
        path: ['a', 'friends'],
        kind: 'field-argument',
        field: 'friends',
        argument: 'first',
      },
      {
        path: ['b', 'friends'],
        kind: 'field-argument',
        field: 'friends',
        argument: 'first',
      },
    ]);
  });

  it('reports aliased fields under their response key', () => {
    const document = parse(`
      query Q($id: ID!) {
        a: user(id: $id) {
          b: friends(first: 10) {
            name
          }
        }
      }
    `);

    const report = findVariableUsages(document, 'Q');

    expect(report.variables[0].locations).to.deep.equal([
      {
        path: ['a'],
        kind: 'field-argument',
        field: 'a',
        argument: 'id',
      },
    ]);
  });

  it('reports directive arguments on fields, fragment spreads, and inline fragments', () => {
    const document = parse(`
      query Q($skip: Boolean!) {
        a: user @skip(if: $skip) {
          ...UserFields @include(if: $skip)
        }
        ... on Query @skip(if: $skip) {
          status
        }
      }

      fragment UserFields on User {
        name
      }
    `);

    const report = findVariableUsages(document, 'Q');

    expect(report.variables[0].locations).to.deep.equal([
      {
        path: ['a'],
        kind: 'directive-argument',
        field: 'a',
        argument: 'if',
        directive: 'skip',
      },
      {
        path: ['a'],
        kind: 'directive-argument',
        field: 'a',
        argument: 'if',
        directive: 'include',
      },
      {
        path: [],
        kind: 'directive-argument',
        field: undefined,
        argument: 'if',
        directive: 'skip',
      },
    ]);
  });

  it('reports operation directives at the root with an empty path', () => {
    const document = parse(`
      query Q($x: Boolean) @skip(if: $x) {
        a: user {
          name
        }
      }
    `);

    const report = findVariableUsages(document, 'Q');

    expect(report.variables[0].locations).to.deep.equal([
      {
        path: [],
        kind: 'directive-argument',
        field: undefined,
        argument: 'if',
        directive: 'skip',
      },
    ]);
  });

  it('reports variables nested in list and object arguments once per occurrence', () => {
    const document = parse(`
      query Q($id: ID!) {
        a: user(ids: [1, $id, 3], filter: { x: $id }) {
          name
        }
      }
    `);

    const report = findVariableUsages(document, 'Q');

    expect(report.variables[0].locations).to.deep.equal([
      {
        path: ['a'],
        kind: 'field-argument',
        field: 'a',
        argument: 'ids',
      },
      {
        path: ['a'],
        kind: 'field-argument',
        field: 'a',
        argument: 'filter',
      },
    ]);
  });

  it('does not treat dollar characters inside strings as variables', () => {
    const document = parse(`
      query Q($id: ID!) {
        a: user(id: $id, note: "use $id here") {
          name
        }
      }
    `);

    const report = findVariableUsages(document, 'Q');

    expect(report.variables).to.have.length(1);
    expect(report.variables[0].locations).to.deep.equal([
      {
        path: ['a'],
        kind: 'field-argument',
        field: 'a',
        argument: 'id',
      },
    ]);
  });

  it('lists defined but unused variables with empty locations', () => {
    const document = parse(`
      query Q($id: ID!, $unused: String) {
        a: user(id: $id) {
          name
        }
      }
    `);

    const report = findVariableUsages(document, 'Q');

    expect(report.variables).to.have.length(2);
    expect(report.variables[0].name).to.equal('id');
    expect(report.variables[0].locations).to.have.length(1);
    expect(report.variables[1].name).to.equal('unused');
    expect(report.variables[1].definition).to.not.equal(undefined);
    expect(report.variables[1].locations).to.deep.equal([]);
  });

  it('lists referenced but undefined variables without a definition', () => {
    const document = parse(`
      query Q {
        a: user(id: $id) {
          name
        }
      }
    `);

    const report = findVariableUsages(document, 'Q');

    expect(report.variables).to.have.length(1);
    expect(report.variables[0].name).to.equal('id');
    expect(report.variables[0].definition).to.equal(undefined);
    expect(report.variables[0].locations).to.have.length(1);
  });

  it('only analyzes the selected operation in a document with multiple operations', () => {
    const document = parse(`
      query A($x: ID!) {
        a: user(id: $x) {
          name
        }
      }

      query B($y: String!) {
        b: user(name: $y) {
          id
        }
      }
    `);

    const reportA = findVariableUsages(document, 'A');
    expect(reportA.operation).to.equal(document.definitions[0]);
    expect(reportA.variables).to.have.length(1);
    expect(reportA.variables[0].name).to.equal('x');
    expect(reportA.variables[0].locations[0].path).to.deep.equal(['a']);

    const reportB = findVariableUsages(document, 'B');
    expect(reportB.operation).to.equal(document.definitions[1]);
    expect(reportB.variables).to.have.length(1);
    expect(reportB.variables[0].name).to.equal('y');
    expect(reportB.variables[0].locations[0].path).to.deep.equal(['b']);
  });

  it('selects the only operation when no name is given', () => {
    const document = parse(`
      query Q($id: ID!) {
        user(id: $id) {
          name
        }
      }
    `);

    const report = findVariableUsages(document);
    expect(report.operation).to.equal(document.definitions[0]);
    expect(report.variables[0].name).to.equal('id');
  });

  it('throws when the named operation does not exist', () => {
    const document = parse(`
      query A {
        a: user {
          name
        }
      }
    `);

    expect(() => findVariableUsages(document, 'Missing')).to.throw(
      GraphQLError,
      'Unknown operation named "Missing".',
    );
  });

  it('throws when multiple operations exist and no name is given', () => {
    const document = parse(`
      query A {
        a: user {
          name
        }
      }

      query B {
        b: user {
          name
        }
      }
    `);

    expect(() => findVariableUsages(document)).to.throw(
      GraphQLError,
      'Must provide operation name if query contains multiple operations.',
    );
  });

  it('accepts an operation AST node directly', () => {
    const document = parse(`
      query A($x: ID!) {
        a: user(id: $x) {
          name
        }
      }

      query B($y: String!) {
        b: user(name: $y) {
          id
        }
      }
    `);

    const operationB = getOperationAST(document, 'B');
    const report = findVariableUsages(document, operationB);
    expect(report.operation).to.equal(operationB);
    expect(report.variables[0].name).to.equal('y');
  });

  it('throws a distinct error for a missing fragment', () => {
    const document = parse(`
      query Q {
        a: user {
          ...Missing
        }
      }
    `);

    expect(() => findVariableUsages(document, 'Q')).to.throw(
      GraphQLError,
      'Unknown fragment "Missing".',
    );
  });

  it('throws a distinct error for a fragment that spreads itself', () => {
    const document = parse(`
      fragment UserFields on User {
        friends {
          ...UserFields
        }
      }

      query Q {
        a: user {
          ...UserFields
        }
      }
    `);

    expect(() => findVariableUsages(document, 'Q')).to.throw(
      GraphQLError,
      'Cannot spread fragment "UserFields" within itself.',
    );
  });

  it('reports the intermediate fragments in an indirect cycle', () => {
    const document = parse(`
      fragment A on User {
        ...B
      }

      fragment B on User {
        ...A
      }

      query Q {
        a: user {
          ...A
        }
      }
    `);

    expect(() => findVariableUsages(document, 'Q')).to.throw(
      GraphQLError,
      'Cannot spread fragment "A" within itself via "B".',
    );
  });

  it('does not report a cycle for a fragment reached from two sibling fields', () => {
    const document = parse(`
      query Q($id: ID!) {
        a: user(id: $id) {
          ...UserFields
        }
        b: user(id: $id) {
          ...UserFields
        }
      }

      fragment UserFields on User {
        name
      }
    `);

    const report = findVariableUsages(document, 'Q');
    expect(report.variables[0].locations).to.have.length(2);
  });

  it('reports variables supplied to fragment spread arguments', () => {
    const document = parse(
      `
        query Q($first: Int!) {
          a: user {
            ...UserFields(first: $first)
          }
        }

        fragment UserFields on User {
          friends {
            name
          }
        }
      `,
      { experimentalFragmentArguments: true },
    );

    const report = findVariableUsages(document, 'Q');

    expect(report.variables[0].locations).to.deep.equal([
      {
        path: ['a'],
        kind: 'fragment-argument',
        field: 'a',
        argument: 'first',
        fragmentSpread: 'UserFields',
      },
    ]);
  });

  it('does not analyze fragments that are not reachable from the operation', () => {
    const document = parse(`
      query Q($id: ID!) {
        a: user(id: $id) {
          name
        }
      }

      fragment Unreachable on User {
        ...Missing
      }
    `);

    const report = findVariableUsages(document, 'Q');
    expect(report.variables[0].name).to.equal('id');
    expect(report.variables[0].locations).to.have.length(1);
  });
});
