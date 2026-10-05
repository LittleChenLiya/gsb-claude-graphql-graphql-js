/** @category Errors */

import type { SourceLocation } from '../language/location.ts';

import type {
  GraphQLError,
  GraphQLErrorExtensions,
} from './GraphQLError.ts';

/**
 * A read-only grouping of {@link GraphQLError}s that share the same operation,
 * response path, and reason category.
 *
 * The original errors are preserved verbatim and are never rewritten. The
 * response path keeps alias names and list indices exactly as they appeared in
 * the execution result; they are never replaced by schema field names.
 */
export interface GraphQLErrorGroup {
  /** The operation identifier shared by every error in this group. */
  readonly operation: string | undefined;
  /**
   * The response path shared by every error in this group. Alias names and
   * list indices are preserved verbatim and are never replaced by schema
   * field names.
   */
  readonly path: ReadonlyArray<string | number> | undefined;
  /** The reason category shared by every error in this group. */
  readonly category: string;
  /**
   * The errors in this group, in the original execution order. Two errors with
   * the same cause but different paths (or locations) are kept as separate
   * events.
   */
  readonly errors: ReadonlyArray<GraphQLError>;
}

/** Options for {@link groupGraphQLErrors}. */
export interface GroupGraphQLErrorsOptions {
  /**
   * Operation identifier to associate with every error. When omitted, all
   * errors are grouped under an `undefined` operation.
   */
  readonly operation?: string | undefined;
  /**
   * Derives a reason category from an error. Defaults to reading the string
   * `extensions.code` or `'INTERNAL'` when no code is present.
   */
  readonly getCategory?: ((error: GraphQLError) => string) | undefined;
}

/**
 * A JSON-serializable representation of a single grouped error event.
 */
export interface FormattedGraphQLErrorEvent {
  /**
   * The original error message. Omitted when formatting in occlusion mode so
   * that message text is never leaked.
   */
  readonly message?: string;
  /** The locations preserved from the original error. */
  readonly locations?: ReadonlyArray<SourceLocation>;
  /** The response path preserved from the original error. */
  readonly path?: ReadonlyArray<string | number>;
  /** The extensions preserved from the original error. */
  readonly extensions?: GraphQLErrorExtensions;
}

/**
 * A JSON-serializable representation of a {@link GraphQLErrorGroup}.
 */
export interface FormattedGraphQLErrorGroup {
  /** The operation identifier shared by every event in this group. */
  readonly operation: string | undefined;
  /** The response path shared by every event in this group. */
  readonly path: ReadonlyArray<string | number> | undefined;
  /** The reason category shared by every event in this group. */
  readonly category: string;
  /** The events in this group, in original execution order. */
  readonly events: ReadonlyArray<FormattedGraphQLErrorEvent>;
}

/** Options for {@link formatGroupedErrors}. */
export interface FormatGroupedErrorsOptions {
  /**
   * When `true`, the original error message text is omitted from every event
   * while the response path and reason category are preserved. Defaults to
   * `false`.
   */
  readonly redact?: boolean | undefined;
}

const DEFAULT_CATEGORY = 'INTERNAL';

function defaultGetCategory(error: GraphQLError): string {
  const code = error.extensions?.code;
  return typeof code === 'string' ? code : DEFAULT_CATEGORY;
}

/**
 * Groups the given {@link GraphQLError}s by operation, response path, and
 * reason category without mutating the errors.
 *
 * The response path is used verbatim: alias names and list indices are
 * preserved and are never replaced by schema field names. Two errors with the
 * same cause but different paths (or locations) are kept as separate events.
 * Groups are ordered by the first occurrence of their key in the original
 * errors array, so the grouping order follows the original execution order.
 * @param errors - The errors to group.
 * @param options - Grouping options.
 * @returns The grouped errors, in original execution order.
 * @example
 * ```ts
 * import { GraphQLError } from 'graphql/error';
 * import { groupGraphQLErrors } from 'graphql/error';
 *
 * const errors = [
 *   new GraphQLError('boom', { path: ['first'], extensions: { code: 'INTERNAL' } }),
 *   new GraphQLError('boom', { path: ['second'], extensions: { code: 'INTERNAL' } }),
 * ];
 *
 * const groups = groupGraphQLErrors(errors, { operation: 'Demo' });
 * // => [
 * //   { operation: 'Demo', path: ['first'], category: 'INTERNAL', errors: [error] },
 * //   { operation: 'Demo', path: ['second'], category: 'INTERNAL', errors: [error] },
 * // ]
 * ```
 */
export function groupGraphQLErrors(
  errors: ReadonlyArray<GraphQLError>,
  options?: GroupGraphQLErrorsOptions,
): Array<GraphQLErrorGroup> {
  const operation = options?.operation;
  const getCategory = options?.getCategory ?? defaultGetCategory;

  const groups: Array<GraphQLErrorGroup> = [];
  const indexByKey = new Map<string, number>();

  for (const error of errors) {
    const category = getCategory(error);
    const path = error.path;
    const key = groupKey(operation, path, category);

    let index = indexByKey.get(key);
    if (index === undefined) {
      index = groups.length;
      indexByKey.set(key, index);
      groups.push({
        operation,
        path,
        category,
        errors: [error],
      });
    } else {
      (groups[index].errors as Array<GraphQLError>).push(error);
    }
  }

  return groups;
}

/**
 * Produces a JSON-serializable representation of the given grouped errors.
 *
 * In occlusion mode (`redact: true`), the original error message text is
 * omitted from every event while the response path and reason category are
 * preserved. The original errors are never rewritten.
 * @param groups - The grouped errors to format.
 * @param options - Formatting options.
 * @returns The formatted groups.
 * @example
 * ```ts
 * import { formatGroupedErrors, groupGraphQLErrors } from 'graphql/error';
 *
 * const groups = groupGraphQLErrors(errors);
 * const redacted = formatGroupedErrors(groups, { redact: true });
 * // => [{ operation, path, category, events: [{ locations, path, extensions }] }]
 * ```
 */
export function formatGroupedErrors(
  groups: ReadonlyArray<GraphQLErrorGroup>,
  options?: FormatGroupedErrorsOptions,
): Array<FormattedGraphQLErrorGroup> {
  const redact = options?.redact ?? false;

  return groups.map((group) => ({
    operation: group.operation,
    path: group.path,
    category: group.category,
    events: group.errors.map((error) => formatEvent(error, redact)),
  }));
}

function formatEvent(
  error: GraphQLError,
  redact: boolean,
): FormattedGraphQLErrorEvent {
  return {
    ...(!redact ? { message: error.message } : {}),
    ...(error.locations != null ? { locations: error.locations } : {}),
    ...(error.path != null ? { path: error.path } : {}),
    ...(error.extensions != null && Object.keys(error.extensions).length > 0
      ? { extensions: error.extensions }
      : {}),
  };
}

function groupKey(
  operation: string | undefined,
  path: ReadonlyArray<string | number> | undefined,
  category: string,
): string {
  return [
    JSON.stringify(operation ?? null),
    path == null ? '' : pathKey(path),
    JSON.stringify(category),
  ].join('|');
}

function pathKey(path: ReadonlyArray<string | number>): string {
  // JSON.stringify each segment so that alias names and list indices are
  // preserved verbatim and cannot collide with schema field names or each
  // other (e.g. alias '0' vs index 0).
  return path.map((segment) => JSON.stringify(segment)).join('\u0000');
}
