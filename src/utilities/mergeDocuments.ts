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
 * Provided a collection of ASTs, presumably each from different files, safely
 * merge them together into a single document AST.
 *
 * Unlike `concatAST`, which blindly concatenates the definitions of every
 * document, `mergeDocuments` performs a semantic check on colliding names
 * before merging:
 *
 * - Fragment definitions with the same name are merged into a single
 *   definition only when they are structurally identical, ignoring source
 *   locations and comments. If the type condition, directives, or selection
 *   content differ in any way (including whitespace inside string literals),
 *   a `GraphQLError` is thrown reporting the locations of both definitions.
 * - Operation definitions with the same name are always rejected as an
 *   independent error, even when their contents are identical, since an
 *   operation name must unambiguously identify a single operation.
 *
 * The returned document preserves the execution order of the input documents
 * and the first definition of each fragment. Every definition in the returned
 * document is a deep copy, so no mutable arrays are shared with the input
 * documents and the input documents are left unchanged.
 * @param documents - Document ASTs to merge.
 * @returns A document AST containing the merged definitions.
 * @throws GraphQLError - When two fragments share a name but differ structurally, or when two operations share a name.
 * @example
 * ```ts
 * import { parse, print } from 'graphql/language';
 * import { mergeDocuments } from 'graphql/utilities';
 *
 * const docA = parse(`
 *   query GetUser { viewer { ...UserFields } }
 *   fragment UserFields on User { id }
 * `);
 * const docB = parse(`
 *   fragment UserFields on User { id }
 * `);
 *
 * const merged = mergeDocuments([docA, docB]);
 *
 * print(merged);
 * // query GetUser { viewer { ...UserFields } }
 * // fragment UserFields on User { id }
 * ```
 */
export function mergeDocuments(
  documents: ReadonlyArray<DocumentNode>,
): DocumentNode {
  const fragmentDefinitions = new Map<string, FragmentDefinitionNode>();
  const operationDefinitions = new Map<string, OperationDefinitionNode>();
  const definitions: Array<DefinitionNode> = [];

  for (const document of documents) {
    for (const definition of document.definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        const name = definition.name.value;
        const existing = fragmentDefinitions.get(name);
        if (existing !== undefined) {
          if (!astNodesEqual(existing, definition)) {
            throw new GraphQLError(
              `Cannot merge documents: fragment "${name}" is defined more than once with different structures.`,
              { nodes: [existing, definition] },
            );
          }
          // Structurally identical fragment: keep only the first definition.
          continue;
        }
        const cloned = cloneNode(definition);
        fragmentDefinitions.set(name, cloned);
        definitions.push(cloned);
      } else if (
        definition.kind === Kind.OPERATION_DEFINITION &&
        definition.name !== undefined
      ) {
        const name = definition.name.value;
        const existing = operationDefinitions.get(name);
        if (existing !== undefined) {
          throw new GraphQLError(
            `Cannot merge documents: operation "${name}" is defined more than once.`,
            { nodes: [existing, definition] },
          );
        }
        const cloned = cloneNode(definition);
        operationDefinitions.set(name, cloned);
        definitions.push(cloned);
      } else {
        definitions.push(cloneNode(definition));
      }
    }
  }

  return { kind: Kind.DOCUMENT, definitions };
}

// Compares two AST structures for semantic equality, ignoring source
// locations and comments. Literal values (including whitespace inside string
// literals) are compared exactly.
function astNodesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => astNodesEqual(item, b[index]))
    );
  }
  if (isASTNodeLike(a) && isASTNodeLike(b)) {
    if (a.kind !== b.kind) {
      return false;
    }
    for (const key of Object.keys(a)) {
      if (key === 'kind' || key === 'loc') {
        continue;
      }
      if (
        !astNodesEqual(
          (a as { [key: string]: unknown })[key],
          (b as { [key: string]: unknown })[key],
        )
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

// Deep-copies an AST definition so the merged document shares no mutable
// arrays (or nodes) with the input documents. Source locations are immutable
// metadata and are shared by reference.
function cloneNode<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(cloneNode) as T;
  }
  if (isASTNodeLike(value)) {
    const copy: { [key: string]: unknown } = {};
    for (const key of Object.keys(value)) {
      copy[key] =
        key === 'loc'
          ? (value as { [key: string]: unknown })[key]
          : cloneNode((value as { [key: string]: unknown })[key]);
    }
    return copy as T;
  }
  return value;
}

function isASTNodeLike(
  value: unknown,
): value is { kind: string } & { [key: string]: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === 'string'
  );
}
