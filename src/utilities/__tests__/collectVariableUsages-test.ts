import { describe, it } from 'node:test';

import { expect } from 'chai';

import { parse } from '../../language/parser.ts';

import { collectVariableUsages } from '../collectVariableUsages.ts';

describe('collectVariableUsages', () => {
  it('reports argument usages of the same fragment once per response path', () => {
    const document = parse(`
      query Q($id: ID!, $format: String) {
        a: user(id: $id) { ...F }
        b: user(id: $id) { ...F }
      }
      fragment F on User { name(format: $format) }
    `);

    const report = collectVariableUsages(document, 'Q');

    expect(report.operationName).to.equal('Q');
    expect(report.variableDefinitions).to.deep.equal([
      { name: 'id', type: 'ID!', hasDefaultValue: false },
      { name: 'format', type: 'String', hasDefaultValue: false },
    ]);

    expect(report.usages.get('id')).to.deep.equal([
      { kind: 'argument', path: ['a'], fieldName: 'user', argumentName: 'id' },
      { kind: 'argument', path: ['b'], fieldName: 'user', argumentName: 'id' },
    ]);

    expect(report.usages.get('format')).to.deep.equal([
      {
        kind: 'argument',
        path: ['a', 'name'],
        fieldName: 'name',
        argumentName: 'format',
      },
      {
        kind: 'argument',
        path: ['b', 'name'],
        fieldName: 'name',
        argumentName: 'format',
      },
    ]);
  });

  it('reports field names without aliases in fieldName and aliases in path', () => {
    const document = parse(`
      query Q($id: ID!) {
        renamed: user(id: $id) { name }
      }
    `);

    const report = collectVariableUsages(document, 'Q');
    expect(report.usages.get('id')).to.deep.equal([
      {
        kind: 'argument',
        path: ['renamed'],
        fieldName: 'user',
        argumentName: 'id',
      },
    ]);
  });

  it('finds variables nested in list and object argument values', () => {
    const document = parse(`
      query Q($a: Int, $b: Int) {
        search(ids: [1, $a], filter: { range: { min: $b } }) { id }
      }
    `);

    const report = collectVariableUsages(document, 'Q');
    expect(report.usages.get('a')).to.deep.equal([
      {
        kind: 'argument',
        path: ['search'],
        fieldName: 'search',
        argumentName: 'ids',
      },
    ]);
    expect(report.usages.get('b')).to.deep.equal([
      {
        kind: 'argument',
        path: ['search'],
        fieldName: 'search',
        argumentName: 'filter',
      },
    ]);
  });

  it('does not treat dollar signs inside string literals as variables', () => {
    const document = parse(`
      query Q {
        user(name: "$id", template: "costs money for $id") { name }
      }
    `);

    const report = collectVariableUsages(document, 'Q');
    expect(report.variableDefinitions).to.deep.equal([]);
    expect([...report.usages.keys()]).to.deep.equal([]);
  });

  it('reports directive usages on operations, fields, spreads and inline fragments', () => {
    const document = parse(`
      query Q($a: Boolean, $b: Boolean, $c: Boolean, $d: Boolean, $e: Boolean)
      @op(flag: $a) {
        user @field(flag: $b) @marker {
          ...F @spread(flag: $c)
          ... @inline(flag: $d) {
            name @skip(if: $e)
          }
        }
      }
      fragment F on User { name }
    `);

    const report = collectVariableUsages(document, 'Q');

    expect(report.usages.get('a')).to.deep.equal([
      {
        kind: 'directive',
        path: [],
        directiveName: 'op',
        argumentName: 'flag',
        appliedTo: 'operation',
      },
    ]);
    expect(report.usages.get('b')).to.deep.equal([
      {
        kind: 'directive',
        path: ['user'],
        directiveName: 'field',
        argumentName: 'flag',
        appliedTo: 'field',
      },
    ]);
    expect(report.usages.get('c')).to.deep.equal([
      {
        kind: 'directive',
        path: ['user'],
        directiveName: 'spread',
        argumentName: 'flag',
        appliedTo: 'fragmentSpread',
      },
    ]);
    expect(report.usages.get('d')).to.deep.equal([
      {
        kind: 'directive',
        path: ['user'],
        directiveName: 'inline',
        argumentName: 'flag',
        appliedTo: 'inlineFragment',
      },
    ]);
    expect(report.usages.get('e')).to.deep.equal([
      {
        kind: 'directive',
        path: ['user', 'name'],
        directiveName: 'skip',
        argumentName: 'if',
        appliedTo: 'field',
      },
    ]);
  });

  it('keeps unused declared variables with an empty usage list', () => {
    const document = parse(`
      query Q($used: ID!, $unused: String = "x") {
        user(id: $used) { name }
      }
    `);

    const report = collectVariableUsages(document, 'Q');
    expect(report.variableDefinitions).to.deep.equal([
      { name: 'used', type: 'ID!', hasDefaultValue: false },
      { name: 'unused', type: 'String', hasDefaultValue: true },
    ]);
    expect(report.usages.get('unused')).to.deep.equal([]);
    expect(report.usages.get('used')).to.have.lengthOf(1);
  });

  it('reports usages of variables that are not declared', () => {
    const document = parse(`
      query Q {
        user(id: $undeclared) { name }
      }
    `);

    const report = collectVariableUsages(document, 'Q');
    expect(report.usages.get('undeclared')).to.deep.equal([
      {
        kind: 'argument',
        path: ['user'],
        fieldName: 'user',
        argumentName: 'id',
      },
    ]);
  });

  it('ignores operations that are not selected', () => {
    const document = parse(`
      query Selected($a: ID!) {
        user(id: $a) { name }
      }
      query Other($b: ID!) {
        other(id: $b) { name }
      }
    `);

    const report = collectVariableUsages(document, 'Selected');
    expect(report.operationName).to.equal('Selected');
    expect([...report.usages.keys()]).to.deep.equal(['a']);
    expect(report.usages.get('a')).to.have.lengthOf(1);
  });

  it('resolves the single operation when no name is provided', () => {
    const document = parse(`
      query ($id: ID!) {
        user(id: $id) { name }
      }
    `);

    const report = collectVariableUsages(document);
    expect(report.operationName).to.equal(undefined);
    expect(report.usages.get('id')).to.have.lengthOf(1);
  });

  it('throws when the operation cannot be determined', () => {
    const multiple = parse(`
      query A { a }
      query B { b }
    `);
    expect(() => collectVariableUsages(multiple)).to.throw(
      'Must provide an operation name',
    );

    const document = parse('query A { a }');
    expect(() => collectVariableUsages(document, 'Missing')).to.throw(
      'Unknown operation named "Missing".',
    );
  });

  it('distinguishes missing fragments from fragment cycles', () => {
    const missing = parse(`
      query Q($id: ID!) {
        user(id: $id) { ...DoesNotExist }
      }
    `);
    expect(() => collectVariableUsages(missing, 'Q')).to.throw(
      'Unknown fragment "DoesNotExist".',
    );

    const cyclic = parse(`
      query Q($id: ID!) {
        user(id: $id) { ...A }
      }
      fragment A on User { friends { ...B } }
      fragment B on User { friends { ...A } }
    `);
    expect(() => collectVariableUsages(cyclic, 'Q')).to.throw(
      'Fragment cycle detected: A -> B -> A.',
    );
  });

  it('allows the same fragment on sibling fields while still detecting cycles', () => {
    const document = parse(`
      query Q($v: String) {
        a: user { ...F }
        b: user { ...F }
      }
      fragment F on User { name(format: $v) }
    `);

    const report = collectVariableUsages(document, 'Q');
    expect(report.usages.get('v')).to.deep.equal([
      {
        kind: 'argument',
        path: ['a', 'name'],
        fieldName: 'name',
        argumentName: 'format',
      },
      {
        kind: 'argument',
        path: ['b', 'name'],
        fieldName: 'name',
        argumentName: 'format',
      },
    ]);
  });

  it('tracks paths through inline fragments without adding segments', () => {
    const document = parse(`
      query Q($id: ID!) {
        user {
          ... on User {
            profile(id: $id) { name }
          }
        }
      }
    `);

    const report = collectVariableUsages(document, 'Q');
    expect(report.usages.get('id')).to.deep.equal([
      {
        kind: 'argument',
        path: ['user', 'profile'],
        fieldName: 'profile',
        argumentName: 'id',
      },
    ]);
  });
});
