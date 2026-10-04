/**
 * Null-bubbling diagnostics.
 *
 * When an optional null-bubbling diagnostic is enabled, GraphQL execution
 * records the chain of response positions that are set to null because a
 * non-nullable field failed. The chain is built from the actual
 * `completeValue` traversal (resolvers are never re-invoked to explain a
 * result) and is exposed as an independent extension on the execution
 * result.
 *
 * Each entry records the response alias path of the nulled position and the
 * wrapper type at that position. The chain starts at the failing non-null
 * field, continues through list elements and parent fields, and stops at the
 * first nullable position (or the root response).
 *
 * @internal
 */

import type { GraphQLError } from '../error/GraphQLError.ts';

/** A single position in a null-bubbling propagation chain. */
/** @internal */
export interface NullBubblingEntry {
  /** Response alias path of the nulled position, from root to leaf. */
  path: ReadonlyArray<string | number>;
  /**
   * Wrapper type at this position (e.g. `String!`, `[User!]!`), or `null`
   * for the root response when the entire data payload is nulled.
   */
  type: string | null;
}

/**
 * The propagation chain of a single non-null field failure, ordered from
 * the failing field outward to the first nullable position (or root).
 */
/** @internal */
export type NullBubblingChain = Array<NullBubblingEntry>;

const NULL_BUBBLING_CHAIN: unique symbol = Symbol('nullBubblingChain');

/**
 * Returns the propagation chain attached to a located error, if one exists.
 *
 * @internal
 */
export function getNullBubblingChain(
  error: GraphQLError,
): NullBubblingChain | undefined {
  return (error as { [NULL_BUBBLING_CHAIN]?: NullBubblingChain })[
    NULL_BUBBLING_CHAIN
  ];
}

/**
 * Attaches a propagation chain to a located error so it travels with the
 * error as it bubbles up through the `completeValue` chain.
 *
 * @internal
 */
export function setNullBubblingChain(
  error: GraphQLError,
  chain: NullBubblingChain,
): void {
  Object.defineProperty(error, NULL_BUBBLING_CHAIN, {
    value: chain,
    enumerable: false,
    writable: true,
    configurable: true,
  });
}
