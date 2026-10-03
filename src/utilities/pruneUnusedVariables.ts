/** @category AST Utilities */

import { GraphQLError } from '../error/GraphQLError.ts';

import type {
  ASTNode,
  DocumentNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
  SelectionSetNode,
} from '../language/ast.ts';
import { Kind } from '../language/kinds.ts';
import { visit } from '../language/visitor.ts';

/**
 * pruneUnusedVariables returns a new AST document in which every operation's
 * variable definitions are reduced to only the variables actually used by
 * that operation.
 *
 * A variable is considered used when it is referenced by a field argument, a
 * directive, or a fragment spread reachable from the operation. Reachability
 * is determined purely syntactically, without invoking any schema or
 * resolver, so the result does not depend on runtime behavior.
 *
 * Each operation is processed independently: a variable definition is kept
 * for an operation if that operation (or one of its reachable fragments)
 * references it, even if other operations never use it. Shared fragments and
 * selection sets are never modified. The type, default value, and directives
 * of retained variable definitions are preserved, as is their original order.
 *
 * Unresolved fragment spreads and fragment cycles cannot be pruned safely
 * (an unreachable fragment would hide variable references and cause a
 * variable that is actually used to be removed), so they raise an error
 * instead of being silently ignored.
 * @param documentAST - The parsed GraphQL document AST.
 * @returns A new document AST with unused variable definitions removed.
 * @example
 * ```ts
 * import { parse, print } from 'graphql/language';
 * import { pruneUnusedVariables } from 'graphql/utilities';
 *
 * const document = parse(`
 *   query GetUser($id: ID!, $unused: String) {
 *     ...UserFields
 *   }
 *
 *   fragment UserFields on User {
 *     user(id: $id) {
 *       name
 *     }
 *   }
 * `);
 *
 * const prunedDocument = pruneUnusedVariables(document);
 *
 * print(prunedDocument);
 * // query GetUser($id: ID!) {
 * //   ...UserFields
 * // }
 * //
 * // fragment UserFields on User {
 * //   user(id: $id) {
 * //     name
 * //   }
 * // }
 * ```
 */
export function pruneUnusedVariables(documentAST: DocumentNode): DocumentNode {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of documentAST.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }

  return {
    kind: Kind.DOCUMENT,
    definitions: documentAST.definitions.map((definition) => {
      if (definition.kind !== Kind.OPERATION_DEFINITION) {
        return definition;
      }
      return pruneOperation(definition, fragments);
    }),
  };
}

function pruneOperation(
  operation: OperationDefinitionNode,
  fragments: Map<string, FragmentDefinitionNode>,
): OperationDefinitionNode {
  const variableDefinitions = operation.variableDefinitions;
  if (variableDefinitions == null || variableDefinitions.length === 0) {
    return operation;
  }

  const usedVariables = new Set<string>();
  for (const fragment of collectReachableFragments(operation, fragments)) {
    collectVariableUsages(fragment, usedVariables);
  }
  collectVariableUsages(operation, usedVariables);

  const usedVariableDefinitions = variableDefinitions.filter((definition) =>
    usedVariables.has(definition.variable.name.value),
  );

  if (usedVariableDefinitions.length === variableDefinitions.length) {
    return operation;
  }

  return {
    ...operation,
    variableDefinitions: usedVariableDefinitions,
  };
}

// Collects the fragments reachable from the operation, raising an error for
// unresolved spreads or fragment cycles instead of silently ignoring them.
function collectReachableFragments(
  operation: OperationDefinitionNode,
  fragments: Map<string, FragmentDefinitionNode>,
): Set<FragmentDefinitionNode> {
  const reachableFragments = new Set<FragmentDefinitionNode>();
  // The chain of fragment spreads currently being explored, used to detect
  // cycles.
  const spreadPath: Array<string> = [];

  function visitSelectionSet(selectionSet: SelectionSetNode): void {
    for (const selection of selectionSet.selections) {
      switch (selection.kind) {
        case Kind.FIELD:
          if (selection.selectionSet != null) {
            visitSelectionSet(selection.selectionSet);
          }
          break;
        case Kind.FRAGMENT_SPREAD: {
          const fragmentName = selection.name.value;
          const fragment = fragments.get(fragmentName);
          if (fragment == null) {
            throw new GraphQLError(
              `Cannot prune unused variables: unknown fragment "${fragmentName}".`,
              { nodes: selection },
            );
          }
          if (spreadPath.includes(fragmentName)) {
            throw new GraphQLError(
              `Cannot prune unused variables: cannot reach fragment "${fragmentName}" without a fragment cycle.`,
              { nodes: selection },
            );
          }
          if (!reachableFragments.has(fragment)) {
            reachableFragments.add(fragment);
            spreadPath.push(fragmentName);
            visitSelectionSet(fragment.selectionSet);
            spreadPath.pop();
          }
          break;
        }
        case Kind.INLINE_FRAGMENT:
          visitSelectionSet(selection.selectionSet);
          break;
      }
    }
  }

  visitSelectionSet(operation.selectionSet);
  return reachableFragments;
}

// Collects the names of all variables referenced within the node's subtree,
// skipping variable definitions (which declare rather than use a variable).
function collectVariableUsages(
  node: ASTNode,
  usedVariables: Set<string>,
): void {
  visit(node, {
    VariableDefinition: () => false,
    Variable(variable) {
      usedVariables.add(variable.name.value);
    },
  });
}
