/** @category AST Utilities */

import { GraphQLError } from '../error/GraphQLError.ts';

import type {
  DefinitionNode,
  DocumentNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
} from '../language/ast.ts';
import { Kind } from '../language/kinds.ts';

/**
 * Safely merges a collection of ASTs, presumably each from different files,
 * into a single batched AST.
 *
 * Unlike {@link concatAST}, which only concatenates definition arrays, this
 * entry point performs semantic checks on same-named definitions:
 *
 * - **Fragments** with the same name are merged into a single definition only
 *   when they are structurally identical, ignoring their source positions
 *   (`loc`) and descriptions (comments). When their type conditions,
 *   directives, selection sets, or any other structural detail differ, a
 *   {@link GraphQLError} is thrown that reports both source locations.
 * - **Operations** with the same name are always rejected with an independent
 *   error, since a merged document must not contain two operations with the
 *   same name.
 *
 * The returned document owns its own definition nodes: every node is deeply
 * cloned, so the result never shares modifiable arrays (or nested nodes) with
 * the original documents, the original documents are never modified, and
 * definitions are emitted in input order, keeping the first definition when
 * same-named fragments are merged.
 *
 * @param documents - Document ASTs to merge, in priority order.
 * @returns A new document AST containing the merged definitions.
 * @throws {GraphQLError} When same-named fragments conflict or operations share a name.
 * @example
 * ```ts
 * import { parse } from 'graphql/language';
 * import { mergeASTs } from 'graphql/utilities';
 *
 * const document = mergeASTs([
 *   parse('fragment F on User { id }'),
 *   parse('fragment F on User { id }'),
 * ]);
 *
 * document.definitions.length; // => 1
 * ```
 */
export function mergeASTs(
  documents: ReadonlyArray<DocumentNode>,
): DocumentNode {
  const definitions: Array<DefinitionNode> = [];
  const operations = new Map<
    string,
    { documentIndex: number; definition: OperationDefinitionNode }
  >();
  const fragments = new Map<
    string,
    { documentIndex: number; definition: FragmentDefinitionNode }
  >();

  for (
    let documentIndex = 0;
    documentIndex < documents.length;
    documentIndex++
  ) {
    const document = documents[documentIndex];
    for (const definition of document.definitions) {
      switch (definition.kind) {
        case Kind.OPERATION_DEFINITION: {
          const operation = definition as OperationDefinitionNode;
          const operationName = operation.name?.value;
          if (operationName != null) {
            const existing = operations.get(operationName);
            if (existing != null) {
              throw new GraphQLError(
                `Cannot merge operation "${operationName}" from document ${documentIndex + 1}: an operation with the same name already exists in document ${existing.documentIndex + 1}. Operations in a merged document must have unique names.`,
                { nodes: [existing.definition, operation] },
              );
            }
            operations.set(operationName, {
              documentIndex,
              definition: operation,
            });
          }
          definitions.push(cloneASTNode(definition));
          break;
        }
        case Kind.FRAGMENT_DEFINITION: {
          const fragment = definition as FragmentDefinitionNode;
          const fragmentName = fragment.name.value;
          const existing = fragments.get(fragmentName);
          if (existing != null) {
            if (!isSameDefinition(existing.definition, fragment)) {
              throw new GraphQLError(
                `Cannot merge fragment "${fragmentName}" from document ${documentIndex + 1}: it conflicts with a fragment of the same name in document ${existing.documentIndex + 1}. Same-named fragments may only be merged when they are structurally identical (ignoring positions and comments), but their type conditions, directives, or selection sets differ.`,
                { nodes: [existing.definition, fragment] },
              );
            }
            // Identical fragment: keep the first definition and skip this copy.
            break;
          }
          fragments.set(fragmentName, {
            documentIndex,
            definition: fragment,
          });
          definitions.push(cloneASTNode(definition));
          break;
        }
        default:
          definitions.push(cloneASTNode(definition));
      }
    }
  }

  return { kind: Kind.DOCUMENT, definitions };
}

/**
 * Returns true when two definitions are structurally identical, ignoring
 * source positions (`loc`) and descriptions (comments).
 */
function isSameDefinition(a: DefinitionNode, b: DefinitionNode): boolean {
  return deepEqual(a, b);
}

const IGNORED_KEYS = new Set(['loc', 'description']);

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (
    a == null ||
    b == null ||
    typeof a !== 'object' ||
    typeof b !== 'object'
  ) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) {
    return false;
  }
  const aKeys = Object.keys(a).filter((key) => !IGNORED_KEYS.has(key));
  const bKeys = Object.keys(b).filter((key) => !IGNORED_KEYS.has(key));
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) => deepEqual(a[key], b[key]));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value != null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Deeply clones an AST node so that the returned document never shares
 * modifiable arrays (or nested nodes) with the original documents. Immutable
 * location metadata (`loc`, including its tokens and source) is shared.
 */
function cloneASTNode<T>(node: T): T {
  return cloneValue(node) as T;
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (isPlainObject(value)) {
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      clone[key] = cloneValue(value[key]);
    }
    return clone;
  }
  return value;
}
