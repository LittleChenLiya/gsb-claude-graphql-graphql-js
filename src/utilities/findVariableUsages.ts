/** @category AST Utilities */

import type { Maybe } from '../jsutils/Maybe.ts';

import { GraphQLError } from '../error/GraphQLError.ts';

import type {
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  FragmentSpreadNode,
  InlineFragmentNode,
  OperationDefinitionNode,
  SelectionSetNode,
  ValueNode,
  VariableDefinitionNode,
} from '../language/ast.ts';
import { Kind } from '../language/kinds.ts';

/**
 * The kind of argument that references a variable within a selected operation.
 */
export type VariableUsageLocationKind =
  | 'field-argument'
  | 'directive-argument'
  | 'fragment-argument';

/**
 * Describes where within a selected operation a variable is referenced.
 */
export interface VariableUsageLocation {
  /**
   * The response path from the operation root to the selection containing
   * the reference. A variable used inside the field aliased `a` is reported
   * with `['a']`; a variable used inside a fragment spread reached from that
   * field keeps the same path. When the same fragment is reached from two
   * fields, two locations with the two response paths are reported.
   */
  readonly path: ReadonlyArray<string>;
  /** The kind of argument that references the variable. */
  readonly kind: VariableUsageLocationKind;
  /**
   * The response key (alias or field name) of the enclosing field, or
   * `undefined` when the reference is made at the operation root, for
   * example by an operation directive.
   */
  readonly field: string | undefined;
  /** The name of the argument that references the variable. */
  readonly argument: string;
  /** The name of the directive, set when `kind` is `'directive-argument'`. */
  readonly directive?: string;
  /**
   * The name of the fragment spread, set when `kind` is
   * `'fragment-argument'`.
   */
  readonly fragmentSpread?: string;
}

/**
 * A single variable definition together with every reachable reference to it.
 */
export interface VariableUsage {
  /** The variable name, without the leading `$`. */
  readonly name: string;
  /** The variable definition declared by the operation, if one exists. */
  readonly definition: VariableDefinitionNode | undefined;
  /** All references to the variable reachable from the operation. */
  readonly locations: ReadonlyArray<VariableUsageLocation>;
}

/**
 * The result of analyzing a single operation: its variable definitions and
 * every reachable variable reference, annotated with response field paths.
 */
export interface VariableUsagesReport {
  /** The selected operation that was analyzed. */
  readonly operation: OperationDefinitionNode;
  /**
   * Variable definitions and their reachable references. Defined variables
   * are listed in definition order, followed by variables that are
   * referenced but not defined by the operation.
   */
  readonly variables: ReadonlyArray<VariableUsage>;
}

interface MutableVariableUsage {
  definition: VariableDefinitionNode | undefined;
  locations: Array<VariableUsageLocation>;
}

interface TraversalContext {
  usages: Map<string, MutableVariableUsage>;
  fragments: ReadonlyMap<string, FragmentDefinitionNode>;
  activeFragments: Set<string>;
  activeFragmentChain: ReadonlyArray<string>;
}

/**
 * Reports, for a selected operation, where each variable is defined and
 * referenced. This is a read-only AST utility: it traverses the operation and
 * every fragment reachable from it without executing the operation or calling
 * any resolver. Each reference is annotated with the response field path at
 * which it occurs, so a fragment reached from two fields produces two
 * locations with the two response paths instead of being skipped as already
 * visited.
 *
 * Only the selected operation is analyzed: variables defined or referenced by
 * other operations in the document are ignored. A fragment spread that cannot
 * be resolved or that forms a cycle with the fragments expanded on the current
 * response path is reported as an error rather than silently producing an
 * empty report. Literal `$` characters inside string values are not variable
 * references and are not reported.
 * @param documentAST - The parsed GraphQL document AST.
 * @param operation - The operation name, an operation AST node, or `null`/
 * `undefined` to select the only operation in the document.
 * @returns A report describing every variable definition and its reachable
 * references for the selected operation.
 * @example
 * ```ts
 * import { parse } from 'graphql/language';
 * import { findVariableUsages } from 'graphql/utilities';
 *
 * const document = parse(`
 *   query GetUser($id: ID!) {
 *     user(id: $id) {
 *       ...UserFields
 *     }
 *   }
 *
 *   fragment UserFields on User {
 *     name
 *   }
 * `);
 *
 * const report = findVariableUsages(document, 'GetUser');
 *
 * report.variables[0].name; // => 'id'
 * report.variables[0].locations;
 * // => [{ path: ['user'], kind: 'field-argument', field: 'user', argument: 'id' }]
 * ```
 */
export function findVariableUsages(
  documentAST: DocumentNode,
  operation?: Maybe<string | OperationDefinitionNode>,
): VariableUsagesReport {
  const operationNode = getSelectedOperation(documentAST, operation);
  const fragments = collectFragmentDefinitions(documentAST);

  const usages = new Map<string, MutableVariableUsage>();
  const context: TraversalContext = {
    usages,
    fragments,
    activeFragments: new Set<string>(),
    activeFragmentChain: [],
  };

  // Directives applied to the operation itself may reference variables even
  // though no field has been entered yet.
  for (const directive of operationNode.directives ?? []) {
    for (const argument of directive.arguments ?? []) {
      collectValueVariables(
        argument.value,
        {
          path: [],
          kind: 'directive-argument',
          field: undefined,
          argument: argument.name.value,
          directive: directive.name.value,
        },
        usages,
      );
    }
  }

  walkSelectionSet(operationNode.selectionSet, [], undefined, context);

  return buildReport(operationNode, usages);
}

function getSelectedOperation(
  documentAST: DocumentNode,
  operation: Maybe<string | OperationDefinitionNode>,
): OperationDefinitionNode {
  if (operation !== null && typeof operation === 'object') {
    return operation;
  }

  const operations: Array<OperationDefinitionNode> = [];
  for (const definition of documentAST.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      operations.push(definition);
    }
  }

  if (typeof operation === 'string') {
    const matched = operations.find(
      (candidate) => candidate.name?.value === operation,
    );
    if (matched === undefined) {
      throw new GraphQLError(`Unknown operation named "${operation}".`);
    }
    return matched;
  }

  if (operations.length === 0) {
    throw new GraphQLError('No operation found in document.');
  }
  if (operations.length > 1) {
    throw new GraphQLError(
      'Must provide operation name if query contains multiple operations.',
    );
  }
  return operations[0];
}

function collectFragmentDefinitions(
  documentAST: DocumentNode,
): ReadonlyMap<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of documentAST.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }
  return fragments;
}

function walkSelectionSet(
  selectionSet: SelectionSetNode,
  path: ReadonlyArray<string>,
  enclosingField: string | undefined,
  context: TraversalContext,
): void {
  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD:
        walkField(selection, path, context);
        break;
      case Kind.FRAGMENT_SPREAD:
        walkFragmentSpread(selection, path, enclosingField, context);
        break;
      case Kind.INLINE_FRAGMENT:
        walkInlineFragment(selection, path, enclosingField, context);
        break;
    }
  }
}

function walkField(
  field: FieldNode,
  path: ReadonlyArray<string>,
  context: TraversalContext,
): void {
  const responseKey = field.alias?.value ?? field.name.value;
  const fieldPath = [...path, responseKey];

  for (const argument of field.arguments ?? []) {
    collectValueVariables(
      argument.value,
      {
        path: fieldPath,
        kind: 'field-argument',
        field: responseKey,
        argument: argument.name.value,
      },
      context.usages,
    );
  }

  for (const directive of field.directives ?? []) {
    for (const argument of directive.arguments ?? []) {
      collectValueVariables(
        argument.value,
        {
          path: fieldPath,
          kind: 'directive-argument',
          field: responseKey,
          argument: argument.name.value,
          directive: directive.name.value,
        },
        context.usages,
      );
    }
  }

  if (field.selectionSet !== undefined) {
    walkSelectionSet(field.selectionSet, fieldPath, responseKey, context);
  }
}

function walkFragmentSpread(
  spread: FragmentSpreadNode,
  path: ReadonlyArray<string>,
  enclosingField: string | undefined,
  context: TraversalContext,
): void {
  const spreadName = spread.name.value;

  if (context.activeFragments.has(spreadName)) {
    const cycleIndex = context.activeFragmentChain.indexOf(spreadName);
    const viaPath = context.activeFragmentChain.slice(cycleIndex + 1);
    throw new GraphQLError(
      `Cannot spread fragment "${spreadName}" within itself` +
        (viaPath.length > 0
          ? ` via ${viaPath.map((name) => `"${name}"`).join(', ')}.`
          : '.'),
      { nodes: spread },
    );
  }

  const fragment = context.fragments.get(spreadName);
  if (fragment === undefined) {
    throw new GraphQLError(`Unknown fragment "${spreadName}".`, {
      nodes: spread,
    });
  }

  for (const argument of spread.arguments ?? []) {
    collectValueVariables(
      argument.value,
      {
        path,
        kind: 'fragment-argument',
        field: enclosingField,
        argument: argument.name.value,
        fragmentSpread: spreadName,
      },
      context.usages,
    );
  }

  for (const directive of spread.directives ?? []) {
    for (const argument of directive.arguments ?? []) {
      collectValueVariables(
        argument.value,
        {
          path,
          kind: 'directive-argument',
          field: enclosingField,
          argument: argument.name.value,
          directive: directive.name.value,
        },
        context.usages,
      );
    }
  }

  context.activeFragments.add(spreadName);
  walkSelectionSet(fragment.selectionSet, path, enclosingField, {
    ...context,
    activeFragmentChain: [...context.activeFragmentChain, spreadName],
  });
  context.activeFragments.delete(spreadName);
}

function walkInlineFragment(
  inlineFragment: InlineFragmentNode,
  path: ReadonlyArray<string>,
  enclosingField: string | undefined,
  context: TraversalContext,
): void {
  for (const directive of inlineFragment.directives ?? []) {
    for (const argument of directive.arguments ?? []) {
      collectValueVariables(
        argument.value,
        {
          path,
          kind: 'directive-argument',
          field: enclosingField,
          argument: argument.name.value,
          directive: directive.name.value,
        },
        context.usages,
      );
    }
  }

  walkSelectionSet(inlineFragment.selectionSet, path, enclosingField, context);
}

function collectValueVariables(
  value: ValueNode,
  location: VariableUsageLocation,
  usages: Map<string, MutableVariableUsage>,
): void {
  switch (value.kind) {
    case Kind.VARIABLE:
      recordVariableUsage(usages, value.name.value, location);
      break;
    case Kind.LIST:
      for (const item of value.values) {
        collectValueVariables(item, location, usages);
      }
      break;
    case Kind.OBJECT:
      for (const objectField of value.fields) {
        collectValueVariables(objectField.value, location, usages);
      }
      break;
    default:
      // IntValueNode, FloatValueNode, StringValueNode, BooleanValueNode,
      // NullValueNode, EnumValueNode: literal values never reference
      // variables, so a `$` character inside a string is not reported.
      break;
  }
}

function recordVariableUsage(
  usages: Map<string, MutableVariableUsage>,
  name: string,
  location: VariableUsageLocation,
): void {
  let usage = usages.get(name);
  if (usage === undefined) {
    usage = { definition: undefined, locations: [] };
    usages.set(name, usage);
  }
  usage.locations.push(location);
}

function buildReport(
  operation: OperationDefinitionNode,
  usages: Map<string, MutableVariableUsage>,
): VariableUsagesReport {
  const variables: Array<VariableUsage> = [];
  const definedNames = new Set<string>();

  for (const definition of operation.variableDefinitions ?? []) {
    const name = definition.variable.name.value;
    definedNames.add(name);
    const usage = usages.get(name);
    variables.push({
      name,
      definition,
      locations: usage?.locations ?? [],
    });
  }

  for (const [name, usage] of usages) {
    if (!definedNames.has(name)) {
      variables.push({
        name,
        definition: undefined,
        locations: usage.locations,
      });
    }
  }

  return { operation, variables };
}
