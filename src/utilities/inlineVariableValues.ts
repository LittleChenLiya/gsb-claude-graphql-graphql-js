/** @category AST Utilities */

import { inspect } from '../jsutils/inspect.ts';
import type { Maybe } from '../jsutils/Maybe.ts';
import type { ReadOnlyObjMap } from '../jsutils/ObjMap.ts';

import { GraphQLError } from '../error/GraphQLError.ts';

import type {
  ASTNode,
  ConstValueNode,
  DirectiveNode,
  DocumentNode,
  FragmentDefinitionNode,
  NameNode,
  OperationDefinitionNode,
  SelectionNode,
  SelectionSetNode,
  ValueNode,
} from '../language/ast.ts';
import { Kind } from '../language/kinds.ts';
import { visit } from '../language/visitor.ts';

import { isInputType } from '../type/definition.ts';
import type { GraphQLSchema } from '../type/schema.ts';

import { coerceInputValue } from './coerceInputValue.ts';
import { getOperationAST } from './getOperationAST.ts';
import { typeFromAST } from './typeFromAST.ts';
import { valueToLiteral } from './valueToLiteral.ts';

/**
 * Produces a new document in which the provided variable values of a single
 * operation are inlined as literals, without modifying the original AST.
 *
 * Each provided value is first coerced against the type declared by its
 * variable definition and then converted to a literal which replaces every
 * `Variable` node referencing it. Variables for which no value is provided
 * (including ones only relying on a default value) are left untouched, as are
 * their definitions. Variable definitions which are no longer used after
 * substitution are removed.
 *
 * `@skip` and `@include` directives whose `if` argument is known (either a
 * boolean literal or an inlined variable) are evaluated: selections which can
 * never be included are removed and directives which always pass are dropped.
 * Directives depending on unknown variables are preserved as-is.
 *
 * Fragments shared with other operations are never modified in place; when a
 * shared fragment is affected by substitution, a renamed copy is created for
 * the transformed operation so the other operations keep their meaning.
 * Fragment definitions which become unreachable are removed.
 *
 * The returned document is meant to be passed to the standard `validate` and
 * `execute` functions. No resolvers are called. If evaluating directives
 * would produce an empty selection set, a `GraphQLError` is thrown (pointing
 * at the original selection set) instead of fabricating a placeholder field.
 * @param schema - The GraphQL schema used to coerce variable values.
 * @param document - The parsed GraphQL document containing the operation.
 * @param variableValues - A partial map of variable values to inline.
 * @param operationName - The operation to transform, required if the document contains multiple operations.
 * @returns A new document with the provided variable values inlined.
 * @example
 * ```ts
 * import { parse, print } from 'graphql/language';
 * import { buildSchema, inlineVariableValues } from 'graphql/utilities';
 *
 * const schema = buildSchema(`
 *   type Query {
 *     review(stars: Int = 5): String
 *     comment: String
 *   }
 * `);
 * const document = parse(`
 *   query GetReview($stars: Int = 5, $withComment: Boolean!) {
 *     review(stars: $stars)
 *     comment @include(if: $withComment)
 *   }
 * `);
 *
 * const inlined = inlineVariableValues(schema, document, {
 *   stars: 4,
 *   withComment: false,
 * });
 *
 * print(inlined); // => 'query GetReview { review(stars: 4) }'
 * ```
 */
export function inlineVariableValues(
  schema: GraphQLSchema,
  document: DocumentNode,
  variableValues?: Maybe<ReadOnlyObjMap<unknown>>,
  operationName?: Maybe<string>,
): DocumentNode {
  const operation = getOperationAST(document, operationName);
  if (operation == null) {
    throw new GraphQLError(
      operationName == null
        ? 'Must provide an operation name if a document contains multiple operations.'
        : `Unknown operation named "${operationName}".`,
    );
  }

  // Coerce each provided value against its declared variable type and
  // convert it to a literal up front, so substitution below is purely
  // syntactic and cannot produce invalidly typed literals.
  const substitutions = new Map<string, ConstValueNode>();
  const variableDefinitions = operation.variableDefinitions ?? [];
  if (variableValues != null) {
    for (const variableDefinition of variableDefinitions) {
      const varName = variableDefinition.variable.name.value;
      if (!Object.hasOwn(variableValues, varName)) {
        continue;
      }
      const variableType = typeFromAST(schema, variableDefinition.type);
      if (!isInputType(variableType)) {
        throw new GraphQLError(
          `Variable "$${varName}" cannot be inlined because its type is not a defined input type.`,
          { nodes: variableDefinition.type },
        );
      }
      const rawValue = variableValues[varName];
      const coercedValue = coerceInputValue(rawValue, variableType);
      let literal: ConstValueNode | undefined;
      try {
        literal =
          coercedValue === undefined
            ? undefined
            : valueToLiteral(coercedValue, variableType);
      } catch (_error) {
        literal = undefined;
      }
      if (literal === undefined) {
        throw new GraphQLError(
          `Variable "$${varName}" got invalid value ${inspect(rawValue)}.`,
          { nodes: variableDefinition },
        );
      }
      substitutions.set(varName, literal);
    }
  }

  const fragmentDefinitions = new Map<string, FragmentDefinitionNode>();
  const otherOperations: Array<OperationDefinitionNode> = [];
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragmentDefinitions.set(definition.name.value, definition);
    } else if (
      definition.kind === Kind.OPERATION_DEFINITION &&
      definition !== operation
    ) {
      otherOperations.push(definition);
    }
  }

  // Fragments reachable from the other operations must keep their original
  // meaning, so they may never be modified in place.
  const protectedFragments = fragmentClosure(
    otherOperations.flatMap((op) => [...collectSpreadNames(op.selectionSet)]),
  );
  const targetFragments = fragmentClosure(
    collectSpreadNames(operation.selectionSet),
  );

  // A fragment is affected if substitution would change it, directly or
  // through a nested fragment.
  const affectedFragments = new Set<string>();
  let foundNewAffected = true;
  while (foundNewAffected) {
    foundNewAffected = false;
    for (const name of targetFragments) {
      if (affectedFragments.has(name)) {
        continue;
      }
      const definition = fragmentDefinitions.get(name);
      if (definition !== undefined && isAffectedFragment(definition)) {
        affectedFragments.add(name);
        foundNewAffected = true;
      }
    }
  }

  // Affected fragments which are shared with other operations are duplicated
  // under a fresh name, leaving the original definition untouched.
  const usedNames = new Set<string>();
  for (const definition of document.definitions) {
    if (
      definition.kind === Kind.FRAGMENT_DEFINITION ||
      definition.kind === Kind.OPERATION_DEFINITION
    ) {
      if (definition.name !== undefined) {
        usedNames.add(definition.name.value);
      }
    }
  }
  const renamedFragments = new Map<string, string>();
  for (const name of affectedFragments) {
    if (protectedFragments.has(name)) {
      let newName = `${name}__inlined`;
      let counter = 0;
      while (usedNames.has(newName)) {
        counter++;
        newName = `${name}__inlined${counter}`;
      }
      usedNames.add(newName);
      renamedFragments.set(name, newName);
    }
  }

  function isAffectedFragment(definition: FragmentDefinitionNode): boolean {
    const scopedVariables = new Set(
      definition.variableDefinitions?.map(
        (varDef) => varDef.variable.name.value,
      ) ?? [],
    );
    let affected = false;
    const checkNode = (node: ASTNode): void => {
      visit(node, {
        [Kind.VARIABLE](variableNode) {
          if (
            !scopedVariables.has(variableNode.name.value) &&
            substitutions.has(variableNode.name.value)
          ) {
            affected = true;
          }
        },
        [Kind.DIRECTIVE](directiveNode) {
          const directiveName = directiveNode.name.value;
          if (directiveName === 'skip' || directiveName === 'include') {
            const ifArgument = directiveNode.arguments?.find(
              (arg) => arg.name.value === 'if',
            );
            const ifValue = ifArgument?.value;
            if (
              ifValue?.kind === Kind.BOOLEAN ||
              (ifValue?.kind === Kind.VARIABLE &&
                !scopedVariables.has(ifValue.name.value) &&
                substitutions.has(ifValue.name.value))
            ) {
              affected = true;
            }
          }
        },
        [Kind.FRAGMENT_SPREAD](spreadNode) {
          if (affectedFragments.has(spreadNode.name.value)) {
            affected = true;
          }
        },
      });
    };
    checkNode(definition.selectionSet);
    for (const directive of definition.directives ?? []) {
      checkNode(directive);
    }
    return affected;
  }

  function fragmentClosure(initialNames: Iterable<string>): Set<string> {
    const reached = new Set<string>();
    const queue: Array<string> = [];
    for (const name of initialNames) {
      if (!reached.has(name)) {
        reached.add(name);
        queue.push(name);
      }
    }
    for (const name of queue) {
      const definition = fragmentDefinitions.get(name);
      if (definition !== undefined) {
        for (const spreadName of collectSpreadNames(definition.selectionSet)) {
          if (!reached.has(spreadName)) {
            reached.add(spreadName);
            queue.push(spreadName);
          }
        }
      }
    }
    return reached;
  }

  // Transforms selection sets, replacing variables found in `subs` and
  // evaluating `@skip`/`@include` directives with known outcomes.
  function createTransformer(subs: ReadonlyMap<string, ConstValueNode>) {
    const transformValue = (node: ValueNode): ValueNode => {
      switch (node.kind) {
        case Kind.VARIABLE: {
          const literal = subs.get(node.name.value);
          // Keep the original location so later errors point at the
          // original document.
          return literal === undefined ? node : { ...literal, loc: node.loc };
        }
        case Kind.LIST:
          return { ...node, values: node.values.map(transformValue) };
        case Kind.OBJECT:
          return {
            ...node,
            fields: node.fields.map((field) => ({
              ...field,
              value: transformValue(field.value),
            })),
          };
        default:
          return node;
      }
    };

    const transformDirectiveArguments = (
      directive: DirectiveNode,
    ): DirectiveNode =>
      directive.arguments === undefined
        ? directive
        : {
            ...directive,
            arguments: directive.arguments.map((arg) => ({
              ...arg,
              value: transformValue(arg.value),
            })),
          };

    // Returns the directives to keep, or `null` if the node they belong to
    // can never be selected.
    const transformDirectives = (
      directives: ReadonlyArray<DirectiveNode> | undefined,
    ): ReadonlyArray<DirectiveNode> | null => {
      const newDirectives: Array<DirectiveNode> = [];
      for (const directive of directives ?? []) {
        const directiveName = directive.name.value;
        if (directiveName === 'skip' || directiveName === 'include') {
          const ifArgument = directive.arguments?.find(
            (arg) => arg.name.value === 'if',
          );
          if (ifArgument !== undefined) {
            const ifValue = transformValue(ifArgument.value);
            if (ifValue.kind === Kind.BOOLEAN) {
              const keep =
                directiveName === 'skip' ? !ifValue.value : ifValue.value;
              if (!keep) {
                return null;
              }
              // The directive always passes, so it can be dropped.
              continue;
            }
          }
        }
        newDirectives.push(transformDirectiveArguments(directive));
      }
      return newDirectives;
    };

    const transformSelection = (
      selection: SelectionNode,
    ): SelectionNode | null => {
      const directives = transformDirectives(selection.directives);
      if (directives === null) {
        return null;
      }
      switch (selection.kind) {
        case Kind.FIELD:
          return {
            ...selection,
            arguments: selection.arguments?.map((arg) => ({
              ...arg,
              value: transformValue(arg.value),
            })),
            directives,
            selectionSet:
              selection.selectionSet === undefined
                ? undefined
                : transformSelectionSet(selection.selectionSet),
          };
        case Kind.FRAGMENT_SPREAD: {
          const newName = renamedFragments.get(selection.name.value);
          return {
            ...selection,
            name:
              newName === undefined ? selection.name : renamedNameNode(newName),
            arguments: selection.arguments?.map((arg) => ({
              ...arg,
              value: transformValue(arg.value),
            })),
            directives,
          };
        }
        case Kind.INLINE_FRAGMENT:
          return {
            ...selection,
            directives,
            selectionSet: transformSelectionSet(selection.selectionSet),
          };
      }
    };

    const transformSelectionSet = (
      selectionSet: SelectionSetNode,
    ): SelectionSetNode => {
      const selections: Array<SelectionNode> = [];
      for (const selection of selectionSet.selections) {
        const transformed = transformSelection(selection);
        if (transformed !== null) {
          selections.push(transformed);
        }
      }
      if (selections.length === 0) {
        throw new GraphQLError(
          'Inlining variable values produces an empty selection set, which cannot be expressed as a valid GraphQL document.',
          { nodes: selectionSet },
        );
      }
      return { ...selectionSet, selections };
    };

    return {
      transformValue,
      transformDirectiveArguments,
      transformSelectionSet,
    };
  }

  const operationTransformer = createTransformer(substitutions);

  const transformFragmentDefinition = (
    definition: FragmentDefinitionNode,
  ): FragmentDefinitionNode => {
    // Fragment scoped variables (experimental fragment arguments) shadow
    // operation variables of the same name within the fragment body.
    const transformer =
      definition.variableDefinitions === undefined
        ? operationTransformer
        : createTransformer(
            new Map(
              [...substitutions].filter(
                ([name]) =>
                  !definition.variableDefinitions?.some(
                    (varDef) => varDef.variable.name.value === name,
                  ),
              ),
            ),
          );
    return {
      ...definition,
      directives: definition.directives?.map(
        transformer.transformDirectiveArguments,
      ),
      selectionSet: transformer.transformSelectionSet(definition.selectionSet),
    };
  };

  const newOperation: OperationDefinitionNode = {
    ...operation,
    directives: operation.directives?.map(
      operationTransformer.transformDirectiveArguments,
    ),
    selectionSet: operationTransformer.transformSelectionSet(
      operation.selectionSet,
    ),
  };

  // Transform the fragments reachable from the new operation, following
  // renamed spreads back to their original definitions.
  const reverseRenames = new Map(
    [...renamedFragments].map(([from, to]) => [to, from]),
  );
  const newFragmentDefinitions: Array<FragmentDefinitionNode> = [];
  const reachedFragments = new Set<string>();
  const fragmentQueue: Array<string> = [];
  const enqueueSpreads = (selectionSet: SelectionSetNode): void => {
    for (const spreadName of collectSpreadNames(selectionSet)) {
      const originalName = reverseRenames.get(spreadName) ?? spreadName;
      if (!reachedFragments.has(originalName)) {
        reachedFragments.add(originalName);
        fragmentQueue.push(originalName);
      }
    }
  };
  enqueueSpreads(newOperation.selectionSet);
  for (const name of fragmentQueue) {
    const definition = fragmentDefinitions.get(name);
    if (definition === undefined) {
      continue; // Missing fragment, left as-is for validation to report.
    }
    if (affectedFragments.has(name)) {
      const transformed = transformFragmentDefinition(definition);
      const newName = renamedFragments.get(name);
      const finalDefinition =
        newName === undefined
          ? transformed
          : { ...transformed, name: renamedNameNode(newName) };
      newFragmentDefinitions.push(finalDefinition);
      enqueueSpreads(finalDefinition.selectionSet);
    } else {
      newFragmentDefinitions.push(definition);
      enqueueSpreads(definition.selectionSet);
    }
  }

  // Collect the fragment definitions to keep: the ones reachable from the
  // transformed operation plus the unmodified ones other operations need.
  const keptFragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of newFragmentDefinitions) {
    keptFragments.set(definition.name.value, definition);
  }
  for (const name of protectedFragments) {
    const definition = fragmentDefinitions.get(name);
    if (definition !== undefined && !keptFragments.has(name)) {
      keptFragments.set(name, definition);
    }
  }

  // Variable definitions which are no longer used are removed.
  const usedVariables = new Set<string>();
  const collectUsedVariables = (
    node: ASTNode,
    scopedVariables: ReadonlySet<string>,
  ): void => {
    visit(node, {
      [Kind.VARIABLE](variableNode) {
        if (!scopedVariables.has(variableNode.name.value)) {
          usedVariables.add(variableNode.name.value);
        }
      },
    });
  };
  const noScopedVariables: ReadonlySet<string> = new Set();
  collectUsedVariables(newOperation.selectionSet, noScopedVariables);
  for (const directive of newOperation.directives ?? []) {
    collectUsedVariables(directive, noScopedVariables);
  }
  for (const definition of newFragmentDefinitions) {
    const scopedVariables = new Set(
      definition.variableDefinitions?.map(
        (varDef) => varDef.variable.name.value,
      ) ?? [],
    );
    collectUsedVariables(definition.selectionSet, scopedVariables);
    for (const directive of definition.directives ?? []) {
      collectUsedVariables(directive, scopedVariables);
    }
  }
  const newVariableDefinitions = variableDefinitions.filter((varDef) =>
    usedVariables.has(varDef.variable.name.value),
  );
  const finalOperation: OperationDefinitionNode = {
    ...newOperation,
    variableDefinitions:
      newVariableDefinitions.length === 0 ? undefined : newVariableDefinitions,
  };

  // Assemble the new document, preserving the original definition order and
  // dropping fragment definitions which are no longer reachable.
  const newDefinitions = [];
  const emittedFragments = new Set<string>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      newDefinitions.push(
        definition === operation ? finalOperation : definition,
      );
    } else if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      const kept = keptFragments.get(definition.name.value);
      if (kept !== undefined) {
        newDefinitions.push(kept);
        emittedFragments.add(definition.name.value);
      }
    } else {
      newDefinitions.push(definition);
    }
  }
  // Renamed fragment copies have names not present in the original document.
  for (const [name, definition] of keptFragments) {
    if (!emittedFragments.has(name)) {
      newDefinitions.push(definition);
    }
  }

  return { ...document, definitions: newDefinitions };
}

function collectSpreadNames(selectionSet: SelectionSetNode): Set<string> {
  const names = new Set<string>();
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FRAGMENT_SPREAD) {
      names.add(selection.name.value);
    } else if (selection.selectionSet !== undefined) {
      for (const name of collectSpreadNames(selection.selectionSet)) {
        names.add(name);
      }
    }
  }
  return names;
}

function renamedNameNode(name: string): NameNode {
  return { kind: Kind.NAME, value: name };
}
