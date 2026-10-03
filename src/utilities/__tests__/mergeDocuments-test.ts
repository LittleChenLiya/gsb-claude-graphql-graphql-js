import { describe, it } from 'node:test';

import { expect } from 'chai';

import { dedent } from '../../__testUtils__/dedent.ts';

import { GraphQLError } from '../../error/GraphQLError.ts';

import { parse } from '../../language/parser.ts';
import { print } from '../../language/printer.ts';
import { Source } from '../../language/source.ts';

import { mergeDocuments } from '../mergeDocuments.ts';

function expectMergeError(
  documents: ReadonlyArray<ReturnType<typeof parse>>,
): GraphQLError {
  try {
    mergeDocuments(documents);
  } catch (error) {
    expect(error).to.be.instanceOf(GraphQLError);
    return error as GraphQLError;
  }
  expect.fail('Expected mergeDocuments to throw a GraphQLError.');
}

describe('mergeDocuments', () => {
  it('merges distinct definitions from multiple documents in order', () => {
    const docA = parse('{ a, b, ...Frag }');
    const docB = parse('fragment Frag on T { c }');
    const docC = parse('type Query { a: String }');

    const merged = mergeDocuments([docA, docB, docC]);

    expect(print(merged)).to.equal(dedent`
      {
        a
        b
        ...Frag
      }

      fragment Frag on T {
        c
      }

      type Query {
        a: String
      }
    `);
  });

  it('keeps only one copy of identical fragments defined at different locations', () => {
    const docA = parse(new Source('fragment F on User { id }', 'a.graphql'));
    const docB = parse(
      new Source('\n\n  fragment F on User { id }', 'b.graphql'),
    );

    const merged = mergeDocuments([docA, docB]);

    expect(merged.definitions).to.have.lengthOf(1);
    expect(print(merged)).to.equal('fragment F on User {\n  id\n}');
  });

  it('preserves definition order across documents and first definitions', () => {
    const docA = parse('fragment B on T { b } fragment A on T { a }');
    const docB = parse('fragment A on T { a } fragment C on T { c }');

    const merged = mergeDocuments([docA, docB]);

    expect(
      merged.definitions.map(
        (def) => (def as { name: { value: string } }).name.value,
      ),
    ).to.deep.equal(['B', 'A', 'C']);
  });

  it('rejects same-named fragments with different type conditions, reporting both locations', () => {
    const docA = parse(new Source('fragment F on User { id }', 'a.graphql'));
    const docB = parse(new Source('\nfragment F on Admin { id }', 'b.graphql'));

    const error = expectMergeError([docA, docB]);

    expect(error.message).to.equal(
      'Cannot merge documents: fragment "F" is defined more than once with different structures.',
    );
    expect(error.nodes).to.have.lengthOf(2);
    expect(error.locations).to.deep.equal([
      { line: 1, column: 1 },
      { line: 2, column: 1 },
    ]);
  });

  it('rejects same-named fragments with different directives', () => {
    const docA = parse('fragment F on User { id }');
    const docB = parse('fragment F on User @cached { id }');

    const error = expectMergeError([docA, docB]);

    expect(error.message).to.equal(
      'Cannot merge documents: fragment "F" is defined more than once with different structures.',
    );
    expect(error.nodes).to.have.lengthOf(2);
  });

  it('rejects same-named fragments with different nested selections', () => {
    const docA = parse(
      'fragment F on User { profile { name address { city } } }',
    );
    const docB = parse(
      'fragment F on User { profile { name address { zip } } }',
    );

    const error = expectMergeError([docA, docB]);

    expect(error.message).to.equal(
      'Cannot merge documents: fragment "F" is defined more than once with different structures.',
    );
  });

  it('merges same-named fragments with identical nested selections', () => {
    const docA = parse(
      'fragment F on User { profile { name address { city } } }',
    );
    const docB = parse(
      '\n\nfragment F on User { profile { name address { city } } }',
    );

    const merged = mergeDocuments([docA, docB]);

    expect(merged.definitions).to.have.lengthOf(1);
    expect(print(merged)).to.equal(dedent`
      fragment F on User {
        profile {
          name
          address {
            city
          }
        }
      }
    `);
  });

  it('treats whitespace inside string literals as significant', () => {
    const docA = parse('fragment F on User { field(arg: "a b") }');
    const docB = parse('fragment F on User { field(arg: "a  b") }');

    const error = expectMergeError([docA, docB]);

    expect(error.message).to.equal(
      'Cannot merge documents: fragment "F" is defined more than once with different structures.',
    );

    const docC = parse('fragment G on User { field(arg: "a  b") }');
    const docD = parse('\nfragment G on User { field(arg: "a  b") }');

    expect(mergeDocuments([docC, docD]).definitions).to.have.lengthOf(1);
  });

  it('rejects same-named operations even when identical', () => {
    const docA = parse(new Source('query GetUser { viewer }', 'a.graphql'));
    const docB = parse(new Source('\n\nquery GetUser { viewer }', 'b.graphql'));

    const error = expectMergeError([docA, docB]);

    expect(error.message).to.equal(
      'Cannot merge documents: operation "GetUser" is defined more than once.',
    );
    expect(error.nodes).to.have.lengthOf(2);
    expect(error.locations).to.deep.equal([
      { line: 1, column: 1 },
      { line: 3, column: 1 },
    ]);
  });

  it('allows anonymous operations and distinct operation names', () => {
    const docA = parse('{ a } query One { one }');
    const docB = parse('{ b } query Two { two }');

    const merged = mergeDocuments([docA, docB]);

    expect(merged.definitions).to.have.lengthOf(4);
  });

  it('returns a document that shares no mutable arrays with the inputs', () => {
    const docA = parse('query GetUser { viewer { ...F } }');
    const docB = parse('fragment F on User { id }');

    const merged = mergeDocuments([docA, docB]);

    expect(merged.definitions).to.not.equal(docA.definitions);
    expect(merged.definitions).to.not.equal(docB.definitions);

    // Mutating every array reachable from the merged document must not
    // affect the input documents.
    mutateArrays(merged);

    expect(print(docA)).to.equal(dedent`
      query GetUser {
        viewer {
          ...F
        }
      }
    `);
    expect(print(docB)).to.equal('fragment F on User {\n  id\n}');
  });

  it('leaves the input documents unchanged', () => {
    const docA = parse('fragment F on User { id }');
    const docB = parse('fragment F on User { id } fragment G on User { x }');

    const beforeA = print(docA);
    const beforeB = print(docB);

    const merged = mergeDocuments([docA, docB]);

    expect(print(docA)).to.equal(beforeA);
    expect(print(docB)).to.equal(beforeB);
    expect(merged.definitions).to.have.lengthOf(2);
  });
});

function mutateArrays(value: unknown): void {
  if (Array.isArray(value)) {
    value.splice(0, value.length);
    value.push('mutated');
    for (const item of value) {
      mutateArrays(item);
    }
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      if (key === 'loc') {
        continue;
      }
      mutateArrays((value as { [key: string]: unknown })[key]);
    }
  }
}
