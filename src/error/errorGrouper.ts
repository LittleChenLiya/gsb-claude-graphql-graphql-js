/** @category Errors */

import type { SourceLocation } from '../language/location.ts';

import type { GraphQLError } from './GraphQLError.ts';

/**
 * Coarse classification of what caused a {@link GraphQLError}, derived
 * read-only from the error itself without re-executing the operation:
 *
 * - `'resolver'`: the error carries an underlying cause (typically thrown or
 *   rejected by application code such as a field resolver).
 * - `'execution'`: the error has a response path but no underlying cause
 *   (produced by the executor itself, for example non-null propagation).
 * - `'request'`: the error has neither a response path nor an underlying
 *   cause (for example parse, validation, or variable coercion errors).
 * @category Errors
 */
export type GraphQLErrorCauseCategory = 'resolver' | 'execution' | 'request';

/**
 * Classifies a {@link GraphQLError} into a {@link GraphQLErrorCauseCategory}
 * using only the error's own `cause`, `originalError`, and `path` properties.
 * The error is only read, never modified, and no query is re-executed.
 * @param error - The GraphQL error to classify.
 * @returns The cause category of the error.
 * @example
 * ```ts
 * import { GraphQLError, categorizeGraphQLError } from 'graphql/error';
 *
 * const error = new GraphQLError('Resolver failed.', {
 *   path: ['greeting'],
 *   cause: new Error('Database unavailable.'),
 * });
 *
 * categorizeGraphQLError(error); // => 'resolver'
 * ```
 */
export function categorizeGraphQLError(
  error: GraphQLError,
): GraphQLErrorCauseCategory {
  if (error.cause != null || error.originalError != null) {
    return 'resolver';
  }
  return error.path == null ? 'request' : 'execution';
}

/** Options accepted by {@link groupGraphQLErrors}. */
export interface GroupGraphQLErrorsOptions {
  /**
   * Label of the operation that produced the errors, typically the operation
   * name (or the operation type for anonymous operations). All errors passed
   * to a single call are assumed to come from the same executed operation.
   * @defaultValue 'anonymous'
   */
  readonly operation?: string;
  /**
   * When `true`, the produced events omit the original message text
   * (`event.message` is `undefined`) while the response path, source
   * locations, and cause category are still reported. The original error
   * objects are never rewritten; masking only affects the grouping output.
   * @defaultValue false
   */
  readonly maskMessages?: boolean;
}

/**
 * A single error occurrence inside a {@link GraphQLErrorGroup}. Events keep
 * a reference to the original, unmodified {@link GraphQLError} and preserve
 * the order in which the errors were produced during execution.
 * @category Errors
 */
export interface GraphQLErrorEvent {
  /** Position of the error in the original errors array. */
  readonly index: number;
  /** The original error, passed through by reference and never rewritten. */
  readonly error: GraphQLError;
  /**
   * Response path of the error, copied verbatim from `error.path`. Response
   * aliases and array indices are preserved as-is and are never replaced by
   * schema field names.
   */
  readonly path: ReadonlyArray<string | number> | undefined;
  /** Source document locations of the original error. */
  readonly locations: ReadonlyArray<SourceLocation> | undefined;
  /** Cause category of the error. */
  readonly category: GraphQLErrorCauseCategory;
  /**
   * Message of the original error, or `undefined` when the grouping was
   * produced with `maskMessages: true`.
   */
  readonly message: string | undefined;
}

/**
 * A read-only group of {@link GraphQLErrorEvent}s that share the same
 * operation, response path, and cause category. Groups are returned in the
 * order their first event appeared in the original errors array.
 * @category Errors
 */
export interface GraphQLErrorGroup {
  /** Operation label shared by every event in this group. */
  readonly operation: string;
  /** Cause category shared by every event in this group. */
  readonly category: GraphQLErrorCauseCategory;
  /** Response path shared by every event in this group. */
  readonly path: ReadonlyArray<string | number> | undefined;
  /** Number of events in this group. */
  readonly count: number;
  /** Events in this group, in original execution error order. */
  readonly events: ReadonlyArray<GraphQLErrorEvent>;
}

interface MutableGroup {
  readonly operation: string;
  readonly category: GraphQLErrorCauseCategory;
  readonly path: ReadonlyArray<string | number> | undefined;
  readonly events: Array<GraphQLErrorEvent>;
}

/**
 * Groups GraphQL errors by operation, response path, and cause category
 * without modifying them.
 *
 * The grouper is strictly read-only: it never re-executes the query, never
 * rewrites the original errors, and keeps each original {@link GraphQLError}
 * (including its `locations`) reachable via `event.error`. Response paths are
 * used exactly as reported, so response aliases and array indices are
 * preserved and are never replaced by schema field names. Errors with the
 * same cause that occurred at different response paths (for example the same
 * resolver failing under two different aliases, or at array indices 0 and 1)
 * remain distinct events in distinct groups.
 *
 * Groups are ordered by first appearance in the original errors array, and
 * events within a group keep the original execution error order. When
 * `maskMessages` is enabled, the grouping output omits the message text but
 * still reports the response path and cause category of every event.
 * @param errors - The GraphQL errors of a single executed operation, in
 *   their original execution order.
 * @param options - Grouping options, see {@link GroupGraphQLErrorsOptions}.
 * @returns The grouped errors, ordered by first appearance.
 * @example
 * ```ts
 * import { groupGraphQLErrors } from 'graphql/error';
 *
 * // Given `result` produced by an earlier execution:
 * const groups = groupGraphQLErrors(result.errors ?? [], {
 *   operation: 'MyQuery',
 *   maskMessages: true,
 * });
 *
 * for (const group of groups) {
 *   console.log(group.operation, group.category, group.path, group.count);
 * }
 * ```
 */
export function groupGraphQLErrors(
  errors: ReadonlyArray<GraphQLError>,
  options: GroupGraphQLErrorsOptions = {},
): ReadonlyArray<GraphQLErrorGroup> {
  const { operation = 'anonymous', maskMessages = false } = options;

  const groups: Array<MutableGroup> = [];
  const groupsByKey = new Map<string, MutableGroup>();

  errors.forEach((error, index) => {
    const category = categorizeGraphQLError(error);
    const path =
      error.path === undefined ? undefined : Object.freeze([...error.path]);
    const key = JSON.stringify([operation, category, path ?? null]);

    let group = groupsByKey.get(key);
    if (group === undefined) {
      group = { operation, category, path, events: [] };
      groupsByKey.set(key, group);
      groups.push(group);
    }

    group.events.push(
      Object.freeze({
        index,
        error,
        path,
        locations: error.locations,
        category,
        message: maskMessages ? undefined : error.message,
      }),
    );
  });

  return groups.map((group) =>
    Object.freeze({
      operation: group.operation,
      category: group.category,
      path: group.path,
      count: group.events.length,
      events: Object.freeze([...group.events]),
    }),
  );
}
