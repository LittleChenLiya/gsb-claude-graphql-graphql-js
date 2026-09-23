/** @category Execution */

import { inspect } from '../jsutils/inspect.ts';
import { invariant } from '../jsutils/invariant.ts';
import type { Maybe } from '../jsutils/Maybe.ts';
import type { ObjMap } from '../jsutils/ObjMap.ts';

import { GraphQLError } from '../error/GraphQLError.ts';

import type { DocumentNode, FieldNode } from '../language/ast.ts';
import { Kind } from '../language/kinds.ts';

import type {
  GraphQLField,
  GraphQLObjectType,
  GraphQLOutputType,
} from '../type/definition.ts';
import {
  getNamedType,
  isAbstractType,
  isCompositeType,
  isListType,
  isNonNullType,
} from '../type/definition.ts';
import type { GraphQLSchema } from '../type/schema.ts';

import { validate } from '../validation/validate.ts';

import { getOperationAST } from '../utilities/getOperationAST.ts';

import type {
  FieldDetailsList,
  FragmentDetails,
  GroupedFieldSet,
} from './collectFields.ts';
import { collectFields, collectSubfields } from './collectFields.ts';
import type { VariableValues } from './values.ts';
import { getArgumentValues, getVariableValues } from './values.ts';

/**
 * Configuration for estimating the item count of list fields.
 */
export interface QueryCostListConfig {
  /** Name of the integer argument used to estimate the list item count. */
  argumentName: string;
  /** Estimated item count used when the argument is not provided. */
  defaultLimit: number;
  /** Maximum allowed item count; larger or negative estimates are rejected. */
  maxLimit: number;
}

/**
 * Configuration used when estimating the cost of a GraphQL operation.
 */
export interface QueryCostConfig {
  /** Fixed cost charged per response field. Defaults to 1. */
  fieldCost?: number;
  /** List sizing configuration, required when the query selects list fields. */
  list?: QueryCostListConfig;
  /** Budget; diagnostics are reported when the estimate exceeds it. */
  maxCost?: number;
  /**
   * Maximum number of response fields expanded before estimation aborts.
   * Defaults to 1000.
   */
  maxFields?: number;
}

/**
 * Arguments accepted by {@link estimateQueryCost}.
 */
export interface QueryCostArgs {
  /** Schema to estimate against. */
  schema: GraphQLSchema;
  /** Parsed document containing the operation to estimate. */
  document: DocumentNode;
  /** Operation to estimate, required when the document has several. */
  operationName?: Maybe<string>;
  /** Runtime variable values keyed by variable name. */
  variableValues?: Maybe<{ readonly [variable: string]: unknown }>;
  /** Cost configuration. */
  costConfig?: Maybe<QueryCostConfig>;
}

/**
 * A node of the estimated cost tree, keyed by response path.
 */
export interface QueryCostNode {
  /** Response key (alias or field name) of this node. */
  responseKey: string;
  /** Dot-separated response path from the operation root. */
  path: string;
  /** Total estimated cost of this node, including its children. */
  cost: number;
  /** Child nodes in response order. */
  children: ReadonlyArray<QueryCostNode>;
}

/**
 * A diagnostic reported when the estimated cost exceeds the configured budget.
 */
export interface QueryCostDiagnostic {
  /** Response path at which the budget was exceeded. */
  path: string;
  /** Human-readable description of the budget violation. */
  message: string;
}

/**
 * The result of a successful query cost estimation.
 */
export interface QueryCostEstimate {
  /** Total estimated cost of the operation. */
  totalCost: number;
  /** Cost tree of the top-level response fields. */
  costTree: ReadonlyArray<QueryCostNode>;
  /** Budget diagnostics, empty when the estimate is within budget. */
  diagnostics: ReadonlyArray<QueryCostDiagnostic>;
}

/**
 * The result of {@link estimateQueryCost}: either an estimate or the
 * validation, variable coercion, or estimation errors that prevented it.
 */
export type QueryCostResult =
  | {
      /** The estimate, present when no errors prevented estimation. */
      estimate: QueryCostEstimate;
      /** Never present when estimation succeeded. */
      errors?: never;
    }
  | {
      /** The errors that prevented estimation. */
      errors: ReadonlyArray<GraphQLError>;
      /** Never present when errors prevented estimation. */
      estimate?: never;
    };

interface CostContext {
  schema: GraphQLSchema;
  fragments: ObjMap<FragmentDetails>;
  variableValues: VariableValues;
  fieldCost: number;
  list: QueryCostListConfig | undefined;
  maxFields: number;
  expandedFields: number;
}

/**
 * Estimates the cost of a GraphQL operation before execution.
 *
 * The document is first checked with the standard validation rules and the
 * provided variable values are coerced with the same algorithm used during
 * execution, so the estimate reflects the operation that would actually run.
 * No resolvers or other user code are executed.
 *
 * Each response field is charged a fixed cost. List fields additionally
 * multiply the cost of their sub-selection by an item count estimated from a
 * configured integer argument, falling back to an explicit default when the
 * argument is not provided; negative estimates or estimates above the
 * configured limit are rejected. Fields skipped via `skip` or
 * `include` are not charged, fragments are merged following the
 * response field merging rules (different aliases are charged separately),
 * and abstract types are charged the maximum cost over their reachable
 * concrete types.
 * @param args - The schema, document, operation, variables, and cost config.
 * @returns The estimate, or the errors that prevented estimation.
 * @example
 * ```ts
 * import { parse } from 'graphql/language';
 * import { buildSchema } from 'graphql/utilities';
 * import { estimateQueryCost } from 'graphql/execution';
 *
 * const schema = buildSchema(`
 *   type User {
 *     id: ID!
 *     name: String
 *   }
 *
 *   type Query {
 *     users(first: Int!): [User!]!
 *   }
 * `);
 *
 * const result = estimateQueryCost({
 *   schema,
 *   document: parse('{ users(first: 2) { id name } }'),
 *   costConfig: {
 *     list: { argumentName: 'first', defaultLimit: 10, maxLimit: 100 },
 *   },
 * });
 *
 * result.estimate?.totalCost; // => 5
 * ```
 */
export function estimateQueryCost(args: QueryCostArgs): QueryCostResult {
  const { schema, document, operationName, costConfig } = args;

  const validationErrors = validate(schema, document);
  if (validationErrors.length !== 0) {
    return { errors: validationErrors };
  }

  const operation = getOperationAST(document, operationName);
  if (operation == null) {
    return {
      errors: [
        new GraphQLError(
          operationName == null
            ? 'Must provide operation name if query contains multiple operations.'
            : `Unknown operation named "${operationName}".`,
        ),
      ],
    };
  }

  const coercedVariableValues = getVariableValues(
    schema,
    operation.variableDefinitions ?? [],
    args.variableValues ?? {},
  );
  if ('errors' in coercedVariableValues) {
    return { errors: coercedVariableValues.errors };
  }

  const rootType = schema.getRootType(operation.operation);
  invariant(rootType != null, 'Validation guarantees a root type.');

  const fragments: ObjMap<FragmentDetails> = Object.create(null);
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments[definition.name.value] = { definition };
    }
  }

  const context: CostContext = {
    schema,
    fragments,
    variableValues: coercedVariableValues.variableValues,
    fieldCost: costConfig?.fieldCost ?? 1,
    list: costConfig?.list,
    maxFields: costConfig?.maxFields ?? 1000,
    expandedFields: 0,
  };

  try {
    const { groupedFieldSet } = collectFields(
      schema,
      fragments,
      context.variableValues,
      rootType,
      operation.selectionSet,
      false,
    );
    const costTree = costOfGroupedFieldSet(
      context,
      rootType,
      groupedFieldSet,
      '',
    );
    const totalCost = sumCosts(costTree);
    const maxCost = costConfig?.maxCost;
    const diagnostics =
      maxCost != null && totalCost > maxCost
        ? collectBudgetDiagnostics(costTree, maxCost)
        : [];
    return { estimate: { totalCost, costTree, diagnostics } };
  } catch (error) {
    invariant(error instanceof GraphQLError, 'Only GraphQLError is thrown.');
    return { errors: [error] };
  }
}

function costOfGroupedFieldSet(
  context: CostContext,
  parentType: GraphQLObjectType,
  groupedFieldSet: GroupedFieldSet,
  parentPath: string,
): Array<QueryCostNode> {
  const nodes: Array<QueryCostNode> = [];
  for (const [responseKey, fieldDetailsList] of groupedFieldSet) {
    context.expandedFields += 1;
    if (context.expandedFields > context.maxFields) {
      throw new GraphQLError(
        `Query cost estimation aborted after expanding ${context.maxFields} fields; the operation is too large to estimate.`,
      );
    }

    const fieldNode = fieldDetailsList[0].node;
    const path =
      parentPath === '' ? responseKey : `${parentPath}.${responseKey}`;
    const fieldDef = context.schema.getField(parentType, fieldNode.name.value);
    invariant(fieldDef != null, 'Validation guarantees a field definition.');
    const namedType = getNamedType(fieldDef.type);

    let children: Array<QueryCostNode> = [];
    let childrenCost = 0;
    if (isCompositeType(namedType)) {
      if (isAbstractType(namedType)) {
        // Mutually exclusive concrete types are not added together; the
        // estimate uses the most expensive reachable type.
        for (const possibleType of context.schema.getPossibleTypes(namedType)) {
          const possibleChildren = costOfSubfields(
            context,
            possibleType,
            fieldDetailsList,
            path,
          );
          const possibleCost = sumCosts(possibleChildren);
          if (possibleCost >= childrenCost) {
            children = possibleChildren;
            childrenCost = possibleCost;
          }
        }
      } else {
        children = costOfSubfields(context, namedType, fieldDetailsList, path);
        childrenCost = sumCosts(children);
      }
    }

    let cost: number;
    if (isListOutputType(fieldDef.type)) {
      const itemCount = estimateListItemCount(context, fieldDef, fieldNode);
      cost = checkedAdd(
        context.fieldCost,
        checkedMultiply(itemCount, childrenCost),
      );
    } else {
      cost = checkedAdd(context.fieldCost, childrenCost);
    }
    nodes.push({ responseKey, path, cost, children });
  }
  return nodes;
}

function costOfSubfields(
  context: CostContext,
  returnType: GraphQLObjectType,
  fieldDetailsList: FieldDetailsList,
  path: string,
): Array<QueryCostNode> {
  const { groupedFieldSet } = collectSubfields(
    context.schema,
    context.fragments,
    context.variableValues,
    returnType,
    fieldDetailsList,
    false,
  );
  return costOfGroupedFieldSet(context, returnType, groupedFieldSet, path);
}

function estimateListItemCount(
  context: CostContext,
  fieldDef: GraphQLField<unknown, unknown>,
  fieldNode: FieldNode,
): number {
  const listConfig = context.list;
  if (listConfig == null) {
    throw new GraphQLError(
      `Cannot estimate the cost of list field "${fieldNode.name.value}" without a "list" cost configuration.`,
    );
  }

  const argumentValues = getArgumentValues(
    fieldDef,
    fieldNode,
    context.variableValues,
  );
  const value = argumentValues[listConfig.argumentName];
  if (value === undefined) {
    return listConfig.defaultLimit;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > listConfig.maxLimit
  ) {
    throw new GraphQLError(
      `List size argument "${listConfig.argumentName}" of field "${
        fieldNode.name.value
      }" must be an integer between 0 and ${
        listConfig.maxLimit
      }, got: ${inspect(value)}.`,
    );
  }
  return value;
}

function isListOutputType(type: GraphQLOutputType): boolean {
  if (isNonNullType(type)) {
    return isListOutputType(type.ofType);
  }
  return isListType(type);
}

function sumCosts(nodes: ReadonlyArray<QueryCostNode>): number {
  let total = 0;
  for (const node of nodes) {
    total = checkedAdd(total, node.cost);
  }
  return total;
}

function checkedAdd(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result)) {
    throw new GraphQLError(
      'Query cost estimation overflowed the maximum safe integer; the operation is too expensive to estimate.',
    );
  }
  return result;
}

function checkedMultiply(a: number, b: number): number {
  const result = a * b;
  if (!Number.isSafeInteger(result)) {
    throw new GraphQLError(
      'Query cost estimation overflowed the maximum safe integer; the operation is too expensive to estimate.',
    );
  }
  return result;
}

function collectBudgetDiagnostics(
  costTree: ReadonlyArray<QueryCostNode>,
  maxCost: number,
): Array<QueryCostDiagnostic> {
  const diagnostics: Array<QueryCostDiagnostic> = [];
  accumulateBudgetDiagnostics(costTree, maxCost, 0, diagnostics);
  return diagnostics;
}

function accumulateBudgetDiagnostics(
  nodes: ReadonlyArray<QueryCostNode>,
  maxCost: number,
  cumulative: number,
  diagnostics: Array<QueryCostDiagnostic>,
): number {
  let running = cumulative;
  for (const node of nodes) {
    let selfCost = node.cost;
    for (const child of node.children) {
      selfCost -= child.cost;
    }
    running += selfCost;
    if (running > maxCost) {
      diagnostics.push({
        path: node.path,
        message: `Estimated query cost exceeds the budget of ${maxCost} at path "${node.path}".`,
      });
      return running;
    }
    const next = accumulateBudgetDiagnostics(
      node.children,
      maxCost,
      running,
      diagnostics,
    );
    if (diagnostics.length !== 0) {
      return next;
    }
    running = next;
  }
  return running;
}
