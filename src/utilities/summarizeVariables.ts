/** @category Values */

import { inspect } from '../jsutils/inspect.ts';
import { invariant } from '../jsutils/invariant.ts';
import { isObjectLike } from '../jsutils/isObjectLike.ts';
import type { ObjMap, ReadOnlyObjMap } from '../jsutils/ObjMap.ts';

import { ensureGraphQLError } from '../error/ensureGraphQLError.ts';
import { GraphQLError } from '../error/GraphQLError.ts';

import type {
  OperationDefinitionNode,
  VariableDefinitionNode,
} from '../language/ast.ts';

import type { GraphQLSchema } from '../type/schema.ts';

import { getVariableValues } from '../execution/values.ts';

import { valueFromASTUntyped } from './valueFromASTUntyped.ts';

/**
 * The fixed marker that replaces sensitive values in variable summaries and
 * in sanitized error messages.
 */
export const VARIABLE_SUMMARY_REDACTED = '[REDACTED]';

/**
 * A wildcard path segment which applies the remainder of a sensitive path to
 * every element of a list (or to every field value of an input object).
 */
export const SENSITIVE_PATH_WILDCARD = '*';

/**
 * A single segment of a sensitive path: an input object field name, a list
 * index, or the {@link SENSITIVE_PATH_WILDCARD} wildcard.
 */
export type SensitivePathSegment = string | number;

/**
 * A declared sensitive path, rooted at a variable name.
 *
 * May be expressed as an array of segments, or as a dot-separated string
 * where the wildcard segment applies to every list element, e.g.
 * `users.*.password` or `users[].password`.
 */
export type SensitivePath = ReadonlyArray<SensitivePathSegment>;

/** Options accepted by {@link summarizeVariables}. */
export interface SummarizeVariablesOptions {
  /**
   * Declared sensitive field paths. Each path starts with a variable name and
   * addresses values within that variable's (coerced) value, e.g.
   * `users[].password`. List wildcards apply to every element.
   */
  sensitivePaths?: ReadonlyArray<string | SensitivePath>;
  /** The marker replacing sensitive scalars. Defaults to `"[REDACTED]"`. */
  redactedMarker?: string;
}

/**
 * How the effective value of a summarized variable was determined:
 * `provided` by the request, filled in from the operation's `default` value,
 * or `notProvided` at all.
 */
export type VariableSummaryStatus = 'provided' | 'default' | 'notProvided';

/** A single variable entry within a {@link VariableSummary}. */
export interface VariableSummaryEntry {
  /** How the effective value of the variable was determined. */
  readonly status: VariableSummaryStatus;
  /**
   * The coerced value with sensitive values masked. Absent when the variable
   * was not provided and has no default; explicitly `null` when the coerced
   * value is `null`.
   */
  readonly value?: unknown;
}

/** A masked summary of an operation's variable values, keyed by name. */
export type VariableSummary = ReadOnlyObjMap<VariableSummaryEntry>;

/**
 * The result of {@link summarizeVariables}: either a masked `summary` of the
 * coerced variable values, or sanitized `errors` when coercion failed.
 */
export type SummarizeVariablesResult =
  | {
      /** A masked summary of the coerced variable values. */
      readonly summary: VariableSummary;
      /** Never present on a successful summary. */
      readonly errors?: never;
    }
  | {
      /** Sanitized coercion errors, free of sensitive values. */
      readonly errors: ReadonlyArray<GraphQLError>;
      /** Never present when coercion failed. */
      readonly summary?: never;
    };

/**
 * Produces a masked summary of the variable values for an operation without
 * executing any resolvers.
 *
 * The provided `variables` are first coerced with the same rules used by
 * execution (see `getVariableValues`), including applying variable default
 * values. Each declared sensitive path is then masked within the coerced
 * values: sensitive scalars are replaced by a fixed marker while object
 * structure and list lengths are preserved. Explicit `null` values are kept
 * as `null`, and variables that were not provided at all are reported with
 * status `notProvided` and no value. Variable default values are masked by
 * the same rules. The input `variables` object is never mutated.
 *
 * If coercion fails, only a safe error summary is returned: error messages
 * are sanitized so that values at the declared sensitive paths (including
 * values originating from variable defaults) are replaced by the marker
 * instead of leaking raw sensitive values.
 * @param schema - GraphQL schema to use.
 * @param operation - The operation definition whose variables are summarized.
 * @param variables - The runtime variable values keyed by variable name.
 * @param options - Optional configuration for this summary.
 * @param [options.sensitivePaths] - Declared sensitive field paths.
 * @param [options.redactedMarker] - The marker replacing sensitive scalars.
 * @returns A masked variable summary, or sanitized coercion errors.
 * @example
 * ```ts
 * // Summarize variables with sensitive fields masked.
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
 *     users(input: UserInput): [String]
 *   }
 * `);
 * const document = parse(`
 *   query ($input: UserInput) {
 *     users(input: $input)
 *   }
 * `);
 * const operation = document.definitions[0];
 *
 * const result = summarizeVariables(
 *   schema,
 *   operation,
 *   { input: { name: 'Ada', password: 's3cr3t' } },
 *   { sensitivePaths: ['input.password'] },
 * );
 *
 * result.summary; // => { input: { status: 'provided', value: { name: 'Ada', password: '[REDACTED]' } } }
 * ```
 * @example
 * ```ts
 * // Coercion failures return sanitized errors without sensitive values.
 * import assert from 'node:assert';
 * import { parse } from 'graphql/language';
 * import { buildSchema, summarizeVariables } from 'graphql/utilities';
 *
 * const schema = buildSchema(`
 *   input UserInput {
 *     password: String
 *   }
 *
 *   type Query {
 *     users(input: UserInput): [String]
 *   }
 * `);
 * const document = parse(`
 *   query ($input: UserInput) {
 *     users(input: $input)
 *   }
 * `);
 * const operation = document.definitions[0];
 *
 * const result = summarizeVariables(
 *   schema,
 *   operation,
 *   { input: { password: 's3cr3t', bogus: true } },
 *   { sensitivePaths: ['input.password'] },
 * );
 *
 * assert('errors' in result);
 *
 * result.errors[0].message.includes('s3cr3t'); // => false
 * ```
 */
export function summarizeVariables(
  schema: GraphQLSchema,
  operation: OperationDefinitionNode,
  variables: { readonly [variable: string]: unknown },
  options?: SummarizeVariablesOptions,
): SummarizeVariablesResult {
  const marker = options?.redactedMarker ?? VARIABLE_SUMMARY_REDACTED;
  const pathsByVariable = groupPathsByVariable(options?.sensitivePaths ?? []);
  const variableDefinitions = operation.variableDefinitions ?? [];

  let coercedResult;
  try {
    coercedResult = getVariableValues(schema, variableDefinitions, variables);
    /* node:coverage ignore next 15 */
  } catch (error) {
    // Defensive: getVariableValues already reports coercion failures as
    // errors, but never leak raw values if something unexpected throws.
    return {
      errors: [
        new GraphQLError(
          sanitizeMessage(
            ensureGraphQLError(error).message,
            collectAllSecrets(variableDefinitions, variables, pathsByVariable),
            marker,
          ),
        ),
      ],
    };
  }

  if ('errors' in coercedResult) {
    const secrets = collectAllSecrets(
      variableDefinitions,
      variables,
      pathsByVariable,
    );
    return {
      errors: coercedResult.errors.map(
        (error) =>
          new GraphQLError(sanitizeMessage(error.message, secrets, marker)),
      ),
    };
  }

  const { sources, coerced } = coercedResult.variableValues;
  const summary: ObjMap<VariableSummaryEntry> = Object.create(null);
  for (const varDefNode of variableDefinitions) {
    const varName = varDefNode.variable.name.value;
    const source = sources[varName];
    invariant(source !== undefined, 'Expected coerced variable source.');
    const paths = pathsByVariable.get(varName) ?? [];
    if (source.value !== undefined) {
      summary[varName] = {
        status: 'provided',
        value: maskValue(coerced[varName], paths, marker),
      };
    } else if (Object.hasOwn(coerced, varName)) {
      summary[varName] = {
        status: 'default',
        value: maskValue(coerced[varName], paths, marker),
      };
    } else {
      summary[varName] = { status: 'notProvided' };
    }
  }
  return { summary };
}

// Groups the declared sensitive paths by the variable they are rooted at,
// dropping the leading variable name segment.
function groupPathsByVariable(
  sensitivePaths: ReadonlyArray<string | SensitivePath>,
): Map<string, Array<SensitivePath>> {
  const pathsByVariable = new Map<string, Array<SensitivePath>>();
  for (const sensitivePath of sensitivePaths) {
    const segments =
      typeof sensitivePath === 'string'
        ? parseSensitivePath(sensitivePath)
        : sensitivePath;
    const [head, ...rest] = segments;
    if (typeof head !== 'string') {
      continue; // Sensitive paths must be rooted at a variable name.
    }
    const paths = pathsByVariable.get(head);
    if (paths === undefined) {
      pathsByVariable.set(head, [rest]);
    } else {
      paths.push(rest);
    }
  }
  return pathsByVariable;
}

// Parses a dot-separated sensitive path such as `users[].password` into
// segments, where `*` or `[]` denote the list wildcard and numeric segments
// address a specific list index.
function parseSensitivePath(path: string): SensitivePath {
  const segments: Array<SensitivePathSegment> = [];
  for (const part of path.split('.')) {
    if (part === SENSITIVE_PATH_WILDCARD || part === '[]') {
      segments.push(SENSITIVE_PATH_WILDCARD);
    } else if (part.endsWith('[]')) {
      segments.push(part.slice(0, -2), SENSITIVE_PATH_WILDCARD);
    } else if (/^[0-9]+$/.test(part)) {
      segments.push(Number(part));
    } else {
      segments.push(part);
    }
  }
  return segments;
}

// Applies each sensitive path to the value, returning a masked copy. The
// input value is never mutated.
function maskValue(
  value: unknown,
  paths: ReadonlyArray<SensitivePath>,
  marker: string,
): unknown {
  let masked = value;
  for (const path of paths) {
    masked = maskAtPath(masked, path, marker);
  }
  return masked;
}

function maskAtPath(
  value: unknown,
  path: SensitivePath,
  marker: string,
): unknown {
  if (path.length === 0) {
    return maskLeaves(value, marker);
  }
  const [head, ...rest] = path;
  if (head === SENSITIVE_PATH_WILDCARD) {
    if (Array.isArray(value)) {
      return value.map((item) => maskAtPath(item, rest, marker));
    }
    if (isObjectLike(value)) {
      return mapObjectValues(value, (fieldValue) =>
        maskAtPath(fieldValue, rest, marker),
      );
    }
    return value;
  }
  if (typeof head === 'number') {
    if (Array.isArray(value) && head < value.length) {
      return value.map((item, index) =>
        index === head ? maskAtPath(item, rest, marker) : item,
      );
    }
    return value;
  }
  if (
    isObjectLike(value) &&
    !Array.isArray(value) &&
    Object.hasOwn(value, head)
  ) {
    return { ...value, [head]: maskAtPath(value[head], rest, marker) };
  }
  return value;
}

// Masks every scalar leaf within a value, preserving object structure and
// list lengths. Explicit null values are preserved as null.
function maskLeaves(value: unknown, marker: string): unknown {
  if (value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskLeaves(item, marker));
  }
  if (isObjectLike(value)) {
    return mapObjectValues(value, (fieldValue) =>
      maskLeaves(fieldValue, marker),
    );
  }
  return marker;
}

function mapObjectValues(
  value: object,
  transform: (fieldValue: unknown) => unknown,
): ObjMap<unknown> {
  const result: ObjMap<unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    result[key] = transform(fieldValue);
  }
  return result;
}

// Collects the sensitive scalar values found at the declared sensitive paths
// within both the provided variables and the variable default values, so
// that error messages can be scrubbed of them.
function collectAllSecrets(
  variableDefinitions: ReadonlyArray<VariableDefinitionNode>,
  variables: { readonly [variable: string]: unknown },
  pathsByVariable: ReadonlyMap<string, ReadonlyArray<SensitivePath>>,
): Set<string> {
  const secrets = new Set<string>();
  for (const varDefNode of variableDefinitions) {
    const varName = varDefNode.variable.name.value;
    const paths = pathsByVariable.get(varName);
    if (paths === undefined) {
      continue;
    }
    if (Object.hasOwn(variables, varName)) {
      for (const path of paths) {
        collectSecretsAtPath(variables[varName], path, secrets);
      }
    }
    if (varDefNode.defaultValue) {
      const defaultValue = valueFromASTUntyped(varDefNode.defaultValue);
      for (const path of paths) {
        collectSecretsAtPath(defaultValue, path, secrets);
      }
    }
  }
  return secrets;
}

function collectSecretsAtPath(
  value: unknown,
  path: SensitivePath,
  secrets: Set<string>,
): void {
  if (path.length === 0) {
    collectLeafSecrets(value, secrets);
    return;
  }
  const [head, ...rest] = path;
  if (head === SENSITIVE_PATH_WILDCARD) {
    if (Array.isArray(value)) {
      for (const item of value) {
        collectSecretsAtPath(item, rest, secrets);
      }
    } else if (isObjectLike(value)) {
      for (const fieldValue of Object.values(value)) {
        collectSecretsAtPath(fieldValue, rest, secrets);
      }
    }
    return;
  }
  if (typeof head === 'number') {
    if (Array.isArray(value) && head < value.length) {
      collectSecretsAtPath(value[head], rest, secrets);
    }
    return;
  }
  if (
    isObjectLike(value) &&
    !Array.isArray(value) &&
    Object.hasOwn(value, head)
  ) {
    collectSecretsAtPath(value[head], rest, secrets);
  }
}

function collectLeafSecrets(value: unknown, secrets: Set<string>): void {
  if (value == null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectLeafSecrets(item, secrets);
    }
    return;
  }
  if (isObjectLike(value)) {
    for (const fieldValue of Object.values(value)) {
      collectLeafSecrets(fieldValue, secrets);
    }
    return;
  }
  // Values are printed in error messages via inspect(); strings may also
  // appear unquoted, so both forms are scrubbed.
  secrets.add(inspect(value));
  if (typeof value === 'string' && value !== '') {
    secrets.add(value);
  }
}

// Replaces every occurrence of a collected sensitive value within an error
// message with the redaction marker.
function sanitizeMessage(
  message: string,
  secrets: ReadonlySet<string>,
  marker: string,
): string {
  let sanitized = message;
  const candidates = Array.from(secrets).sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    sanitized = sanitized.split(candidate).join(marker);
  }
  return sanitized;
}
