import { describe, it } from 'node:test';

import { expect } from 'chai';

import { dedent } from '../../__testUtils__/dedent.ts';

import { Kind } from '../../language/kinds.ts';
import { parse } from '../../language/parser.ts';
import { print } from '../../language/printer.ts';

import { pruneUnusedVariables } from '../pruneUnusedVariables.ts';

describe('pruneUnusedVariables', () => {
  it('removes unused variable definitions, keeping variables used in reachable fragments', () => {
    const ast = parse(`
      query GetUser($id: ID!, $unused: String) {
        ...UserFields
      }

      fragment UserFields on User {
        user(id: $id) {
          name
        }
      }
    `);

    const prunedAST = pruneUnusedVariables(ast);

    expect(print(prunedAST)).to.equal(dedent`
      query GetUser($id: ID!) {
        ...UserFields
      }

      fragment UserFields on User {
        user(id: $id) {
          name
        }
      }
    `);
  });

  it('keeps the definitions used by another operation in the same document', () => {
    const ast = parse(`
      query GetUser($id: ID!, $unused: String) {
        ...UserFields
      }

      query GetUnused($unused: String) {
        user(name: $unused) {
          id
        }
      }

      fragment UserFields on User {
        user(id: $id) {
          name
        }
      }
    `);

    const prunedAST = pruneUnusedVariables(ast);

    expect(print(prunedAST)).to.equal(dedent`
      query GetUser($id: ID!) {
        ...UserFields
      }

      query GetUnused($unused: String) {
        user(name: $unused) {
          id
        }
      }

      fragment UserFields on User {
        user(id: $id) {
          name
        }
      }
    `);
  });

  it('keeps variables referenced by directives', () => {
    const ast = parse(`
      query WithDirective($if: Boolean!, $unused: String) {
        field @skip(if: $if)
        ...Spread @include(if: $if)
      }

      fragment Spread on Query {
        otherField
      }
    `);

    const prunedAST = pruneUnusedVariables(ast);

    expect(print(prunedAST)).to.equal(dedent`
      query WithDirective($if: Boolean!) {
        field @skip(if: $if)
        ...Spread @include(if: $if)
      }

      fragment Spread on Query {
        otherField
      }
    `);
  });

  it('preserves default values and directives of retained definitions', () => {
    const ast = parse(`
      query WithDefaults(
        $used: String = "default"
        $unused: Int = 3
        $usedDirective: Boolean! @deprecated
      ) {
        field(arg: $used)
        ... @skip(if: $usedDirective) {
          other
        }
      }
    `);

    const prunedAST = pruneUnusedVariables(ast);

    expect(print(prunedAST)).to.equal(dedent`
      query WithDefaults($used: String = "default", $usedDirective: Boolean! @deprecated) {
        field(arg: $used)
        ... @skip(if: $usedDirective) {
          other
        }
      }
    `);
  });

  it('preserves the original order of retained definitions', () => {
    const ast = parse(`
      query Order($a: ID, $unused1: String, $b: Int, $unused2: Boolean) {
        field(a: $a, b: $b)
      }
    `);

    const prunedAST = pruneUnusedVariables(ast);

    expect(print(prunedAST)).to.equal(dedent`
      query Order($a: ID, $b: Int) {
        field(a: $a, b: $b)
      }
    `);
  });

  it('keeps variables used in inline fragments and nested fragment spreads', () => {
    const ast = parse(`
      query Deep($inlineVar: String!, $nestedVar: ID!, $unused: Int) {
        ... on Query {
          inlineField(arg: $inlineVar)
        }
        ...Outer
      }

      fragment Outer on Query {
        ...Inner
      }

      fragment Inner on Query {
        innerField(id: $nestedVar)
      }
    `);

    const prunedAST = pruneUnusedVariables(ast);

    expect(print(prunedAST)).to.equal(dedent`
      query Deep($inlineVar: String!, $nestedVar: ID!) {
        ... on Query {
          inlineField(arg: $inlineVar)
        }
        ...Outer
      }

      fragment Outer on Query {
        ...Inner
      }

      fragment Inner on Query {
        innerField(id: $nestedVar)
      }
    `);
  });

  it('does not mutate the input document or shared fragments', () => {
    const ast = parse(`
      query One($id: ID!, $unused: String) {
        ...UserFields
      }

      query Two($id: ID!) {
        user(id: $id) {
          name
        }
      }

      fragment UserFields on User {
        user(id: $id) {
          name
        }
      }
    `);

    const snapshot = print(ast);
    const prunedAST = pruneUnusedVariables(ast);

    // The input document is unchanged.
    expect(print(ast)).to.equal(snapshot);
    expect(print(ast)).to.match(/\$unused/);

    // Shared fragments are the exact same node references.
    const originalFragment = ast.definitions.find(
      (node) =>
        node.kind === Kind.FRAGMENT_DEFINITION &&
        node.name.value === 'UserFields',
    );
    const prunedFragment = prunedAST.definitions.find(
      (node) =>
        node.kind === Kind.FRAGMENT_DEFINITION &&
        node.name.value === 'UserFields',
    );
    expect(prunedFragment).to.equal(originalFragment);

    // The pruned document is a new AST.
    expect(prunedAST).to.not.equal(ast);
  });

  it('raises an error for unknown fragments instead of treating them as unused', () => {
    const ast = parse(`
      query WithUnknown($id: ID!) {
        ...Missing
      }
    `);

    expect(() => pruneUnusedVariables(ast)).to.throw(
      'Cannot prune unused variables: unknown fragment "Missing".',
    );
  });

  it('raises an error for fragment cycles instead of silently skipping them', () => {
    const ast = parse(`
      query WithCycle($id: ID!) {
        ...A
      }

      fragment A on Query {
        ...B
      }

      fragment B on Query {
        ...A
      }
    `);

    expect(() => pruneUnusedVariables(ast)).to.throw(
      'Cannot prune unused variables: cannot reach fragment "A" without a fragment cycle.',
    );
  });

  it('raises an error for self-referencing fragment cycles', () => {
    const ast = parse(`
      query WithSelfCycle($id: ID!) {
        ...A
      }

      fragment A on Query {
        ...A
      }
    `);

    expect(() => pruneUnusedVariables(ast)).to.throw(
      'Cannot prune unused variables: cannot reach fragment "A" without a fragment cycle.',
    );
  });

  it('returns operations without variable definitions unchanged', () => {
    const ast = parse(`
      query NoVars {
        field
      }

      fragment UserFields on User {
        user(id: $id) {
          name
        }
      }
    `);

    const prunedAST = pruneUnusedVariables(ast);

    expect(prunedAST.definitions[0]).to.equal(ast.definitions[0]);
    expect(prunedAST.definitions[1]).to.equal(ast.definitions[1]);
  });
});
