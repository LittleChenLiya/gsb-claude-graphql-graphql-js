/** @category AST Utilities */

import type { ObjMap } from '../jsutils/ObjMap.ts';

import { GraphQLError } from '../error/GraphQLError.ts';

import type {
  DocumentNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
} from '../language/ast.ts';
import { Kind } from '../language/kinds.ts';
import { visit } from '../language/visitor.ts';

/**
 * pruneUnusedVariables accepts a single AST document which may contain many
 * operations and fragments and returns a new document in which every
 * operation keeps only the variable definitions it actually uses.
 *
 * A variable is considered used when it is referenced anywhere in the
 * operation: in field or directive arguments, inside input values, or within
 * any fragment reachable from the operation through fragment spreads
 * (including spread chains and fragment cycles). The operation itself is
 * only rewritten when at least one of its variable definitions is removed;
 * shared fragment definitions and selection sets are never modified.
 *
 * Because this is an offline, syntactic transformation, it does not consult a
 * schema, type information, or resolvers to infer runtime behavior. An
 * unknown fragment spread is an error rather than treated as using nothing,
 * and fragment cycles are traversed in full instead of being silently
 * skipped, since skipping either could cause a used variable definition to
 * be deleted.
 *
 * For the retained variable definitions the declaration order as well as the
 * type reference, default value, and directives are preserved verbatim.
 * @param documentAST - The parsed GraphQL document AST.
 * @returns A new document AST in which each operation only declares the variables it uses.
 * @throws {@link GraphQLError} when an operation spreads a fragment that is not defined in the document.
 * @example
 * ```ts
 * import { parse, print } from 'graphql/language';
 * import { pruneUnusedVariables } from 'graphql/utilities';
 *
 * const document = parse(`
 *   query GetUser($id: ID!, $unused: String) {
 *     user(id: $id) {
 *       id
 *       ...UserFields
 *     }
 *   }
 *
 *   fragment UserFields on User {
 *     name
 *   }
 *
 *   query Other($unused: String) {
 *     field(arg: $unused)
 *   }
 * `);
 *
 * print(pruneUnusedVariables(document));
 * // query GetUser($id: ID!) {
 * //   user(id: $id) {
 * //     id
 * //     ...UserFields
 * //   }
 * // }
 * //
 * // fragment UserFields on User {
 * //   name
 * // }
 * //
 * // query Other($unused: String) {
 * //   field(arg: $unused)
 * // }
 * ```
 */
export function pruneUnusedVariables(documentAST: DocumentNode): DocumentNode {
  const fragments: ObjMap<FragmentDefinitionNode> = Object.create(null);
  for (const definition of documentAST.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments[definition.name.value] = definition;
    }
  }

  let documentChanged = false;
  const definitions = documentAST.definitions.map((definition) => {
    if (definition.kind !== Kind.OPERATION_DEFINITION) {
      return definition;
    }

    const variableDefinitions = definition.variableDefinitions;
    if (variableDefinitions === undefined || variableDefinitions.length === 0) {
      return definition;
    }

    const usedVariableNames = collectUsedVariables(definition, fragments);
    const retainedDefinitions = variableDefinitions.filter(
      (variableDefinition) =>
        usedVariableNames.has(variableDefinition.variable.name.value),
    );

    if (retainedDefinitions.length === variableDefinitions.length) {
      return definition;
    }

    documentChanged = true;
    return { ...definition, variableDefinitions: retainedDefinitions };
  });

  if (!documentChanged) {
    return { ...documentAST };
  }

  return { ...documentAST, definitions };
}

// Collects the names of all variables referenced by the given operation,
// including references inside fragments transitively reachable from it.
//
// Reachable fragments are processed with an explicit work list and a set of
// visited names so that fragment cycles terminate while still scanning every
// reachable fragment exactly once. A spread of a fragment missing from the
// document is reported as an error: such a spread cannot be proven not to
// reference variables, so it must not be silently ignored.
function collectUsedVariables(
  operation: OperationDefinitionNode,
  fragments: ObjMap<FragmentDefinitionNode>,
): Set<string> {
  const usedVariableNames = new Set<string>();
  const visitedFragments = new Set<string>();
  const fragmentsToVisit: Array<FragmentDefinitionNode> = [];

  // Collect variable references from a single node while queuing any newly
  // encountered fragment spreads. Both operations and fragments are scanned
  // with this visitor.
  const scan = (
    node: OperationDefinitionNode | FragmentDefinitionNode,
  ): void => {
    visit(node, {
      // A variable declaration is not a use of that variable, so do not
      // descend into the variable definitions (including their default
      // values) when collecting references.
      VariableDefinition() {
        return false;
      },
      Variable(variableNode) {
        usedVariableNames.add(variableNode.name.value);
      },
      FragmentSpread(spreadNode) {
        const fragmentName = spreadNode.name.value;
        if (visitedFragments.has(fragmentName)) {
          return;
        }
        visitedFragments.add(fragmentName);

        // Point the error at the spread instead of silently treating the
        // missing fragment as if it used no variables.
        const fragment = fragments[fragmentName];
        if (fragment === undefined) {
          throw new GraphQLError(`Unknown fragment "${fragmentName}".`, {
            nodes: [spreadNode],
          });
        }
        fragmentsToVisit.push(fragment);
      },
    });
  };

  // The visited set makes fragment cycles terminate, while each reachable
  // fragment (including every fragment participating in a cycle) is still
  // scanned in full for variable references.
  scan(operation);

  let fragment: FragmentDefinitionNode | undefined;
  while ((fragment = fragmentsToVisit.pop()) !== undefined) {
    scan(fragment);
  }

  return usedVariableNames;
}
