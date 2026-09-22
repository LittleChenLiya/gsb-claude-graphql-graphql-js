/** @category Validation */

import type { Maybe } from '../jsutils/Maybe.ts';
import type { ObjMap } from '../jsutils/ObjMap.ts';

import { GraphQLError } from '../error/GraphQLError.ts';

import type { DocumentNode, OperationDefinitionNode } from '../language/ast.ts';
import { Kind } from '../language/kinds.ts';

import type { GraphQLField, GraphQLObjectType } from '../type/definition.ts';
import {
  getNamedType,
  isAbstractType,
  isListType,
  isNonNullType,
} from '../type/definition.ts';
import type { GraphQLSchema } from '../type/schema.ts';
import { assertValidSchema } from '../type/validate.ts';

import type {
  FieldDetailsList,
  FragmentDetails,
} from '../execution/collectFields.ts';
import { collectFields, collectSubfields } from '../execution/collectFields.ts';
import { getVariableSignature } from '../execution/getVariableSignature.ts';
import type { VariableValues } from '../execution/values.ts';
import { getVariableValues } from '../execution/values.ts';

import {
  coerceDefaultValue,
  coerceInputLiteral,
} from '../utilities/coerceInputValue.ts';

import { validate } from './validate.ts';

/**
 * Configuration describing how a list field's number of items is estimated.
 * @category Validation
 */
export interface ListCostConfig {
  /** Name of the integer argument providing the requested item count. */
  argument: string;
  /** Upper bound assumed when the argument (or its default) is not provided. */
  defaultCount: number;
  /** Maximum allowed argument value; larger values are rejected. */
  maxCount: number;
}

/**
 * Per-field cost rules, keyed by schema coordinates such as `"Query.users"`.
 * @category Validation
 */
export type FieldCostConfig =
  | number
  | {
      /** Fixed cost charged per response occurrence of the field. */
      cost?: number;
      /** List sizing rules; the subtree cost is multiplied by the count. */
      list?: ListCostConfig;
    };

/**
 * Configuration for static query cost analysis.
 * @category Validation
 */
export interface QueryCostConfig {
  /** Cost charged for each field without a field-specific cost. */
  defaultFieldCost?: number;
  /** Total cost budget; operations above it are reported over budget. */
  budget?: number;

  /**
   * Upper bound on the estimated number of response field instances produced
   * while expanding the cost tree. Protects against pathological queries.
   * @defaultValue 100_000
   */
  maxExpansion?: number;
  /** Per-field rules keyed by `"TypeName.fieldName"`. */
  fields?: { readonly [coordinate: string]: FieldCostConfig };
}

/**
 * A node of the response-shaped cost tree.
 * @category Validation
 */
export interface QueryCostNode {
  /** Response key: the field alias when present, otherwise the field name. */
  readonly key: string;
  /** Field name as declared in the schema. */
  readonly field: string;
  /** Named return type of the field. */
  readonly type: string;
  /** Fixed cost charged for each response occurrence of this field. */
  readonly fixedCost: number;
  /** Number of response occurrences of this field, including enclosing lists. */
  readonly multiplicity: number;
  /** Estimated item count when this is a configured list field. */
  readonly listCount?: number;
  /** Total cost of this node, including every repeated descendant subtree. */
  readonly cost: number;
  /** Concrete type evaluated for an abstract field's worst case. */
  readonly concreteType?: string;
  /** Costs of the selected child fields for one response element. */
  readonly children?: ReadonlyArray<QueryCostNode>;
}

/**
 * Successful result of {@link analyzeQueryCost}.
 * @category Validation
 */
export interface QueryCostResult {
  /** Sum of all estimated field costs. */
  readonly totalCost: number;
  /** Configured budget, when provided. */
  readonly budget?: number;
  /** Whether `totalCost` is at most `budget`. */
  readonly withinBudget: boolean;
  /** Response-shaped cost tree; one entry per root field response key. */
  readonly costTree: ReadonlyArray<QueryCostNode>;
  /** First response path whose accumulation crosses the budget. */
  readonly overBudgetPath?: ReadonlyArray<string | number>;
}

/**
 * Failed result of {@link analyzeQueryCost}.
 * @category Validation
 */
export interface QueryCostErrorResult {
  /** Validation, variable coercion, or estimation errors. */
  readonly errors: ReadonlyArray<GraphQLError>;
}

interface ResolvedFieldConfig {
  readonly fixedCost: number;
  readonly list?: ListCostConfig;
}

interface AnalysisContext {
  readonly schema: GraphQLSchema;
  readonly fragments: ObjMap<FragmentDetails>;
  readonly variableValues: VariableValues;
  readonly defaultFieldCost: number;
  readonly maxExpansion: number;
  readonly fieldConfigs: ReadonlyMap<string, ResolvedFieldConfig>;
  expansionCount: number;
}

const DEFAULT_MAX_EXPANSION = 100_000;

function invalidConfig(message: string): never {
  throw new Error(`Invalid query cost configuration: ${message}`);
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalidConfig(`${name} must be a non-negative safe integer`);
  }
}

function checkedAdd(a: number, b: number): number {
  const result = a + b;
  if (result > Number.MAX_SAFE_INTEGER) {
    throw new GraphQLError(
      'Query cost is too large to estimate (arithmetic overflow).',
    );
  }
  return result;
}

function checkedMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) {
    return 0;
  }
  if (Math.abs(a) > Number.MAX_SAFE_INTEGER / Math.abs(b)) {
    throw new GraphQLError(
      'Query cost is too large to estimate (arithmetic overflow).',
    );
  }
  return a * b;
}

/**
 * Estimates the cost of a query without executing it.
 *
 * The document first passes the standard validation rules, then operation
 * variables and field/directive arguments are coerced with the same logic as
 * execution. No field resolvers, type resolvers, or other business code run:
 * fields returning interface or union types are bounded by the maximum cost
 * across all possible concrete types, never by summing exclusive types.
 *
 * Every selected field is charged a fixed cost per response occurrence. A
 * list field with a {@link ListCostConfig} estimates its item count from an
 * integer argument, defaults to an explicit upper bound when omitted, and is
 * rejected when the value is negative or above the bound. Its subtree cost is
 * multiplied by the estimated count.
 * The configured argument sizes the field's nearest list; nested list
 * wrappers are not multiplied independently.
 *
 * `@skip`/`@include` are evaluated against the coerced boolean values, so
 * skipped branches are not billed. Fragment spreads follow the response field
 * merging rules, while distinct aliases are always billed independently.
 * The configuration is local to this call and never changes `validate` or
 * `execute` behavior.
 * @param schema - Schema to analyze against.
 * @param document - Executable document containing the operation.
 * @param operationName - Operation to analyze; required with multiple operations.
 * @param variableValues - Raw operation variable values, before coercion.
 * @param config - Cost rules and optional budget.
 * @returns The cost tree and budget verdict, or validation/coercion errors.
 * @example
 * ```ts
 * import { parse } from 'graphql/language';
 * import { buildSchema } from 'graphql/utilities';
 * import { analyzeQueryCost } from 'graphql/validation';
 *
 * const schema = buildSchema(`
 *   type User { id: ID name: String }
 *   type Query { users(first: Int!): [User] }
 * `);
 *
 * const result = analyzeQueryCost(
 *   schema,
 *   parse('{ users(first: 2) { id name } }'),
 * );
 * // result.totalCost === 5
 * ```
 * @category Validation
 */
export function analyzeQueryCost(
  schema: GraphQLSchema,
  document: DocumentNode,
  operationName?: Maybe<string>,
  variableValues?: Maybe<{ readonly [variable: string]: unknown }>,
  config: QueryCostConfig = {},
): QueryCostResult | QueryCostErrorResult {
  assertValidSchema(schema);

  const defaultFieldCost = config.defaultFieldCost ?? 1;
  const maxExpansion = config.maxExpansion ?? DEFAULT_MAX_EXPANSION;
  assertNonNegativeSafeInteger(defaultFieldCost, 'defaultFieldCost');
  assertNonNegativeSafeInteger(maxExpansion, 'maxExpansion');
  if (config.budget !== undefined) {
    assertNonNegativeSafeInteger(config.budget, 'budget');
  }

  const fieldConfigs = new Map<string, ResolvedFieldConfig>();
  for (const [coordinate, fieldConfig] of Object.entries(config.fields ?? {})) {
    const fixedCost =
      typeof fieldConfig === 'number'
        ? fieldConfig
        : (fieldConfig.cost ?? defaultFieldCost);
    assertNonNegativeSafeInteger(fixedCost, `field cost for "${coordinate}"`);
    const list = typeof fieldConfig === 'number' ? undefined : fieldConfig.list;
    if (list) {
      assertNonNegativeSafeInteger(list.defaultCount, 'defaultCount');
      assertNonNegativeSafeInteger(list.maxCount, 'maxCount');
      if (list.maxCount < list.defaultCount) {
        invalidConfig(
          `list "${coordinate}" requires maxCount to be at least defaultCount`,
        );
      }
    }
    fieldConfigs.set(coordinate, list ? { fixedCost, list } : { fixedCost });
  }

  const validationErrors = validate(schema, document);
  if (validationErrors.length > 0) {
    return { errors: validationErrors };
  }

  let operation: OperationDefinitionNode | undefined;
  const fragments: ObjMap<FragmentDetails> = Object.create(null);
  const fragmentErrors: Array<GraphQLError> = [];
  for (const definition of document.definitions) {
    switch (definition.kind) {
      case Kind.OPERATION_DEFINITION:
        if (operationName == null) {
          if (operation !== undefined) {
            return {
              errors: [
                new GraphQLError(
                  'Must provide operation name if query contains multiple operations.',
                ),
              ],
            };
          }
          operation = definition;
        } else if (definition.name?.value === operationName) {
          operation = definition;
        }
        break;
      case Kind.FRAGMENT_DEFINITION: {
        let variableSignatures;
        if (definition.variableDefinitions) {
          variableSignatures = Object.create(null);
          for (const varDef of definition.variableDefinitions) {
            const signature = getVariableSignature(schema, varDef);
            if (signature instanceof GraphQLError) {
              fragmentErrors.push(signature);
              continue;
            }
            variableSignatures[signature.name] = signature;
          }
        }
        fragments[definition.name.value] = { definition, variableSignatures };
        break;
      }
      default:
      // Ignore non-executable definitions.
    }
  }

  if (fragmentErrors.length > 0) {
    return { errors: fragmentErrors };
  }
  if (!operation) {
    return {
      errors: [
        new GraphQLError(
          operationName != null
            ? `Unknown operation named "${operationName}".`
            : 'Must provide an operation.',
        ),
      ],
    };
  }

  const variablesOrErrors = getVariableValues(
    schema,
    operation.variableDefinitions ?? [],
    variableValues ?? {},
  );
  if (variablesOrErrors.errors) {
    return { errors: variablesOrErrors.errors };
  }

  const rootType = getRootType(schema, operation.operation);
  if (rootType == null) {
    return {
      errors: [
        new GraphQLError(
          `Schema does not support "${operation.operation}" operations.`,
          { nodes: operation },
        ),
      ],
    };
  }

  const context: AnalysisContext = {
    schema,
    fragments,
    variableValues: variablesOrErrors.variableValues,
    defaultFieldCost,
    maxExpansion,
    fieldConfigs,
    expansionCount: 0,
  };

  let costTree: ReadonlyArray<QueryCostNode>;
  try {
    const { groupedFieldSet } = collectFields(
      schema,
      fragments,
      context.variableValues,
      rootType,
      operation.selectionSet,
      false,
    );
    costTree = evaluateFields(context, rootType, groupedFieldSet, 1);
  } catch (error) {
    if (error instanceof GraphQLError) {
      return { errors: [error] };
    }
    throw error;
  }

  const totalCost = costTree.reduce(
    (total, node) => checkedAdd(total, node.cost),
    0,
  );
  const budget = config.budget;
  const withinBudget = budget === undefined || totalCost <= budget;
  const result: {
    totalCost: number;
    budget?: number;
    withinBudget: boolean;
    costTree: ReadonlyArray<QueryCostNode>;
    overBudgetPath?: ReadonlyArray<string | number>;
  } = {
    totalCost,
    withinBudget,
    costTree,
  };
  if (budget !== undefined) {
    result.budget = budget;
    if (!withinBudget) {
      const overBudgetPath = findOverBudgetPath(costTree, budget);
      if (overBudgetPath) {
        result.overBudgetPath = overBudgetPath;
      }
    }
  }
  return result;
}

function getRootType(
  schema: GraphQLSchema,
  operation: string,
): Maybe<GraphQLObjectType> {
  switch (operation) {
    case 'query':
      return schema.getQueryType();
    case 'mutation':
      return schema.getMutationType();
    case 'subscription':
      return schema.getSubscriptionType();
  }
}

// Evaluates grouped fields of one object type. `multiplicity` is the number of
// response elements (list items) currently in scope.
function evaluateFields(
  context: AnalysisContext,
  parentType: GraphQLObjectType,
  groupedFieldSet: ReadonlyMap<string, FieldDetailsList>,
  multiplicity: number,
): ReadonlyArray<QueryCostNode> {
  const nodes: Array<QueryCostNode> = [];
  for (const [responseKey, fieldDetailsList] of groupedFieldSet) {
    const fieldNode = fieldDetailsList[0].node;
    const fieldDef = parentType.getFields()[fieldNode.name.value];
    if (fieldDef == null) {
      continue;
    }

    const fieldConfig = context.fieldConfigs.get(
      `${parentType.name}.${fieldDef.name}`,
    ) ?? {
      fixedCost: context.defaultFieldCost,
    };

    const namedType = getNamedType(fieldDef.type);
    let listCount: number | undefined;
    let itemMultiplicity = multiplicity;
    if (isListReturnType(fieldDef.type) && fieldConfig.list) {
      listCount = resolveListCount(
        fieldDef,
        fieldConfig.list,
        fieldDetailsList,
        context.variableValues,
      );
      itemMultiplicity = checkedMultiply(itemMultiplicity, listCount);
    }

    context.expansionCount = checkedAdd(
      context.expansionCount,
      itemMultiplicity,
    );
    if (context.expansionCount > context.maxExpansion) {
      throw new GraphQLError(
        `Query cost expansion exceeds limit of ${context.maxExpansion} estimated fields.`,
        { nodes: fieldDetailsList.map((details) => details.node) },
      );
    }

    let children: ReadonlyArray<QueryCostNode> | undefined;
    let concreteType: string | undefined;
    if (fieldNode.selectionSet) {
      let selectionType: GraphQLObjectType = namedType as GraphQLObjectType;
      if (isAbstractType(namedType)) {
        const possibleTypes = context.schema.getPossibleTypes(namedType);
        if (possibleTypes.length === 0) {
          throw new GraphQLError(
            `Abstract type "${namedType.name}" provides no possible concrete types.`,
          );
        }
        let worst: {
          type: GraphQLObjectType;
          children: ReadonlyArray<QueryCostNode>;
          cost: number;
        } = {
          type: possibleTypes[0],
          children: collectAndEvaluate(
            context,
            possibleTypes[0],
            fieldDetailsList,
            itemMultiplicity,
          ),
          cost: -1,
        };
        worst.cost = sumSubtreeCosts(worst.children);
        for (const possibleType of possibleTypes.slice(1)) {
          const possibleChildren = collectAndEvaluate(
            context,
            possibleType,
            fieldDetailsList,
            itemMultiplicity,
          );
          const possibleCost = sumSubtreeCosts(possibleChildren);
          if (possibleCost > worst.cost) {
            worst = {
              type: possibleType,
              children: possibleChildren,
              cost: possibleCost,
            };
          }
        }
        selectionType = worst.type;
        children = worst.children;
        concreteType = selectionType.name;
      } else {
        children = collectAndEvaluate(
          context,
          selectionType,
          fieldDetailsList,
          itemMultiplicity,
        );
      }
    }

    const childCost = children
      ? children.reduce((total, child) => checkedAdd(total, child.cost), 0)
      : 0;
    const ownCost = checkedMultiply(fieldConfig.fixedCost, multiplicity);
    const cost = checkedAdd(ownCost, childCost);

    const node: QueryCostNode = {
      key: responseKey,
      field: fieldDef.name,
      type: namedType.name,
      fixedCost: fieldConfig.fixedCost,
      multiplicity,
      cost,
      ...(listCount !== undefined ? { listCount } : {}),
      ...(concreteType !== undefined ? { concreteType } : {}),
      ...(children && children.length > 0 ? { children } : {}),
    };
    nodes.push(node);
  }
  return nodes;
}

function collectAndEvaluate(
  context: AnalysisContext,
  parentType: GraphQLObjectType,
  fieldDetailsList: FieldDetailsList,
  multiplicity: number,
): ReadonlyArray<QueryCostNode> {
  const { groupedFieldSet } = collectSubfields(
    context.schema,
    context.fragments,
    context.variableValues,
    parentType,
    fieldDetailsList,
    false,
  );
  return evaluateFields(context, parentType, groupedFieldSet, multiplicity);
}

function isListReturnType(
  type: GraphQLField<unknown, unknown>['type'],
): boolean {
  let current = type;
  if (isNonNullType(current)) {
    current = current.ofType;
  }
  return (
    isListType(current) ||
    (isNonNullType(current) && isListType(current.ofType))
  );
}

function sumSubtreeCosts(nodes: ReadonlyArray<QueryCostNode>): number {
  return nodes.reduce((total, node) => checkedAdd(total, node.cost), 0);
}

// Reads and bounds the list item count argument. Mirrors execution-time
// argument coercion: literals and variables are coerced as Int values, an
// absent argument falls back to the schema default or explicit bound, and
// negative or out-of-range values are rejected.
function resolveListCount(
  fieldDef: GraphQLField<unknown, unknown>,
  config: ListCostConfig,
  fieldDetailsList: FieldDetailsList,
  variableValues: VariableValues,
): number {
  const argumentDef = fieldDef.args.find(
    (argument) => argument.name === config.argument,
  );
  let count: number | undefined;
  for (const details of fieldDetailsList) {
    const argumentNode = details.node.arguments?.find(
      (argument) => argument.name.value === config.argument,
    );
    if (!argumentNode || !argumentDef) {
      continue;
    }
    const coerced = coerceInputLiteral(
      argumentNode.value,
      argumentDef.type,
      variableValues,
      details.fragmentVariableValues,
    );
    if (coerced !== undefined) {
      count = coerced as number;
      break;
    }
  }

  if (count === undefined) {
    const schemaDefault = argumentDef
      ? coerceDefaultValue(argumentDef)
      : undefined;
    count =
      typeof schemaDefault === 'number' ? schemaDefault : config.defaultCount;
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new GraphQLError(
      `List count argument "${config.argument}" must be a non-negative integer.`,
      { nodes: fieldDetailsList.map((details) => details.node) },
    );
  }
  if (count > config.maxCount) {
    throw new GraphQLError(
      `List count argument "${config.argument}" value ${count} exceeds the configured maximum of ${config.maxCount}.`,
      { nodes: fieldDetailsList.map((details) => details.node) },
    );
  }
  return count;
}

// Walks the cost tree in response order, expanding each list by its estimated
// count, and returns the path at which accumulated cost first crosses budget.
function findOverBudgetPath(
  costTree: ReadonlyArray<QueryCostNode>,
  budget: number,
): ReadonlyArray<string | number> | undefined {
  let spent = 0;

  const visit = (
    nodes: ReadonlyArray<QueryCostNode>,
    pathPrefix: ReadonlyArray<string | number>,
    parentRepetitions: number,
  ): ReadonlyArray<string | number> | undefined => {
    for (const node of nodes) {
      for (let occurrence = 0; occurrence < parentRepetitions; occurrence++) {
        spent = checkedAdd(spent, node.fixedCost);
        if (spent > budget) {
          const path = [...pathPrefix, node.key];
          if (parentRepetitions > 1) {
            path.push(occurrence);
          }
          return path;
        }
        if (node.children) {
          const childPrefix = [...pathPrefix, node.key];
          if (parentRepetitions > 1) {
            childPrefix.push(occurrence);
          }
          const found = visit(node.children, childPrefix, node.listCount ?? 1);
          if (found) {
            return found;
          }
        }
      }
    }
  };

  return visit(costTree, [], 1);
}
