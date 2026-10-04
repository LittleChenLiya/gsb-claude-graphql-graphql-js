/** @category Values */

import { inspect } from '../jsutils/inspect.ts';
import { isIterableObject } from '../jsutils/isIterableObject.ts';
import { isObjectLike } from '../jsutils/isObjectLike.ts';
import { keyMap } from '../jsutils/keyMap.ts';
import type { Maybe } from '../jsutils/Maybe.ts';

import type { ConstValueNode } from '../language/ast.ts';
import { Kind } from '../language/kinds.ts';
import { print } from '../language/printer.ts';

import type {
  GraphQLArgument,
  GraphQLInputField,
  GraphQLInputObjectType,
  GraphQLInputType,
  GraphQLScalarType,
} from '../type/definition.ts';
import {
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
} from '../type/definition.ts';
import { isIntrospectionType } from '../type/introspection.ts';
import { isSpecifiedScalarType } from '../type/scalars.ts';
import type { GraphQLSchema } from '../type/schema.ts';

import { validateInputLiteral } from './validateInputValue.ts';

/**
 * A single finding produced by `auditDefaultValues`, locating one default
 * value within the schema along with the reason it was reported.
 */
export interface DefaultValueAuditEntry {
  /**
   * Full path from the schema element to the audited default value.
   *
   * The path starts with the type name (or `"@directive"` for directive
   * arguments), followed by the field and argument or input field names, and
   * then any nested input object field names and list indexes leading to the
   * reported value.
   */
  readonly path: ReadonlyArray<string | number>;
  /** Human readable reason explaining why this entry was reported. */
  readonly reason: string;
}

/**
 * The result of auditing the default values of a schema with
 * `auditDefaultValues`.
 */
export interface DefaultValueAuditReport {
  /** The number of default values that were audited. */
  readonly auditedCount: number;
  /**
   * Default values which cannot be converted to a valid literal for their
   * input type, each with a full type/field path and error reason.
   */
  readonly issues: ReadonlyArray<DefaultValueAuditEntry>;
  /**
   * Default values of custom scalar types for which no audit adapter was
   * provided. These could not be audited and are reported as unknown rather
   * than as issues.
   */
  readonly unknowns: ReadonlyArray<DefaultValueAuditEntry>;
}

/**
 * An audit adapter for a custom scalar type. Explicitly provided adapters are
 * the only custom scalar behavior invoked by `auditDefaultValues`; the
 * scalar's own `serialize`/`parseValue` functions are never executed.
 *
 * The adapter receives the default value (a runtime value, or a
 * `ConstValueNode` when the default was provided as a literal) along with the
 * scalar type, and returns `true` when the default is acceptable, `false` to
 * reject it with a generic reason, or a string to reject it with a specific
 * reason.
 */
export type DefaultValueScalarAuditAdapter = (
  value: unknown,
  scalarType: GraphQLScalarType,
) => boolean | string;

/** Options for `auditDefaultValues`. */
export interface AuditDefaultValuesOptions {
  /**
   * Audit adapters for custom scalar types, keyed by scalar type name.
   * Custom scalar defaults without a registered adapter are reported as
   * unknown and their `serialize` is never executed.
   */
  readonly scalarAdapters?: Readonly<{
    [key: string]: DefaultValueScalarAuditAdapter;
  }>;
}

/**
 * Audits the default values of a schema without modifying it.
 *
 * Every argument of every field and directive, and every input object field
 * with a default value, is checked to determine whether the default can be
 * converted to a valid literal for its input type. Nested input objects,
 * lists, enums, and non-null types are covered, and each reported issue
 * includes the full type/field path and the error reason.
 *
 * Custom scalar types are only audited through explicitly provided audit
 * adapters (see `AuditDefaultValuesOptions.scalarAdapters`). When no adapter
 * is registered for a custom scalar, its default is reported as unknown and
 * the scalar's `serialize` is never executed.
 *
 * Recursive input types are handled with a type stack so cyclic default
 * values are not infinitely expanded; issues are only reported for the actual
 * default values present.
 *
 * The audit is read-only: it does not change the schema, its default values,
 * or the behavior of `astFromValue`.
 * @param schema - The schema whose default values should be audited.
 * @param options - Audit options, including custom scalar audit adapters.
 * @returns A report of audited, invalid, and unknown default values.
 * @example
 * ```ts
 * import { buildSchema } from 'graphql/utilities';
 * import { auditDefaultValues } from 'graphql/utilities';
 *
 * const schema = buildSchema(`
 *   type Query {
 *     review(stars: Int = 5): String
 *   }
 * `);
 *
 * const report = auditDefaultValues(schema);
 *
 * report.auditedCount; // => 2 ("stars" and @deprecated's "reason")
 * report.issues; // => []
 * report.unknowns; // => []
 * ```
 * @example
 * ```ts
 * // Invalid defaults are reported with their full path and reason.
 * import {
 *   GraphQLInt,
 *   GraphQLObjectType,
 *   GraphQLSchema,
 *   GraphQLString,
 * } from 'graphql/type';
 * import { auditDefaultValues } from 'graphql/utilities';
 *
 * const schema = new GraphQLSchema({
 *   query: new GraphQLObjectType({
 *     name: 'Query',
 *     fields: {
 *       review: {
 *         type: GraphQLString,
 *         args: { stars: { type: GraphQLInt, defaultValue: 'bad' } },
 *       },
 *     },
 *   }),
 *   directives: [],
 * });
 *
 * const report = auditDefaultValues(schema);
 *
 * report.issues.map((issue) => issue.path); // => [['Query', 'review', 'stars']]
 * ```
 */
export function auditDefaultValues(
  schema: GraphQLSchema,
  options?: Maybe<AuditDefaultValuesOptions>,
): DefaultValueAuditReport {
  const context: AuditContext = {
    auditedCount: 0,
    issues: [],
    unknowns: [],
    scalarAdapters: options?.scalarAdapters ?? {},
    typeStack: [],
  };

  for (const type of Object.values(schema.getTypeMap())) {
    if (isIntrospectionType(type)) {
      continue;
    }
    if (isObjectType(type) || isInterfaceType(type)) {
      for (const field of Object.values(type.getFields())) {
        for (const arg of field.args) {
          auditInputValueDefault(context, arg, [
            type.name,
            field.name,
            arg.name,
          ]);
        }
      }
    } else if (isInputObjectType(type)) {
      for (const field of Object.values(type.getFields())) {
        auditInputValueDefault(context, field, [type.name, field.name]);
      }
    }
  }

  for (const directive of schema.getDirectives()) {
    for (const arg of directive.args) {
      auditInputValueDefault(context, arg, [`@${directive.name}`, arg.name]);
    }
  }

  return {
    auditedCount: context.auditedCount,
    issues: context.issues,
    unknowns: context.unknowns,
  };
}

/**
 * Formats an audit entry path as a readable schema coordinate-like string.
 * @param path - The audit entry path to format.
 * @returns The formatted path, e.g. `Query.review.stars[1]`.
 * @example
 * ```ts
 * import { formatDefaultValueAuditPath } from 'graphql/utilities';
 *
 * formatDefaultValueAuditPath(['Query', 'review', 'stars', 1]); // => 'Query.review.stars[1]'
 * ```
 */
export function formatDefaultValueAuditPath(
  path: ReadonlyArray<string | number>,
): string {
  let result = '';
  for (const segment of path) {
    result +=
      typeof segment === 'number'
        ? `[${segment}]`
        : result === ''
          ? segment
          : `.${segment}`;
  }
  return result;
}

interface AuditContext {
  auditedCount: number;
  issues: Array<DefaultValueAuditEntry>;
  unknowns: Array<DefaultValueAuditEntry>;
  scalarAdapters: Readonly<{ [key: string]: DefaultValueScalarAuditAdapter }>;
  /**
   * Stack of the input object types and default values currently being
   * expanded, used to avoid infinitely expanding recursive types when a
   * default value is cyclic.
   */
  typeStack: Array<{ type: GraphQLInputObjectType; value: unknown }>;
}

function auditInputValueDefault(
  context: AuditContext,
  inputValue: GraphQLArgument | GraphQLInputField,
  path: ReadonlyArray<string | number>,
): void {
  const defaultInput = inputValue.default;
  if (defaultInput !== undefined) {
    context.auditedCount++;
    if (defaultInput.literal !== undefined) {
      auditLiteral(context, defaultInput.literal, inputValue.type, path);
    } else {
      auditValue(context, defaultInput.value, inputValue.type, path);
    }
    return;
  }

  const legacyDefaultValue = inputValue.defaultValue;
  if (legacyDefaultValue !== undefined) {
    context.auditedCount++;
    auditValue(context, legacyDefaultValue, inputValue.type, path);
  }
}

function reportIssue(
  context: AuditContext,
  path: ReadonlyArray<string | number>,
  reason: string,
): void {
  context.issues.push({ path, reason });
}

function auditValue(
  context: AuditContext,
  value: unknown,
  type: GraphQLInputType,
  path: ReadonlyArray<string | number>,
): void {
  if (isNonNullType(type)) {
    if (value === null) {
      reportIssue(
        context,
        path,
        `Expected default value of non-null type "${type}" not to be null.`,
      );
      return;
    }
    auditValue(context, value, type.ofType, path);
    return;
  }

  // Only explicit null reaches here; it is a valid literal for nullable types.
  if (value === null) {
    return;
  }

  if (isListType(type)) {
    if (isIterableObject(value)) {
      let index = 0;
      for (const itemValue of value) {
        auditValue(context, itemValue, type.ofType, [...path, index++]);
      }
    } else {
      // Lists accept a non-list value as a list of one.
      auditValue(context, value, type.ofType, path);
    }
    return;
  }

  if (isInputObjectType(type)) {
    if (!isObjectLike(value) || Array.isArray(value)) {
      reportIssue(
        context,
        path,
        `Expected default value of type "${type}" to be an object, found: ${inspect(
          value,
        )}.`,
      );
      return;
    }

    if (
      context.typeStack.some(
        (entry) => entry.type === type && entry.value === value,
      )
    ) {
      // This recursive type and value pair is already being expanded higher
      // up the type stack; stop to avoid infinitely expanding cyclic values.
      return;
    }

    context.typeStack.push({ type, value });
    const fieldDefs = type.getFields();
    for (const field of Object.values(fieldDefs)) {
      const fieldValue = value[field.name];
      if (fieldValue !== undefined) {
        auditValue(context, fieldValue, field.type, [...path, field.name]);
      }
    }
    for (const fieldName of Object.keys(value)) {
      if (
        value[fieldName] !== undefined &&
        !Object.hasOwn(fieldDefs, fieldName)
      ) {
        reportIssue(
          context,
          path,
          `Expected default value of type "${type}" not to include unknown field "${fieldName}".`,
        );
      }
    }
    context.typeStack.pop();
    return;
  }

  if (isEnumType(type)) {
    try {
      type.coerceOutputValue(value);
    } catch {
      reportIssue(
        context,
        path,
        `Expected default value of enum type "${type}" to be one of its values, found: ${inspect(
          value,
        )}.`,
      );
    }
    return;
  }

  if (isScalarType(type)) {
    auditScalarValue(context, value, type, path);
  }
}

function auditScalarValue(
  context: AuditContext,
  value: unknown,
  type: GraphQLScalarType,
  path: ReadonlyArray<string | number>,
): void {
  if (isSpecifiedScalarType(type)) {
    try {
      type.coerceOutputValue(value);
    } catch {
      reportIssue(
        context,
        path,
        `Expected default value of type "${type}" to be convertible to a valid literal, found: ${inspect(
          value,
        )}.`,
      );
    }
    return;
  }

  const adapter = context.scalarAdapters[type.name];
  if (adapter === undefined) {
    context.unknowns.push({
      path,
      reason: `No audit adapter registered for custom scalar "${type}".`,
    });
    return;
  }

  let result: boolean | string;
  try {
    result = adapter(value, type);
  } catch (error) {
    reportIssue(
      context,
      path,
      `Audit adapter for custom scalar "${type}" threw an error: ${
        error instanceof Error ? error.message : inspect(error)
      }`,
    );
    return;
  }

  if (result === true) {
    return;
  }
  reportIssue(
    context,
    path,
    typeof result === 'string'
      ? result
      : `Audit adapter for custom scalar "${type}" rejected default value: ${inspect(
          value,
        )}.`,
  );
}

function auditLiteral(
  context: AuditContext,
  valueNode: ConstValueNode,
  type: GraphQLInputType,
  path: ReadonlyArray<string | number>,
): void {
  if (isNonNullType(type)) {
    if (valueNode.kind === Kind.NULL) {
      reportIssue(
        context,
        path,
        `Expected default value of non-null type "${type}" not to be null.`,
      );
      return;
    }
    auditLiteral(context, valueNode, type.ofType, path);
    return;
  }

  if (valueNode.kind === Kind.NULL) {
    return;
  }

  if (isListType(type)) {
    if (valueNode.kind === Kind.LIST) {
      let index = 0;
      for (const itemNode of valueNode.values) {
        auditLiteral(context, itemNode, type.ofType, [...path, index++]);
      }
    } else {
      // Lists accept a non-list value as a list of one.
      auditLiteral(context, valueNode, type.ofType, path);
    }
    return;
  }

  if (isInputObjectType(type)) {
    if (valueNode.kind !== Kind.OBJECT) {
      reportIssue(
        context,
        path,
        `Expected default value of type "${type}" to be an object, found: ${print(
          valueNode,
        )}.`,
      );
      return;
    }

    const fieldDefs = type.getFields();
    const fieldNodes = keyMap(valueNode.fields, (field) => field.name.value);
    for (const field of Object.values(fieldDefs)) {
      const fieldNode = fieldNodes[field.name];
      if (fieldNode !== undefined) {
        auditLiteral(context, fieldNode.value, field.type, [
          ...path,
          field.name,
        ]);
      }
    }
    for (const fieldNode of valueNode.fields) {
      if (!Object.hasOwn(fieldDefs, fieldNode.name.value)) {
        reportIssue(
          context,
          path,
          `Expected default value of type "${type}" not to include unknown field "${fieldNode.name.value}".`,
        );
      }
    }
    return;
  }

  if (isEnumType(type)) {
    if (
      valueNode.kind !== Kind.ENUM ||
      type.getValue(valueNode.value) == null
    ) {
      reportIssue(
        context,
        path,
        `Expected default value of enum type "${type}" to be one of its values, found: ${print(
          valueNode,
        )}.`,
      );
    }
    return;
  }

  if (isScalarType(type)) {
    auditScalarLiteral(context, valueNode, type, path);
  }
}

function auditScalarLiteral(
  context: AuditContext,
  valueNode: ConstValueNode,
  type: GraphQLScalarType,
  path: ReadonlyArray<string | number>,
): void {
  if (isSpecifiedScalarType(type)) {
    // Built-in scalars are safe to coerce directly; invalid literals throw.
    validateInputLiteral(valueNode, type, (error) => {
      reportIssue(context, path, error.message);
    });
    return;
  }

  const adapter = context.scalarAdapters[type.name];
  if (adapter === undefined) {
    context.unknowns.push({
      path,
      reason: `No audit adapter registered for custom scalar "${type}".`,
    });
    return;
  }

  let result: boolean | string;
  try {
    result = adapter(valueNode, type);
  } catch (error) {
    reportIssue(
      context,
      path,
      `Audit adapter for custom scalar "${type}" threw an error: ${
        error instanceof Error ? error.message : inspect(error)
      }`,
    );
    return;
  }

  if (result === true) {
    return;
  }
  reportIssue(
    context,
    path,
    typeof result === 'string'
      ? result
      : `Audit adapter for custom scalar "${type}" rejected default value: ${print(
          valueNode,
        )}.`,
  );
}
