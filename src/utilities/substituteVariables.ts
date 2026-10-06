/** @category Operations */

import { invariant } from '../jsutils/invariant.ts';

import { GraphQLError } from '../error/GraphQLError.ts';

import type {
  ConstValueNode,
  DirectiveNode,
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  FragmentSpreadNode,
  InlineFragmentNode,
  OperationDefinitionNode,
  SelectionSetNode,
  VariableDefinitionNode,
} from '../language/ast.ts';
import { Kind } from '../language/kinds.ts';
import { visit } from '../language/visitor.ts';

import {
  GraphQLIncludeDirective,
  GraphQLSkipDirective,
} from '../type/directives.ts';
import type { GraphQLSchema } from '../type/schema.ts';

import { getVariableValues } from '../execution/values.ts';

import { getOperationAST } from './getOperationAST.ts';
import { valueToLiteral } from './valueToLiteral.ts';

/**
 * Produces a new document for a single operation in which the provided
 * variable values are substituted directly into the AST as literals.
 *
 * Each provided value is first coerced against the variable's declared type
 * (applying list coercion, input object defaults, and so on) and the coerced
 * value is converted to an AST literal which replaces every matching
 * `Variable` node within the operation and the fragments reachable from it.
 * Variables for which no value is provided are left as-is, keeping their
 * definitions intact. Fragments which are also reachable from another
 * operation are left untouched, so the other operations keep working.
 * Variable definitions which are no longer referenced and fragment
 * definitions which are no longer spread are removed.
 *
 * `@skip` and `@include` directives whose `if` argument becomes a known
 * boolean are folded away, keeping or dropping the selection they sit on.
 * If dropping selections would leave a selection set empty, an error is
 * thrown instead of producing an invalid document.
 *
 * The original document is never modified, no resolvers are called, and the
 * returned document passes the standard `validate()` rules, so it can be
 * handed to any compliant executor.
 * @param schema - GraphQL schema to use.
 * @param document - The parsed GraphQL document to transform.
 * @param variableValues - The variable values to substitute, keyed by
 * variable name. Variables without an entry (or with an `undefined` entry)
 * are not substituted.
 * @param operationName - The operation to substitute into. Required if the
 * document contains multiple operations.
 * @returns A new document with the provided variables inlined.
 * @example
 * ```ts
 * import { parse, print } from 'graphql/language';
 * import { buildSchema, substituteVariables } from 'graphql/utilities';
 *
 * const schema = buildSchema(`
 *   type Query {
 *     reviews(minStars: Int): [String]
 *     reviewCount: Int
 *   }
 * `);
 *
 * const document = parse(`
 *   query GetReviews($minStars: Int, $withCount: Boolean!) {
 *     reviews(minStars: $minStars)
 *     ...ReviewCount @include(if: $withCount)
 *   }
 *
 *   fragment ReviewCount on Query {
 *     reviewCount
 *   }
 * `);
 *
 * const substituted = substituteVariables(schema, document, {
 *   minStars: 4,
 *   withCount: false,
 * });
 *
 * print(substituted);
 * // => query GetReviews {
 * //      reviews(minStars: 4)
 * //    }
 * ```
 */
export function substituteVariables(
  schema: GraphQLSchema,
  document: DocumentNode,
  variableValues: { readonly [variable: string]: unknown },
  operationName?: string,
): DocumentNode {
  const operation = getOperationAST(document, operationName);
  if (operation == null) {
    throw new GraphQLError(
      operationName == null
        ? 'Must provide an operation name if the document contains multiple operations.'
        : `Unknown operation named "${operationName}".`,
    );
  }

  // Coerce only the provided values against the declared variable types,
  // leaving variables without a provided value untouched.
  const providedVarDefs: Array<VariableDefinitionNode> = [];
  const providedInputs: { [variable: string]: unknown } = Object.create(null);
  for (const varDef of operation.variableDefinitions ?? []) {
    const varName = varDef.variable.name.value;
    const value = Object.hasOwn(variableValues, varName)
      ? variableValues[varName]
      : undefined;
    if (value !== undefined) {
      providedVarDefs.push(varDef);
      providedInputs[varName] = value;
    }
  }

  const coerced = getVariableValues(schema, providedVarDefs, providedInputs);
  if (coerced.errors !== undefined) {
    throw coerced.errors[0];
  }
  const { coerced: coercedValues, sources } = coerced.variableValues;

  // Convert each coerced value to an AST literal of the declared type, which
  // also takes care of printing concerns such as string escaping.
  const literals = new Map<string, ConstValueNode>();
  for (const varDef of providedVarDefs) {
    const varName = varDef.variable.name.value;
    let literal: ConstValueNode | undefined;
    try {
      literal = valueToLiteral(
        coercedValues[varName],
        sources[varName].signature.type,
      );
    } catch {
      literal = undefined;
    }
    if (literal === undefined) {
      throw new GraphQLError(
        `Variable "$${varName}" has a value which cannot be represented as a GraphQL literal.`,
        { nodes: varDef },
      );
    }
    literals.set(varName, literal);
  }

  const fragmentDefs = new Map<string, FragmentDefinitionNode>();
  const otherOperations: Array<OperationDefinitionNode> = [];
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragmentDefs.set(definition.name.value, definition);
    } else if (
      definition.kind === Kind.OPERATION_DEFINITION &&
      definition !== operation
    ) {
      otherOperations.push(definition);
    }
  }

  // Fragments reachable from the target operation may be rewritten, unless
  // they are also reachable from another operation, in which case they must
  // be left untouched to keep those other operations intact.
  const targetFragments = new Set<string>();
  collectFragmentNames(operation.selectionSet, fragmentDefs, targetFragments);
  const sharedFragments = new Set<string>();
  for (const otherOperation of otherOperations) {
    collectFragmentNames(
      otherOperation.selectionSet,
      fragmentDefs,
      sharedFragments,
    );
  }
  const editableFragments = new Set<string>();
  for (const name of targetFragments) {
    if (!sharedFragments.has(name)) {
      editableFragments.add(name);
    }
  }

  let transformedOperation: OperationDefinitionNode | undefined;
  const transformed = visit(document, {
    OperationDefinition: {
      enter(node) {
        // Leave operations other than the target one untouched.
        return node === operation ? undefined : false;
      },
      leave(node) {
        transformedOperation = node;
        return undefined;
      },
    },
    FragmentDefinition: {
      enter(node) {
        return editableFragments.has(node.name.value) ? undefined : false;
      },
    },
    VariableDefinition: {
      enter() {
        // Never substitute within the variable definitions themselves.
        return false;
      },
    },
    Variable(node) {
      const literal = literals.get(node.name.value);
      // Unknown variables are left as-is.
      return literal === undefined ? undefined : { ...literal, loc: node.loc };
    },
    Field: {
      leave: foldStaticConditionalDirectives,
    },
    FragmentSpread: {
      leave: foldStaticConditionalDirectives,
    },
    InlineFragment: {
      leave: foldStaticConditionalDirectives,
    },
    SelectionSet: {
      leave(node) {
        if (node.selections.length === 0) {
          throw new GraphQLError(
            'Substituting the provided variables produces an empty selection set, so a valid document cannot be generated.',
            { nodes: node },
          );
        }
        return undefined;
      },
    },
  });
  invariant(transformedOperation !== undefined);

  // Collect the fragments and variables still in use after the rewrite.
  const transformedFragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of transformed.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      transformedFragments.set(definition.name.value, definition);
    }
  }

  const usedFragments = new Set<string>();
  for (const definition of transformed.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      collectFragmentNames(
        definition.selectionSet,
        transformedFragments,
        usedFragments,
      );
    }
  }

  const usedVariables = new Set<string>();
  const collectUsedVariables = (
    node: OperationDefinitionNode | FragmentDefinitionNode,
  ): void => {
    visit(node, {
      VariableDefinition: () => false,
      Variable(variable) {
        usedVariables.add(variable.name.value);
      },
    });
  };
  const reachableFromTarget = new Set<string>();
  collectFragmentNames(
    transformedOperation.selectionSet,
    transformedFragments,
    reachableFromTarget,
  );
  collectUsedVariables(transformedOperation);
  for (const name of reachableFromTarget) {
    const fragment = transformedFragments.get(name);
    if (fragment !== undefined) {
      collectUsedVariables(fragment);
    }
  }

  // Remove the variable definitions and fragment definitions which are no
  // longer referenced.
  return visit(transformed, {
    OperationDefinition: {
      enter(node) {
        if (node !== transformedOperation || node.variableDefinitions == null) {
          return undefined;
        }
        const usedDefs = node.variableDefinitions.filter((varDef) =>
          usedVariables.has(varDef.variable.name.value),
        );
        return usedDefs.length === node.variableDefinitions.length
          ? undefined
          : { ...node, variableDefinitions: usedDefs };
      },
    },
    FragmentDefinition: {
      enter(node) {
        return usedFragments.has(node.name.value) ? undefined : null;
      },
    },
  });
}

// Folds `@skip` and `@include` directives whose `if` argument is a known
// boolean, either dropping the selection (by returning `null`) or keeping it
// with the now-static directive removed. Directives with a still-unknown
// condition are left untouched.
function foldStaticConditionalDirectives(
  node: FieldNode | FragmentSpreadNode | InlineFragmentNode,
): FieldNode | FragmentSpreadNode | InlineFragmentNode | null | undefined {
  const directives = node.directives;
  if (directives === undefined) {
    return undefined;
  }
  const keptDirectives: Array<DirectiveNode> = [];
  let hasChanges = false;
  for (const directive of directives) {
    const directiveName = directive.name.value;
    if (
      directiveName === GraphQLSkipDirective.name ||
      directiveName === GraphQLIncludeDirective.name
    ) {
      const ifArgument = directive.arguments?.find(
        (argument) => argument.name.value === 'if',
      );
      if (ifArgument?.value.kind === Kind.BOOLEAN) {
        hasChanges = true;
        const isDropped =
          directiveName === GraphQLSkipDirective.name
            ? ifArgument.value.value
            : !ifArgument.value.value;
        if (isDropped) {
          return null;
        }
        continue;
      }
    }
    keptDirectives.push(directive);
  }
  return hasChanges ? { ...node, directives: keptDirectives } : undefined;
}

// Collects the names of all fragments transitively spread from the given
// selection set into the `into` set.
function collectFragmentNames(
  selectionSet: SelectionSetNode,
  fragmentDefs: ReadonlyMap<string, FragmentDefinitionNode>,
  into: Set<string>,
): void {
  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD:
        if (selection.selectionSet !== undefined) {
          collectFragmentNames(selection.selectionSet, fragmentDefs, into);
        }
        break;
      case Kind.INLINE_FRAGMENT:
        collectFragmentNames(selection.selectionSet, fragmentDefs, into);
        break;
      case Kind.FRAGMENT_SPREAD: {
        const name = selection.name.value;
        if (!into.has(name)) {
          into.add(name);
          const fragment = fragmentDefs.get(name);
          if (fragment !== undefined) {
            collectFragmentNames(fragment.selectionSet, fragmentDefs, into);
          }
        }
        break;
      }
    }
  }
}
