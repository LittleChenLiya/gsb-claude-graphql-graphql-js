import { describe, it } from 'node:test';

import { expect } from 'chai';

import { dedent } from '../../__testUtils__/dedent.ts';

import { Kind } from '../../language/kinds.ts';
import { parse } from '../../language/parser.ts';
import { print } from '../../language/printer.ts';

import { pruneUnusedVariables } from '../pruneUnusedVariables.ts';

function pruned(source: string): string {
  return print(pruneUnusedVariables(parse(source)));
}

describe('pruneUnusedVariables', () => {
  it('removes unused variables while keeping the one used via a fragment', () => {
    // Acceptance case: `id` is declared together with `unused`, but only `id`
    // is referenced, through a reachable fragment.
    expect(
      pruned(`
        query GetUser($id: ID!, $unused: String) {
          user {
            ...UserId
          }
        }

        fragment UserId on User {
          id
          field(arg: $id)
        }
      `),
    ).to.equal(dedent`
      query GetUser($id: ID!) {
        user {
          ...UserId
        }
      }

      fragment UserId on User {
        id
        field(arg: $id)
      }
    `);
  });

  it('keeps variables used by another operation independently', () => {
    // Acceptance case: another operation referencing `unused` keeps its own
    // definition even when the first operation drops it.
    expect(
      pruned(`
        query First($id: ID!, $unused: String) {
          first(id: $id)
        }

        query Second($unused: String) {
          second(arg: $unused)
        }
      `),
    ).to.equal(dedent`
      query First($id: ID!) {
        first(id: $id)
      }

      query Second($unused: String) {
        second(arg: $unused)
      }
    `);
  });

  it('preserves variable types, default values, directives and order', () => {
    expect(
      pruned(`
        query Q(
          $first: Int = 1
          $unused: [String!]
          $second: FilterInput = { nested: [1, 2] } @skip(if: false)
        ) {
          a(x: $first)
          b(y: $second)
        }
      `),
    ).to.equal(dedent`
      query Q($first: Int = 1, $second: FilterInput = { nested: [1, 2] } @skip(if: false)) {
        a(x: $first)
        b(y: $second)
      }
    `);
  });

  it('collects variables from field arguments and directives', () => {
    expect(
      pruned(`
        query Q($fromField: ID, $fromDirective: Boolean, $unused: String)
        @cache(enabled: $fromDirective) {
          field(arg: $fromField) @include(if: $fromDirective) {
            child
          }
        }
      `),
    ).to.equal(dedent`
      query Q($fromField: ID, $fromDirective: Boolean) @cache(enabled: $fromDirective) {
        field(arg: $fromField) @include(if: $fromDirective) {
          child
        }
      }
    `);
  });

  it('collects variables from nested input values', () => {
    expect(
      pruned(`
        query Q($used: [Int], $unused: String) {
          field(input: { list: $used, literal: "static" })
        }
      `),
    ).to.equal(dedent`
      query Q($used: [Int]) {
        field(input: { list: $used, literal: "static" })
      }
    `);
  });

  it('collects variables from inline fragments without a schema', () => {
    expect(
      pruned(`
        query Q($id: ID!, $unused: String) {
          user {
            ... on Admin {
              field(arg: $id)
            }
          }
        }
      `),
    ).to.equal(dedent`
      query Q($id: ID!) {
        user {
          ... on Admin {
            field(arg: $id)
          }
        }
      }
    `);
  });

  it('follows transitive fragment spreads', () => {
    expect(
      pruned(`
        query Q($id: ID!, $unused: String) {
          user {
            ...UserFields
          }
        }

        fragment UserFields on User {
          ...UserId
        }

        fragment UserId on User {
          field(arg: $id)
        }
      `),
    ).to.equal(dedent`
      query Q($id: ID!) {
        user {
          ...UserFields
        }
      }

      fragment UserFields on User {
        ...UserId
      }

      fragment UserId on User {
        field(arg: $id)
      }
    `);
  });

  it('does not silently skip fragment cycles', () => {
    // A cycle must still be traversed; otherwise the variable only referenced
    // from inside the cycle would be wrongly removed.
    expect(
      pruned(`
        query Q($id: ID!, $unused: String) {
          user {
            ...A
          }
        }

        fragment A on User {
          ...B
        }

        fragment B on User {
          ...A
          field(arg: $id)
        }
      `),
    ).to.equal(dedent`
      query Q($id: ID!) {
        user {
          ...A
        }
      }

      fragment A on User {
        ...B
      }

      fragment B on User {
        ...A
        field(arg: $id)
      }
    `);
  });

  it('only considers fragments reachable from the current operation', () => {
    expect(
      pruned(`
        query First($unused: String) {
          first
        }

        query Second($used: String) {
          second(arg: $used)
        }

        fragment Unrelated on T {
          field(arg: $unused)
        }
      `),
    ).to.equal(dedent`
      query First {
        first
      }

      query Second($used: String) {
        second(arg: $used)
      }

      fragment Unrelated on T {
        field(arg: $unused)
      }
    `);
  });

  it('reports unresolved fragment spreads instead of ignoring them', () => {
    const document = parse(`
      query Q($id: ID!) {
        user {
          ...Missing
        }
      }
    `);

    expect(() => pruneUnusedVariables(document)).to.throw(
      'Unknown fragment "Missing".',
    );
  });

  it('reports fragments missing from behind a spread chain', () => {
    const document = parse(`
      query Q($id: ID!) {
        user {
          ...Known
        }
      }

      fragment Known on User {
        ...Missing
      }
    `);

    expect(() => pruneUnusedVariables(document)).to.throw(
      'Unknown fragment "Missing".',
    );
  });

  it('handles anonymous operations and removes all unused variables', () => {
    expect(
      pruned(`
        query ($a: String, $b: String) {
          field(arg: $a)
        }
      `),
    ).to.equal(dedent`
      query ($a: String) {
        field(arg: $a)
      }
    `);
  });

  it('prunes each operation type independently', () => {
    expect(
      pruned(`
        mutation Create($input: Input!, $unused: String) {
          create(input: $input) {
            id
          }
        }

        subscription Watch($topic: String!, $unused: Int) {
          watch(topic: $topic) {
            id
          }
        }
      `),
    ).to.equal(dedent`
      mutation Create($input: Input!) {
        create(input: $input) {
          id
        }
      }

      subscription Watch($topic: String!) {
        watch(topic: $topic) {
          id
        }
      }
    `);
  });

  it('drops every variable definition when none are referenced', () => {
    const result = pruneUnusedVariables(
      parse(`
        query Q($a: String, $b: Int) {
          field
        }
      `),
    );
    const operation = result.definitions[0];
    if (operation.kind !== Kind.OPERATION_DEFINITION) {
      throw new Error('Expected an operation definition');
    }
    expect(operation.variableDefinitions).to.deep.equal([]);
  });

  it('returns a new AST without mutating the input', () => {
    const document = parse(`
      query Q($id: ID!, $unused: String) {
        field(arg: $id)
      }
    `);

    const result = pruneUnusedVariables(document);

    expect(result).to.not.equal(document);
    expect(result.definitions).to.not.equal(document.definitions);
    const resultOperation = result.definitions[0];
    const sourceOperation = document.definitions[0];
    if (
      resultOperation.kind !== Kind.OPERATION_DEFINITION ||
      sourceOperation.kind !== Kind.OPERATION_DEFINITION
    ) {
      throw new Error('Expected operation definitions');
    }
    expect(resultOperation).to.not.equal(sourceOperation);
    expect(resultOperation.variableDefinitions).to.have.lengthOf(1);
    // The input document is untouched.
    expect(sourceOperation.variableDefinitions).to.have.lengthOf(2);
    expect(print(document)).to.equal(dedent`
      query Q($id: ID!, $unused: String) {
        field(arg: $id)
      }
    `);
  });

  it('returns a new document even when nothing is pruned', () => {
    const document = parse(`
      query Q($id: ID!) {
        field(arg: $id)
      }
    `);

    const result = pruneUnusedVariables(document);

    expect(result).to.not.equal(document);
    expect(result.definitions[0]).to.equal(document.definitions[0]);
  });

  it('leaves operations without variable definitions untouched', () => {
    const document = parse(`
      query Q {
        field
      }

      fragment F on T {
        other
      }
    `);

    const result = pruneUnusedVariables(document);

    expect(result.definitions[0]).to.equal(document.definitions[0]);
    expect(result.definitions[1]).to.equal(document.definitions[1]);
  });

  it('does not modify shared fragments or selection sets', () => {
    const document = parse(`
      query First($id: ID!, $unused: String) {
        ...Shared
      }

      query Second {
        ...Shared
      }

      fragment Shared on T {
        field(arg: $id)
      }
    `);

    const result = pruneUnusedVariables(document);

    expect(result.definitions[2]).to.equal(document.definitions[2]);
    const firstOperation = result.definitions[0];
    const sourceFirstOperation = document.definitions[0];
    if (
      firstOperation.kind !== Kind.OPERATION_DEFINITION ||
      sourceFirstOperation.kind !== Kind.OPERATION_DEFINITION
    ) {
      throw new Error('Expected operation definitions');
    }
    // The selection set node is shared; only the variable definitions change.
    expect(firstOperation.selectionSet).to.equal(
      sourceFirstOperation.selectionSet,
    );
    expect(firstOperation.directives).to.equal(sourceFirstOperation.directives);
  });
});
