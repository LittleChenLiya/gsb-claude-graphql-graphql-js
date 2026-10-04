/** @category Values */

import { inspect } from '../jsutils/inspect.ts';
import { isIterableObject } from '../jsutils/isIterableObject.ts';
import { isObjectLike } from '../jsutils/isObjectLike.ts';
import type { Maybe } from '../jsutils/Maybe.ts';
import type { Path } from '../jsutils/Path.ts';
import { addPath, pathToArray } from '../jsutils/Path.ts';

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
  isRequiredInputField,
} from '../type/definition.ts';
import { isSpecifiedScalarType } from '../type/scalars.ts';
import type { GraphQLSchema } from '../type/schema.ts';

import { valueFromASTUntyped } from './valueFromASTUntyped.ts';

/** Categories of problems found while auditing default values. */
export const AuditDefaultValueIssueType = {
  /** The default value cannot be represented as a valid literal for its type. */
  INVALID: 'INVALID' as const,
  /** A custom scalar without an adapter was encountered, so its validity is unknown. */
  UNKNOWN_SCALAR: 'UNKNOWN_SCALAR' as const,
};

/** Categories of problems found while auditing default values. */
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type AuditDefaultValueIssueType =
  (typeof AuditDefaultValueIssueType)[keyof typeof AuditDefaultValueIssueType];

/** A problem found while auditing a schema's default values. */
export interface AuditDefaultValueIssue {
  /** The kind of problem found. */
  type: AuditDefaultValueIssueType;
  /** The complete path from the schema element (e.g. `Query.field.arg[1].name`) to the offending value. */
  path: ReadonlyArray<string | number>;
  /** Human-readable description of the problem, including the full path and reason. */
  message: string;
}

/**
 * Converts a custom scalar's default value to a GraphQL literal node.
 *
 * The adapter is the only scalar-specific logic invoked while auditing a
 * default value; a scalar's own `serialize`/`coerce*` methods are never called.
 * @param value - The external runtime value to convert.
 * @param type - The custom scalar type to convert against.
 * @returns A GraphQL literal node, or `undefined` when the value is not a valid default for the scalar.
 */
export type AuditScalarDefaultValueAdapter = (
  value: unknown,
  type: GraphQLScalarType,
) => ConstValueNode | undefined;

/** Options for configuring `auditDefaultValues()`. */
export interface AuditDefaultValuesOptions {
  /**
   * Adapters used to audit default values of custom scalar types, keyed by
   * scalar name.
   *
   * Only scalars with a matching adapter are evaluated; custom scalars without
   * an adapter are reported as `UNKNOWN_SCALAR` and their `serialize`/`coerce*`
   * methods are never invoked.
   */
  scalarAdapters?: Maybe<{
    readonly [key: string]: AuditScalarDefaultValueAdapter;
  }>;
  /**
   * Invoked each time a scalar adapter is called while auditing a default value.
   *
   * This can be used to observe how many custom scalar defaults were audited,
   * for example to assert that no scalar logic ran without an explicit adapter.
   */
  onScalarAudit?: Maybe<(scalar: GraphQLScalarType) => void>;
}

interface AuditContext {
  scalarAdapters: Maybe<{
    readonly [key: string]: AuditScalarDefaultValueAdapter;
  }>;
  onScalarAudit: Maybe<(scalar: GraphQLScalarType) => void>;
  report: (
    type: AuditDefaultValueIssueType,
    path: Path | undefined,
    reason: string,
  ) => void;
}

/**
 * Audits every default value in a read-only way, checking whether each default
 * value can be converted to a valid GraphQL literal for its corresponding input
 * type.
 *
 * All input object fields, field arguments, and directive arguments that define
 * a default value are checked, including values nested within input objects,
 * lists, enums, and non-null types. The complete type/field path and the reason
 * for each problem are returned.
 *
 * Custom scalar types are only evaluated when an explicit adapter is provided
 * via `scalarAdapters`; scalars without an adapter are reported as
 * `UNKNOWN_SCALAR` and their `serialize`/`coerce*` methods are never invoked.
 *
 * Recursive input object types are expanded in step with the actual default
 * value, using a type stack to avoid infinite expansion on cyclic values. The
 * schema, its default values, and the existing `astFromValue()` interface are
 * never modified.
 * @param schema - The GraphQL schema to audit.
 * @param options - Optional configuration, including custom scalar adapters.
 * @returns A list of problems found, each with its type, complete path, and reason.
 * @example
 * ```ts
 * import { buildSchema, auditDefaultValues } from 'graphql/utilities';
 *
 * const schema = buildSchema(`
 *   input ReviewInput {
 *     stars: Int = "bad"
 *   }
 *
 *   type Query {
 *     review(input: ReviewInput): String
 *   }
 * `);
 *
 * const issues = auditDefaultValues(schema);
 *
 * issues.map((issue) => issue.message);
 * // => ['ReviewInput.stars: Expected value of type "Int", found: "bad".']
 * ```
 */
export function auditDefaultValues(
  schema: GraphQLSchema,
  options?: AuditDefaultValuesOptions,
): Array<AuditDefaultValueIssue> {
  const issues: Array<AuditDefaultValueIssue> = [];

  const context: AuditContext = {
    scalarAdapters: options?.scalarAdapters,
    onScalarAudit: options?.onScalarAudit,
    report: (issueType, path, reason) => {
      const pathArray = pathToArray(path);
      issues.push({
        type: issueType,
        path: pathArray,
        message: `${formatPath(pathArray)}: ${reason}`,
      });
    },
  };

  // Audit directive arguments.
  for (const directive of schema.getDirectives()) {
    for (const arg of directive.args) {
      auditElementDefault(arg, ['@' + directive.name, arg.name], context);
    }
  }

  // Audit input object fields and field arguments.
  for (const type of Object.values(schema.getTypeMap())) {
    if (isInputObjectType(type)) {
      for (const field of Object.values(type.getFields())) {
        auditElementDefault(field, [type.name, field.name], context);
      }
    } else if (isObjectType(type) || isInterfaceType(type)) {
      for (const field of Object.values(type.getFields())) {
        for (const arg of field.args) {
          auditElementDefault(arg, [type.name, field.name, arg.name], context);
        }
      }
    }
  }

  return issues;
}

function auditElementDefault(
  element: GraphQLArgument | GraphQLInputField,
  rootPath: ReadonlyArray<string | number>,
  context: AuditContext,
): void {
  const type = element.type;
  const path = pathFromSegments(rootPath);

  const defaultInput = element.default;
  if (defaultInput !== undefined) {
    if (defaultInput.literal !== undefined) {
      auditLiteralDefault(defaultInput.literal, type, context, path, []);
    } else {
      auditValueDefault(defaultInput.value, type, context, path, []);
    }
    return;
  }

  const defaultValue = element.defaultValue;
  if (defaultValue !== undefined) {
    auditValueDefault(defaultValue, type, context, path, []);
  }
}

function auditValueDefault(
  value: unknown,
  type: GraphQLInputType,
  context: AuditContext,
  path: Path | undefined,
  typeStack: Array<{ type: GraphQLInputObjectType; value: unknown }>,
): void {
  if (isNonNullType(type)) {
    if (value === null) {
      reportInvalid(
        context,
        path,
        `Expected value of non-null type "${type}" not to be null, found: ${inspect(
          value,
        )}.`,
      );
      return;
    }
    if (value === undefined) {
      reportInvalid(
        context,
        path,
        `Expected a value of non-null type "${type}" to be provided.`,
      );
      return;
    }
    auditValueDefault(value, type.ofType, context, path, typeStack);
    return;
  }

  // Only explicit null (and undefined, treated like null) is valid for nullable types.
  if (value === null || value === undefined) {
    return;
  }

  if (isListType(type)) {
    if (!isIterableObject(value)) {
      // Lists accept a non-list value as a list of one.
      auditValueDefault(value, type.ofType, context, path, typeStack);
      return;
    }
    let index = 0;
    for (const item of value) {
      auditValueDefault(
        item,
        type.ofType,
        context,
        addPath(path, index++, undefined),
        typeStack,
      );
    }
    return;
  }

  if (isInputObjectType(type)) {
    if (!isObjectLike(value) || Array.isArray(value)) {
      reportInvalid(
        context,
        path,
        `Expected value of type "${type}" to be an object, found: ${inspect(
          value,
        )}.`,
      );
      return;
    }

    if (
      typeStack.some((entry) => entry.type === type && entry.value === value)
    ) {
      // Cyclic value: the value has already been audited at an earlier level.
      return;
    }
    typeStack.push({ type, value });

    const fieldDefs = type.getFields();

    for (const fieldName of Object.keys(value)) {
      const fieldValue = value[fieldName];
      if (fieldValue === undefined) {
        continue;
      }
      if (!Object.hasOwn(fieldDefs, fieldName)) {
        reportInvalid(
          context,
          path,
          `Expected value of type "${type}" not to include unknown field "${fieldName}", found: ${inspect(
            value,
          )}.`,
        );
      }
    }

    for (const field of Object.values(fieldDefs)) {
      const fieldValue = value[field.name];
      if (fieldValue === undefined) {
        if (isRequiredInputField(field)) {
          reportInvalid(
            context,
            addPath(path, field.name, type.name),
            `Expected value of type "${type}" to include required field "${
              field.name
            }", found: ${inspect(value)}.`,
          );
        }
      } else {
        auditValueDefault(
          fieldValue,
          field.type,
          context,
          addPath(path, field.name, type.name),
          typeStack,
        );
      }
    }

    typeStack.pop();
    return;
  }

  if (isEnumType(type)) {
    if (typeof value !== 'string' || type.getValue(value) == null) {
      reportInvalid(
        context,
        path,
        `Expected value of type "${type}" to be an enum value, found: ${inspect(
          value,
        )}.`,
      );
    }
    return;
  }

  auditScalarValue(value, type, context, path);
}

function auditLiteralDefault(
  node: ConstValueNode,
  type: GraphQLInputType,
  context: AuditContext,
  path: Path | undefined,
  typeStack: Array<{ type: GraphQLInputObjectType; node: ConstValueNode }>,
): void {
  if (isNonNullType(type)) {
    if (node.kind === Kind.NULL) {
      reportInvalid(
        context,
        path,
        `Expected value of non-null type "${type}" not to be null, found: ${print(
          node,
        )}.`,
      );
      return;
    }
    auditLiteralDefault(node, type.ofType, context, path, typeStack);
    return;
  }

  if (node.kind === Kind.NULL) {
    return;
  }

  if (isListType(type)) {
    if (node.kind !== Kind.LIST) {
      // Lists accept a non-list value as a list of one.
      auditLiteralDefault(node, type.ofType, context, path, typeStack);
      return;
    }
    let index = 0;
    for (const item of node.values) {
      auditLiteralDefault(
        item,
        type.ofType,
        context,
        addPath(path, index++, undefined),
        typeStack,
      );
    }
    return;
  }

  if (isInputObjectType(type)) {
    if (node.kind !== Kind.OBJECT) {
      reportInvalid(
        context,
        path,
        `Expected value of type "${type}" to be an object, found: ${print(
          node,
        )}.`,
      );
      return;
    }

    if (typeStack.some((entry) => entry.type === type && entry.node === node)) {
      // Cyclic value: the value has already been audited at an earlier level.
      return;
    }
    typeStack.push({ type, node });

    const fieldDefs = type.getFields();
    const fieldNodes = new Map(
      node.fields.map((field) => [field.name.value, field]),
    );

    for (const fieldNode of node.fields) {
      if (!Object.hasOwn(fieldDefs, fieldNode.name.value)) {
        reportInvalid(
          context,
          path,
          `Expected value of type "${type}" not to include unknown field "${
            fieldNode.name.value
          }", found: ${print(node)}.`,
        );
      }
    }

    for (const field of Object.values(fieldDefs)) {
      const fieldNode = fieldNodes.get(field.name);
      if (fieldNode === undefined) {
        if (isRequiredInputField(field)) {
          reportInvalid(
            context,
            addPath(path, field.name, type.name),
            `Expected value of type "${type}" to include required field "${
              field.name
            }", found: ${print(node)}.`,
          );
        }
      } else {
        auditLiteralDefault(
          fieldNode.value,
          field.type,
          context,
          addPath(path, field.name, type.name),
          typeStack,
        );
      }
    }

    typeStack.pop();
    return;
  }

  if (isEnumType(type)) {
    if (node.kind !== Kind.ENUM || type.getValue(node.value) == null) {
      reportInvalid(
        context,
        path,
        `Expected value of type "${type}" to be an enum value, found: ${print(
          node,
        )}.`,
      );
    }
    return;
  }

  auditScalarLiteral(node, type, context, path);
}

function auditScalarValue(
  value: unknown,
  type: GraphQLScalarType,
  context: AuditContext,
  path: Path | undefined,
): void {
  if (isSpecifiedScalarType(type)) {
    if (!specifiedScalarValueMatches(value, type)) {
      reportInvalid(
        context,
        path,
        `Expected value of type "${type}", found: ${inspect(value)}.`,
      );
    }
    return;
  }

  const adapter = context.scalarAdapters?.[type.name];
  if (adapter == null) {
    reportUnknownScalar(
      context,
      path,
      `Cannot audit default value of custom scalar "${type}" without an adapter; provide a scalar adapter to audit this value.`,
    );
    return;
  }

  context.onScalarAudit?.(type);

  let literal: ConstValueNode | undefined;
  try {
    literal = adapter(value, type);
  } catch (error) {
    reportInvalid(
      context,
      path,
      `Scalar adapter for "${type}" threw an error: ${getCaughtErrorMessage(
        error,
      )}.`,
    );
    return;
  }

  if (literal == null) {
    reportInvalid(
      context,
      path,
      `Expected value of type "${type}", found: ${inspect(value)}.`,
    );
  }
}

function auditScalarLiteral(
  node: ConstValueNode,
  type: GraphQLScalarType,
  context: AuditContext,
  path: Path | undefined,
): void {
  if (isSpecifiedScalarType(type)) {
    if (!specifiedScalarLiteralMatches(node, type)) {
      reportInvalid(
        context,
        path,
        `Expected value of type "${type}", found: ${print(node)}.`,
      );
    }
    return;
  }

  const adapter = context.scalarAdapters?.[type.name];
  if (adapter == null) {
    reportUnknownScalar(
      context,
      path,
      `Cannot audit default value of custom scalar "${type}" without an adapter; provide a scalar adapter to audit this value.`,
    );
    return;
  }

  context.onScalarAudit?.(type);

  const value = valueFromASTUntyped(node);

  let literal: ConstValueNode | undefined;
  try {
    literal = adapter(value, type);
  } catch (error) {
    reportInvalid(
      context,
      path,
      `Scalar adapter for "${type}" threw an error: ${getCaughtErrorMessage(
        error,
      )}.`,
    );
    return;
  }

  if (literal == null) {
    reportInvalid(
      context,
      path,
      `Expected value of type "${type}", found: ${print(node)}.`,
    );
  }
}

function specifiedScalarValueMatches(
  value: unknown,
  type: GraphQLScalarType,
): boolean {
  switch (type.name) {
    case 'Int':
      return (
        (typeof value === 'number' &&
          Number.isInteger(value) &&
          Number.isFinite(value)) ||
        typeof value === 'bigint'
      );
    case 'Float':
      return (
        (typeof value === 'number' && Number.isFinite(value)) ||
        typeof value === 'bigint'
      );
    case 'String':
      return typeof value === 'string';
    case 'Boolean':
      return typeof value === 'boolean';
    case 'ID':
      return (
        typeof value === 'string' ||
        typeof value === 'bigint' ||
        (typeof value === 'number' &&
          Number.isInteger(value) &&
          Number.isFinite(value))
      );
    /* node:coverage ignore next 2 */
    default:
      return false;
  }
}

function specifiedScalarLiteralMatches(
  node: ConstValueNode,
  type: GraphQLScalarType,
): boolean {
  switch (type.name) {
    case 'Int':
      return node.kind === Kind.INT;
    case 'Float':
      return node.kind === Kind.INT || node.kind === Kind.FLOAT;
    case 'String':
      return node.kind === Kind.STRING;
    case 'Boolean':
      return node.kind === Kind.BOOLEAN;
    case 'ID':
      return node.kind === Kind.STRING || node.kind === Kind.INT;
    /* node:coverage ignore next 2 */
    default:
      return false;
  }
}

function reportInvalid(
  context: AuditContext,
  path: Path | undefined,
  reason: string,
): void {
  context.report(AuditDefaultValueIssueType.INVALID, path, reason);
}

function reportUnknownScalar(
  context: AuditContext,
  path: Path | undefined,
  reason: string,
): void {
  context.report(AuditDefaultValueIssueType.UNKNOWN_SCALAR, path, reason);
}

function getCaughtErrorMessage(caughtError: unknown): string {
  if (isObjectLike(caughtError)) {
    const message = caughtError.message;
    if (typeof message === 'string' && message !== '') {
      return message;
    }
  }

  return String(caughtError);
}

function pathFromSegments(
  segments: ReadonlyArray<string | number>,
): Path | undefined {
  let path: Path | undefined;
  for (const segment of segments) {
    path = addPath(path, segment, undefined);
  }
  return path;
}

function formatPath(path: ReadonlyArray<string | number>): string {
  let result = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      result += `[${segment}]`;
    } else if (result === '') {
      result = segment;
    } else {
      result += `.${segment}`;
    }
  }
  return result;
}
