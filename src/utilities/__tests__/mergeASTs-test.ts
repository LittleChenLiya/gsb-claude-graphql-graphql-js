import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GraphQLError } from '../../error/GraphQLError.ts';
import type {
  DefinitionNode,
  DocumentNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
} from '../../language/ast.ts';
import { Kind } from '../../language/kinds.ts';
import { parse } from '../../language/parser.ts';
import { print } from '../../language/printer.ts';
import { Source } from '../../language/source.ts';
import { mergeASTs } from '../mergeASTs.ts';

function parseSource(body: string, name: string) {
  return parse(new Source(body, name));
}

function fragmentNames(document: DocumentNode): Array<string> {
  return document.definitions
    .filter((def) => def.kind === Kind.FRAGMENT_DEFINITION)
    .map((def) => def.name.value);
}

function isFragmentDefinition(
  definition: DefinitionNode,
): definition is FragmentDefinitionNode {
  return definition.kind === Kind.FRAGMENT_DEFINITION;
}

function isOperationDefinition(
  definition: DefinitionNode,
): definition is OperationDefinitionNode {
  return definition.kind === Kind.OPERATION_DEFINITION;
}

function findFragment(
  document: DocumentNode,
  name: string,
): FragmentDefinitionNode {
  const fragment = document.definitions.find(
    (definition): definition is FragmentDefinitionNode =>
      isFragmentDefinition(definition) && definition.name.value === name,
  );
  assert.ok(fragment);
  return fragment;
}

function findOperation(document: DocumentNode): OperationDefinitionNode {
  const operation = document.definitions.find(isOperationDefinition);
  assert.ok(operation);
  return operation;
}

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer U> ? Array<U> : T[K];
};

describe('mergeASTs', () => {
  it('merges identical fragments at different positions into one', () => {
    const first = parseSource(
      `
        fragment F on User {
          id
        }
      `,
      'first.graphql',
    );
    const second = parseSource(
      `
        fragment F on User {
          id
        }
      `,
      'second.graphql',
    );

    const merged = mergeASTs([first, second]);

    assert.equal(merged.definitions.length, 1);
    assert.deepEqual(fragmentNames(merged), ['F']);
    // The first definition is kept.
    assert.equal(merged.definitions[0].loc?.source.name, 'first.graphql');
    // Positions differ, but the printed form is identical.
    assert.equal(print(merged), print(first));
  });

  it('merges three documents with the identical fragment appearing twice', () => {
    const a = parseSource('fragment F on User { id }', 'a.graphql');
    const b = parseSource('query B { id }', 'b.graphql');
    const c = parseSource('fragment F on User { id }', 'c.graphql');

    const merged = mergeASTs([a, b, c]);

    assert.equal(merged.definitions.length, 2);
    assert.deepEqual(fragmentNames(merged), ['F']);
    assert.equal(merged.definitions[0].loc?.source.name, 'a.graphql');
  });

  it('rejects fragments with different type conditions and reports both sources', () => {
    const onUser = parseSource('fragment F on User { id }', 'on-user.graphql');
    const onAdmin = parseSource(
      'fragment F on Admin { id }',
      'on-admin.graphql',
    );

    assert.throws(
      () => mergeASTs([onUser, onAdmin]),
      (error: unknown) => {
        assert.ok(error instanceof GraphQLError);
        assert.match(error.message, /fragment "F"/);
        assert.equal(error.nodes?.length, 2);
        assert.deepEqual(
          error.nodes?.map((node) => node.loc?.source.name),
          ['on-user.graphql', 'on-admin.graphql'],
        );
        assert.equal(error.locations?.length, 2);
        return true;
      },
    );
  });

  it('rejects fragments with different nested selections', () => {
    const first = parseSource(
      'fragment F on User { field { a } }',
      'first.graphql',
    );
    const second = parseSource(
      'fragment F on User { field { b } }',
      'second.graphql',
    );

    assert.throws(
      () => mergeASTs([first, second]),
      (error: unknown) => {
        assert.ok(error instanceof GraphQLError);
        assert.equal(error.nodes?.length, 2);
        assert.equal(error.locations?.length, 2);
        return true;
      },
    );
  });

  it('rejects fragments with different directives', () => {
    const first = parseSource(
      'fragment F on User @skip(if: true) { id }',
      'first.graphql',
    );
    const second = parseSource(
      'fragment F on User @skip(if: false) { id }',
      'second.graphql',
    );

    assert.throws(
      () => mergeASTs([first, second]),
      (error: unknown) => {
        assert.ok(error instanceof GraphQLError);
        assert.equal(error.nodes?.length, 2);
        return true;
      },
    );
  });

  it('rejects fragments whose string literals differ only in whitespace', () => {
    const first = parseSource(
      'fragment F on User @foo(arg: "a b") { id }',
      'first.graphql',
    );
    const second = parseSource(
      'fragment F on User @foo(arg: "ab") { id }',
      'second.graphql',
    );

    assert.throws(
      () => mergeASTs([first, second]),
      (error: unknown) => {
        assert.ok(error instanceof GraphQLError);
        assert.equal(error.nodes?.length, 2);
        return true;
      },
    );
  });

  it('merges fragments whose string literals are identical including whitespace', () => {
    const first = parseSource(
      'fragment F on User @foo(arg: "a b") { id }',
      'first.graphql',
    );
    const second = parseSource(
      'fragment F on User @foo(arg: "a b") { id }',
      'second.graphql',
    );

    const merged = mergeASTs([first, second]);

    assert.equal(merged.definitions.length, 1);
    assert.equal(print(merged), print(first));
  });

  it('ignores description and comment differences when merging', () => {
    const first = parseSource(
      '"""doc for F"""\nfragment F on User { id }',
      'first.graphql',
    );
    const second = parseSource(
      '# just a comment\nfragment F on User { id }',
      'second.graphql',
    );

    const merged = mergeASTs([first, second]);

    assert.equal(merged.definitions.length, 1);
    assert.equal(merged.definitions[0].loc?.source.name, 'first.graphql');
  });

  it('rejects two operations with the same name as an independent error', () => {
    const first = parseSource('query A { x }', 'first.graphql');
    const second = parseSource('query A { y }', 'second.graphql');

    assert.throws(
      () => mergeASTs([first, second]),
      (error: unknown) => {
        assert.ok(error instanceof GraphQLError);
        assert.match(error.message, /operation "A"/);
        assert.equal(error.nodes?.length, 2);
        assert.deepEqual(
          error.nodes?.map((node) => node.loc?.source.name),
          ['first.graphql', 'second.graphql'],
        );
        assert.equal(error.locations?.length, 2);
        return true;
      },
    );
  });

  it('returns independent nodes so mutating the result leaves the originals unchanged', () => {
    const first = parseSource(
      'query A { ...F }\nfragment F on User { id }',
      'first.graphql',
    );
    const second = parseSource('fragment G on User { name }', 'second.graphql');

    const merged = mergeASTs([first, second]);

    // The result owns a new definitions array.
    assert.notEqual(merged.definitions, first.definitions);
    assert.notEqual(merged.definitions, second.definitions);

    // Definition nodes are not shared with the originals.
    const mergedFragment = findFragment(merged, 'F');
    const originalFragment = findFragment(first, 'F');
    assert.notEqual(mergedFragment, originalFragment);

    // Modifiable arrays are not shared.
    assert.notEqual(
      mergedFragment.selectionSet.selections,
      originalFragment.selectionSet.selections,
    );
    assert.notEqual(
      findOperation(merged).selectionSet.selections,
      findOperation(first).selectionSet.selections,
    );

    // Mutating the result never affects the originals.
    const originalPrint = print(first);
    const mutableMerged = merged as Mutable<DocumentNode>;
    mutableMerged.definitions.push(
      parseSource('fragment H on User { email }', 'mutated.graphql')
        .definitions[0],
    );
    (mergedFragment.selectionSet.selections as Array<unknown>).push(
      parseSource('fragment H on User { email }', 'mutated.graphql')
        .definitions[0],
    );

    assert.equal(print(first), originalPrint);
    assert.equal(first.definitions.length, 2);
    assert.equal(second.definitions.length, 1);
  });

  it('preserves input order and keeps the first definition', () => {
    const doc1 = parseSource(
      'query A { ...F }\nfragment F on User { id }',
      'doc1.graphql',
    );
    const doc2 = parseSource(
      'fragment G on User { name }\nfragment F on User { id }',
      'doc2.graphql',
    );
    const doc3 = parseSource('query B { id }', 'doc3.graphql');

    const merged = mergeASTs([doc1, doc2, doc3]);

    assert.deepEqual(
      merged.definitions.map((def) =>
        isFragmentDefinition(def)
          ? `fragment:${def.name.value}`
          : isOperationDefinition(def)
            ? `operation:${def.name?.value ?? 'anonymous'}`
            : `other:${def.kind}`,
      ),
      ['operation:A', 'fragment:F', 'fragment:G', 'operation:B'],
    );
    // F comes from the first document.
    const fDefinition = merged.definitions.find(
      (def) => def.kind === 'FragmentDefinition' && def.name.value === 'F',
    );
    assert.equal(fDefinition?.loc?.source.name, 'doc1.graphql');
  });
});