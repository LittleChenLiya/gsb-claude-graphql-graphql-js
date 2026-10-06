/** @category Values */

import { isObjectLike } from '../jsutils/isObjectLike.ts';
import type { ObjMap, ReadOnlyObjMap } from '../jsutils/ObjMap.ts';

import type {
  DocumentNode,
  OperationDefinitionNode,
  VariableDefinitionNode,
} from '../language/ast.ts';
import { Kind } from '../language/kinds.ts';
import { print } from '../language/printer.ts';

import type { GraphQLInputType } from '../type/definition.ts';
import {
  isInputObjectType,
  isInputType,
  isListType,
  isNonNullType,
} from '../type/definition.ts';
import type { GraphQLSchema } from '../type/schema.ts';

import { coerceDefaultValue, coerceInputValue } from './coerceInputValue.ts';
import { getOperationAST } from './getOperationAST.ts';
import { typeFromAST } from './typeFromAST.ts';
import { validateInputValue } from './validateInputValue.ts';

/**
 * The fixed marker which replaces every sensitive scalar in a variable
 * summary.
 */
export const MASKED_VALUE = '<masked>';

/**
 * A masked summary of a single operation variable.
 *
 * The three states "provided", "defaulted", and "not provided" are kept
 * distinct: a variable which was neither provided nor defaulted has both
 * `provided` and `fromDefault` set to `false` and an `undefined` value, while
 * an explicitly provided (or defaulted) `null` is represented as a `null`
 * value.
 */
export interface VariableSummaryEntry {
  /** True when the variable was provided in the request input. */
  readonly provided: boolean;
  /** True when the summarized value came from the variable's default value. */
  readonly fromDefault: boolean;
  /**
   * The masked summary of the effective (coerced) variable value, or
   * `undefined` when the variable was neither provided nor defaulted.
   */
  readonly value: unknown;
}

/**
 * A masked summary of all variables of an operation.
 */
export interface VariableSummary {
  /** Masked variable summaries keyed by variable name. */
  readonly variables: ReadOnlyObjMap<VariableSummaryEntry>;
}

/**
 * A diagnostic for an invalid variable which is safe to log or display.
 *
 * Messages are constructed from variable names, value paths, and type names
 * only. Raw input values are never included, so values sitting at sensitive
 * paths cannot leak through error output.
 */
export interface SafeVariableError {
  /** A human-readable diagnostic which contains no raw input values. */
  readonly message: string;
  /** The name of the offending variable, when applicable. */
  readonly variableName?: string;
  /** The path of the invalid value within the variable, when applicable. */
  readonly path?: ReadonlyArray<string | number>;
}

/**
 * The result of {@link summarizeVariables}: either a masked summary of the
 * coerced variable values, or a list of safe coercion diagnostics.
 */
export type VariableSummaryResult =
  | {
      /** The masked variable summary. */
      readonly summary: VariableSummary;
      /** Never present on a successful summary. */
      readonly errors?: never;
    }
  | {
      /** Safe diagnostics which contain no raw input values. */
      readonly errors: ReadonlyArray<SafeVariableError>;
      /** Never present when coercion failed. */
      readonly summary?: never;
    };

/**
 * Options for {@link summarizeVariables}.
 */
export interface SummarizeVariablesOptions {
  /**
   * Declared sensitive field paths. Each path starts with a variable name and
   * uses `.` to separate segments. The `*` wildcard matches any single field
   * or list index, so `users.*.password` masks `password` in every element of
   * the `users` list. A path which points at an object or list masks every
   * scalar within that subtree.
   */
  readonly sensitivePaths?: ReadonlyArray<string>;
  /**
   * The operation to select when `operation` is a document containing
   * multiple operations.
   */
  readonly operationName?: string;
}

/**
 * Produces a masked summary of the effective variable values of an operation.
 *
 * Variables are first coerced with the standard coercion rules (the same ones
 * used by `getVariableValues`), including applying variable default values.
 * The coerced values are then masked: every scalar sitting at one of the
 * declared sensitive paths is replaced with {@link MASKED_VALUE}, while object
 * structure and list lengths are preserved. Default values are masked by the
 * same rules, and `null` values are preserved as `null` so that "provided as
 * null", "defaulted", and "not provided" remain distinguishable.
 *
 * The provided `inputs` object is never mutated, and no resolvers are
 * executed at any point.
 *
 * When coercion fails, only safe diagnostics are returned: messages are built
 * from variable names, value paths, and type names, so raw (potentially
 * sensitive) input values never appear in the errors.
 * @param schema - GraphQL schema to use.
 * @param operation - The operation (or document) whose variables are summarized.
 * @param inputs - The runtime variable values keyed by variable name.
 * @param options - Optional configuration, including sensitive paths.
 * @returns A masked variable summary, or safe coercion diagnostics.
 * @example
 * ```ts
 * // Summarize variables, masking declared sensitive paths.
 * import assert from 'node:assert';
 * import { parse } from 'graphql/language';
 * import { buildSchema, summarizeVariables } from 'graphql/utilities';
 *
 * const schema = buildSchema(`
 *   input UserInput {
 *     name: String
 *     password: String
 *   }
 *
 *   type Query {
 *     search(users: [UserInput!]!): String
 *   }
 * `);
 * const document = parse(`
 *   query ($users: [UserInput!]!, $fallback: UserInput = { password: "do-not-leak" }) {
 *     search(users: $users)
 *   }
 * `);
 *
 * const result = summarizeVariables(
 *   schema,
 *   document,
 *   {
 *     users: [
 *       { name: 'Ann', password: 'pw-1' },
 *       { name: 'Bob', password: 'pw-2' },
 *     ],
 *   },
 *   { sensitivePaths: ['users.*.password', 'fallback.password'] },
 * );
 *
 * assert('summary' in result);
 *
 * result.summary.variables.users; // => { provided: true, fromDefault: false, value: [{ name: 'Ann', password: '<masked>' }, { name: 'Bob', password: '<masked>' }] }
 * result.summary.variables.fallback; // => { provided: false, fromDefault: true, value: { password: '<masked>' } }
 * ```
 * @example
 * ```ts
 * // Invalid variables produce safe diagnostics without raw values.
 * import assert from 'node:assert';
 * import { parse } from 'graphql/language';
 * import { buildSchema, summarizeVariables } from 'graphql/utilities';
 *
 * const schema = buildSchema(`
 *   input UserInput {
 *     name: String
 *     password: String
 *   }
 *
 *   type Query {
 *     search(users: [UserInput!]!): String
 *   }
 * `);
 * const document = parse(`
 *   query ($users: [UserInput!]!) {
 *     search(users: $users)
 *   }
 * `);
 *
 * const result = summarizeVariables(
 *   schema,
 *   document,
 *   { users: [{ name: 'Ann', password: { oops: 'raw-secret' } }] },
 *   { sensitivePaths: ['users.*.password'] },
 * );
 *
 * assert('errors' in result);
 *
 * result.errors[0].message; // => 'Variable "$users" has invalid value at "$users[0].password": expected type "String".'
 * result.errors[0].message.includes('raw-secret'); // => false
 * ```
 */
export function summarizeVariables(
  schema: GraphQLSchema,
  operation: DocumentNode | OperationDefinitionNode,
  inputs: { readonly [variable: string]: unknown },
  options?: SummarizeVariablesOptions,
): VariableSummaryResult {
  const operationNode =
    operation.kind === Kind.DOCUMENT
      ? getOperationAST(operation, options?.operationName)
      : operation;
  if (operationNode == null) {
    return {
      errors: [
        {
          message:
            'Unable to determine which operation to summarize variables for.',
        },
      ],
    };
  }

  const state: SummarizeState = {
    sensitivePaths: parseSensitivePaths(options?.sensitivePaths),
    variables: Object.create(null),
    errors: [],
  };

  for (const varDefNode of operationNode.variableDefinitions ?? []) {
    const varName = varDefNode.variable.name.value;
    const varType = typeFromAST(schema, varDefNode.type);
    if (!isInputType(varType)) {
      // Type names are not sensitive, so this message is safe to report.
      state.errors.push({
        message: `Variable "$${varName}" expected value of type "${print(
          varDefNode.type,
        )}" which cannot be used as an input type.`,
        variableName: varName,
      });
      continue;
    }

    const rawValue = Object.hasOwn(inputs, varName)
      ? inputs[varName]
      : undefined;

    if (rawValue === undefined) {
      summarizeMissingVariable(varDefNode, varName, varType, state);
      continue;
    }

    const coercedValue = coerceInputValue(rawValue, varType);
    if (coercedValue !== undefined) {
      state.variables[varName] = {
        provided: true,
        fromDefault: false,
        value: summarizeValue(coercedValue, [varName], state.sensitivePaths),
      };
    } else {
      collectSafeErrors(varName, varType, rawValue, state.errors);
    }
  }

  if (state.errors.length > 0) {
    return { errors: state.errors };
  }
  return { summary: { variables: state.variables } };
}

interface SummarizeState {
  sensitivePaths: ReadonlyArray<ReadonlyArray<string>>;
  variables: ObjMap<VariableSummaryEntry>;
  errors: Array<SafeVariableError>;
}

function summarizeMissingVariable(
  varDefNode: VariableDefinitionNode,
  varName: string,
  varType: GraphQLInputType,
  state: SummarizeState,
): void {
  if (varDefNode.defaultValue) {
    let coercedDefaultValue;
    try {
      coercedDefaultValue = coerceDefaultValue({
        type: varType,
        default: { literal: varDefNode.defaultValue },
      });
      /* node:coverage ignore next 9 */
    } catch {
      // Defensive: invalid defaults are normally rejected during validation.
      // Report a safe diagnostic which does not include the default literal.
      state.errors.push({
        message: `Variable "$${varName}" has an invalid default value of type "${varType}".`,
        variableName: varName,
      });
      return;
    }
    // coerceDefaultValue either returns a defined value or throws for an
    // invalid default (handled above), so the value is always defined here.
    state.variables[varName] = {
      provided: false,
      fromDefault: true,
      value: summarizeValue(
        coercedDefaultValue,
        [varName],
        state.sensitivePaths,
      ),
    };
    return;
  } else if (isNonNullType(varType)) {
    state.errors.push({
      message: `Variable "$${varName}" of required type "${varType}" was not provided.`,
      variableName: varName,
    });
    return;
  }
  state.variables[varName] = {
    provided: false,
    fromDefault: false,
    value: undefined,
  };
}

function collectSafeErrors(
  varName: string,
  varType: GraphQLInputType,
  rawValue: unknown,
  errors: Array<SafeVariableError>,
): void {
  let reported = false;
  validateInputValue(
    rawValue,
    varType,
    (_error, path) => {
      reported = true;
      // Deliberately ignore the original error message: it may embed raw
      // (potentially sensitive) input values. Rebuild a safe diagnostic from
      // the variable name, the value path, and the expected type name only.
      errors.push({
        message: `Variable "$${varName}" has invalid value at "${printVariablePath(
          varName,
          path,
        )}": expected type "${typeAtPath(varType, path)}".`,
        variableName: varName,
        path,
      });
    },
    true,
  );

  /* node:coverage ignore next 7 */
  if (!reported) {
    // Defensive: coercion failed but validation reported no diagnostics.
    errors.push({
      message: `Variable "$${varName}" has invalid value: expected type "${varType}".`,
      variableName: varName,
    });
  }
}

function summarizeValue(
  value: unknown,
  path: ReadonlyArray<string>,
  sensitivePaths: ReadonlyArray<ReadonlyArray<string>>,
): unknown {
  if (isSensitivePath(path, sensitivePaths)) {
    return maskValueDeep(value);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      summarizeValue(item, [...path, String(index)], sensitivePaths),
    );
  }
  if (isObjectLike(value)) {
    const summarized: ObjMap<unknown> = {};
    for (const key of Object.keys(value)) {
      summarized[key] = summarizeValue(
        (value as ObjMap<unknown>)[key],
        [...path, key],
        sensitivePaths,
      );
    }
    return summarized;
  }
  return value;
}

function maskValueDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(maskValueDeep);
  }
  if (isObjectLike(value)) {
    const masked: ObjMap<unknown> = {};
    for (const key of Object.keys(value)) {
      masked[key] = maskValueDeep((value as ObjMap<unknown>)[key]);
    }
    return masked;
  }
  // Preserve null so that "provided as null" stays distinguishable from
  // "provided a value" and "not provided".
  return value === null ? null : MASKED_VALUE;
}

function isSensitivePath(
  path: ReadonlyArray<string>,
  sensitivePaths: ReadonlyArray<ReadonlyArray<string>>,
): boolean {
  return sensitivePaths.some(
    (sensitivePath) =>
      sensitivePath.length <= path.length &&
      sensitivePath.every(
        (segment, index) => segment === '*' || segment === path[index],
      ),
  );
}

function parseSensitivePaths(
  sensitivePaths: ReadonlyArray<string> | undefined,
): Array<Array<string>> {
  if (sensitivePaths === undefined) {
    return [];
  }
  return sensitivePaths.map(parsePath);
}

function parsePath(path: string): Array<string> {
  return path.split('.').filter((segment) => segment !== '');
}

function printVariablePath(
  varName: string,
  path: ReadonlyArray<string | number>,
): string {
  let printed = `$${varName}`;
  for (const segment of path) {
    printed += typeof segment === 'number' ? `[${segment}]` : `.${segment}`;
  }
  return printed;
}

function typeAtPath(
  type: GraphQLInputType,
  path: ReadonlyArray<string | number>,
): GraphQLInputType {
  let currentType = type;
  for (const segment of path) {
    const nullableType = isNonNullType(currentType)
      ? currentType.ofType
      : currentType;
    if (isListType(nullableType)) {
      currentType = nullableType.ofType;
    } else if (isInputObjectType(nullableType)) {
      const field = nullableType.getFields()[String(segment)];
      // Defensive: validation only reports paths through defined fields.
      /* node:coverage ignore next 3 */
      if (field === undefined) {
        return nullableType;
      }
      currentType = field.type;
      /* node:coverage ignore next 4 */
    } else {
      // Defensive: validation never reports paths descending into a leaf.
      return currentType;
    }
  }
  return currentType;
}
