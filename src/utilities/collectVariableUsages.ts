/** @category Operations */

import type { ObjMap } from '../jsutils/ObjMap.ts';

import { GraphQLError } from '../error/GraphQLError.ts';

import type {
  DirectiveNode,
  DocumentNode,
  FragmentDefinitionNode,
  SelectionSetNode,
  ValueNode,
} from '../language/ast.ts';
import { Kind } from '../language/kinds.ts';
import { print } from '../language/printer.ts';

import { getOperationAST } from './getOperationAST.ts';

/**
 * Describes a variable definition declared by the selected operation.
 */
export interface VariableDefinitionInfo {
  /** Variable name without the leading `$`. */
  readonly name: string;
  /** Printed type reference, for example `ID!` or `[String]`. */
  readonly type: string;
  /** Whether the definition declares a default value. */
  readonly hasDefaultValue: boolean;
}

/**
 * A location where a variable is referenced by a field argument.
 */
export interface VariableArgumentUsage {
  /** Discriminator for field argument usages. */
  readonly kind: 'argument';
  /**
   * Response path of field response names (aliases when present) from the
   * operation root to the field carrying the argument. Fragment spreads and
   * inline fragments do not add path segments, so the same fragment reached
   * from two fields produces one usage per response path.
   */
  readonly path: ReadonlyArray<string>;
  /** Field name as defined in the schema (aliases are reported via `path`). */
  readonly fieldName: string;
  /** Name of the argument whose value references the variable. */
  readonly argumentName: string;
}

/**
 * A location where a variable is referenced by a directive argument.
 */
export interface VariableDirectiveUsage {
  /** Discriminator for directive usages. */
  readonly kind: 'directive';
  /**
   * Response path of field response names (aliases when present) from the
   * operation root to the node carrying the directive. Directives applied to
   * the operation itself report an empty path.
   */
  readonly path: ReadonlyArray<string>;
  /** Name of the applied directive. */
  readonly directiveName: string;
  /** Name of the directive argument whose value references the variable. */
  readonly argumentName: string;
  /** The kind of node the directive is applied to. */
  readonly appliedTo:
    | 'operation'
    | 'field'
    | 'fragmentSpread'
    | 'inlineFragment';
}

/**
 * A location where a variable is referenced within the selected operation,
 * either by a field argument or by a directive argument.
 */
export type VariableUsageLocation =
  | VariableArgumentUsage
  | VariableDirectiveUsage;

/**
 * The read-only report produced by `collectVariableUsages`.
 */
export interface VariableUsagesReport {
  /** Name of the selected operation, or undefined when it is anonymous. */
  readonly operationName: string | undefined;
  /** Variable definitions declared by the selected operation, in order. */
  readonly variableDefinitions: ReadonlyArray<VariableDefinitionInfo>;
  /**
   * Usage locations grouped by variable name. Every declared variable is
   * present, even when unused; variables referenced but not declared are
   * appended after the declared ones.
   */
  readonly usages: ReadonlyMap<string, ReadonlyArray<VariableUsageLocation>>;
}

/**
 * Collects, for a single operation of a document, every reference to each
 * variable within field arguments and directive arguments, together with the
 * response field path of each reference.
 *
 * This is a read-only AST analysis: it walks the selected operation and every
 * fragment reachable from it without calling resolvers, coercing values, or
 * requiring a schema. Only the selected operation contributes to the report;
 * other operations in the document are ignored. Because only AST nodes are
 * inspected, a `$` character inside a string literal is never mistaken for a
 * variable.
 *
 * The same fragment reached through two different fields is traversed once
 * per response path, so usages inside it are reported for each path. A
 * fragment cycle along the traversal stack, or a spread of a fragment that
 * does not exist in the document, is reported by throwing a `GraphQLError`
 * with a distinct message instead of silently producing an empty report.
 * @param document - The parsed GraphQL document AST.
 * @param operationName - The operation to analyze. May be omitted only when
 * the document contains exactly one operation.
 * @returns The variable usage report for the selected operation.
 * @example
 * ```ts
 * import { parse } from 'graphql/language';
 * import { collectVariableUsages } from 'graphql/utilities';
 *
 * const document = parse(`
 *   query Q($id: ID!) {
 *     a: user(id: $id) { ...F }
 *     b: user(id: $id) { ...F }
 *   }
 *   fragment F on User { name(format: $format) }
 * `);
 *
 * const report = collectVariableUsages(document, 'Q');
 * report.usages.get('id'); // usages at paths ['a'] and ['b']
 * report.usages.get('format'); // usages at paths ['a', 'name'] and ['b', 'name']
 * ```
 */
export function collectVariableUsages(
  document: DocumentNode,
  operationName?: string,
): VariableUsagesReport {
  const operation = getOperationAST(document, operationName);
  if (operation == null) {
    throw new GraphQLError(
      operationName == null
        ? 'Must provide an operation name when the document does not contain a single operation.'
        : `Unknown operation named "${operationName}".`,
    );
  }

  const fragments: ObjMap<FragmentDefinitionNode> = Object.create(null);
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments[definition.name.value] = definition;
    }
  }

  const usages = new Map<string, Array<VariableUsageLocation>>();
  const variableDefinitions = (operation.variableDefinitions ?? []).map(
    (definition) => {
      const name = definition.variable.name.value;
      usages.set(name, []);
      return {
        name,
        type: print(definition.type),
        hasDefaultValue: definition.defaultValue !== undefined,
      };
    },
  );

  collectDirectiveUsages(operation.directives ?? [], [], 'operation', usages);
  collectSelectionSetUsages(operation.selectionSet, [], [], fragments, usages);

  return {
    operationName: operation.name?.value,
    variableDefinitions,
    usages,
  };
}

function collectSelectionSetUsages(
  selectionSet: SelectionSetNode,
  path: ReadonlyArray<string>,
  fragmentStack: ReadonlyArray<string>,
  fragments: ObjMap<FragmentDefinitionNode>,
  usages: Map<string, Array<VariableUsageLocation>>,
): void {
  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD: {
        const fieldPath = [
          ...path,
          selection.alias?.value ?? selection.name.value,
        ];
        for (const argument of selection.arguments ?? []) {
          collectValueUsages(argument.value, (variableName) =>
            addUsage(usages, variableName, {
              kind: 'argument',
              path: fieldPath,
              fieldName: selection.name.value,
              argumentName: argument.name.value,
            }),
          );
        }
        collectDirectiveUsages(
          selection.directives ?? [],
          fieldPath,
          'field',
          usages,
        );
        if (selection.selectionSet !== undefined) {
          collectSelectionSetUsages(
            selection.selectionSet,
            fieldPath,
            fragmentStack,
            fragments,
            usages,
          );
        }
        break;
      }
      case Kind.INLINE_FRAGMENT: {
        collectDirectiveUsages(
          selection.directives ?? [],
          path,
          'inlineFragment',
          usages,
        );
        collectSelectionSetUsages(
          selection.selectionSet,
          path,
          fragmentStack,
          fragments,
          usages,
        );
        break;
      }
      case Kind.FRAGMENT_SPREAD: {
        const fragmentName = selection.name.value;
        collectDirectiveUsages(
          selection.directives ?? [],
          path,
          'fragmentSpread',
          usages,
        );
        const fragment = fragments[fragmentName];
        if (fragment === undefined) {
          throw new GraphQLError(`Unknown fragment "${fragmentName}".`, {
            nodes: selection,
          });
        }
        const cycleStart = fragmentStack.indexOf(fragmentName);
        if (cycleStart !== -1) {
          const cycle = [...fragmentStack.slice(cycleStart), fragmentName].join(
            ' -> ',
          );
          throw new GraphQLError(`Fragment cycle detected: ${cycle}.`, {
            nodes: selection,
          });
        }
        collectSelectionSetUsages(
          fragment.selectionSet,
          path,
          [...fragmentStack, fragmentName],
          fragments,
          usages,
        );
        break;
      }
    }
  }
}

function collectDirectiveUsages(
  directives: ReadonlyArray<DirectiveNode>,
  path: ReadonlyArray<string>,
  appliedTo: VariableDirectiveUsage['appliedTo'],
  usages: Map<string, Array<VariableUsageLocation>>,
): void {
  for (const directive of directives) {
    for (const argument of directive.arguments ?? []) {
      collectValueUsages(argument.value, (variableName) =>
        addUsage(usages, variableName, {
          kind: 'directive',
          path,
          directiveName: directive.name.value,
          argumentName: argument.name.value,
          appliedTo,
        }),
      );
    }
  }
}

function collectValueUsages(
  value: ValueNode,
  onVariable: (variableName: string) => void,
): void {
  switch (value.kind) {
    case Kind.VARIABLE:
      onVariable(value.name.value);
      break;
    case Kind.LIST:
      for (const item of value.values) {
        collectValueUsages(item, onVariable);
      }
      break;
    case Kind.OBJECT:
      for (const field of value.fields) {
        collectValueUsages(field.value, onVariable);
      }
      break;
    default:
      // Int, float, string, boolean, null and enum values never reference
      // variables; in particular a `$` inside a string literal is ignored.
      break;
  }
}

function addUsage(
  usages: Map<string, Array<VariableUsageLocation>>,
  variableName: string,
  location: VariableUsageLocation,
): void {
  const locations = usages.get(variableName);
  if (locations === undefined) {
    usages.set(variableName, [location]);
  } else {
    locations.push(location);
  }
}
