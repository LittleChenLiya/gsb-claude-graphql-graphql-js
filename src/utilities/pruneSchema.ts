/** @category Schema Construction */

import type { Maybe } from '../jsutils/Maybe.ts';
import type { ObjMap } from '../jsutils/ObjMap.ts';

import type { ConstDirectiveNode } from '../language/ast.ts';

import type {
  GraphQLArgumentConfig,
  GraphQLField,
  GraphQLFieldConfig,
  GraphQLNamedType,
  GraphQLObjectType as GraphQLObjectTypeType,
  GraphQLType,
} from '../type/definition.ts';
import {
  getNamedType,
  GraphQLObjectType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isUnionType,
} from '../type/definition.ts';
import type { GraphQLDirective } from '../type/directives.ts';
import { isSpecifiedDirective } from '../type/directives.ts';
import { GraphQLSchema } from '../type/schema.ts';

/**
 * Options for {@link pruneSchema}, listing the root operation fields to
 * retain. Omitting an operation keeps its root type untouched, while an
 * empty list removes that root type from the pruned schema.
 */
export interface PruneSchemaOptions {
  /** Names of the fields to retain on the query root type. */
  query?: ReadonlyArray<string>;
  /** Names of the fields to retain on the mutation root type. */
  mutation?: ReadonlyArray<string>;
  /** Names of the fields to retain on the subscription root type. */
  subscription?: ReadonlyArray<string>;
}

/**
 * Prune a GraphQLSchema down to a selected set of root operation fields.
 *
 * Only the entry points of the query, mutation, and subscription root types
 * are filtered. Every type reachable from the retained fields is carried over
 * in full: object and interface types keep all of their fields, interfaces
 * keep all of their possible types, unions keep all of their member types,
 * and input objects keep all of their input fields. Field default values,
 * enum values, descriptions, deprecation reasons, and the definitions of the
 * directives used by the retained types are preserved.
 *
 * The original schema is left unmodified and no resolvers are executed.
 * @param schema - GraphQL schema to prune.
 * @param options - Root operation fields to retain, per operation type.
 * @returns A new GraphQLSchema containing only the selected entry points and
 * the types they depend on.
 * @example
 * ```ts
 * import { buildSchema, pruneSchema } from 'graphql/utilities';
 *
 * const schema = buildSchema(`
 *   type Query {
 *     user: User
 *     admin: Admin
 *   }
 *
 *   type User {
 *     name: String
 *   }
 *
 *   type Admin {
 *     level: Int
 *   }
 * `);
 *
 * const prunedSchema = pruneSchema(schema, { query: ['user'] });
 *
 * printSchema(prunedSchema);
 * // =>
 * // type Query {
 * //   user: User
 * // }
 * //
 * // type User {
 * //   name: String
 * // }
 * ```
 */
export function pruneSchema(
  schema: GraphQLSchema,
  options: PruneSchemaOptions = {},
): GraphQLSchema {
  const queryType = pruneRootType(
    'query',
    schema.getQueryType(),
    options.query,
  );
  const mutationType = pruneRootType(
    'mutation',
    schema.getMutationType(),
    options.mutation,
  );
  const subscriptionType = pruneRootType(
    'subscription',
    schema.getSubscriptionType(),
    options.subscription,
  );

  if (queryType == null) {
    throw new Error(
      'Cannot prune schema: the pruned schema must retain at least one field ' +
        'on the query root type.',
    );
  }

  const rootTypes = [queryType, mutationType, subscriptionType].filter(
    (type) => type != null,
  );
  const typeSet = collectReferencedTypes(schema, rootTypes);

  // Keep the built-in directives along with every custom directive that is
  // applied to a retained schema element, then include the types referenced
  // by the arguments of those directives. This may take multiple passes
  // since directive arguments can pull in additional types.
  let directives: ReadonlyArray<GraphQLDirective>;
  let typeCount: number;
  do {
    typeCount = typeSet.size;
    const usedDirectiveNames = collectUsedDirectiveNames(typeSet);
    directives = schema
      .getDirectives()
      .filter(
        (directive) =>
          isSpecifiedDirective(directive) ||
          usedDirectiveNames.has(directive.name),
      );
    for (const directive of directives) {
      for (const arg of directive.args) {
        collectType(schema, typeSet, arg.type);
      }
    }
  } while (typeSet.size !== typeCount);

  return new GraphQLSchema({
    description: schema.description,
    query: queryType,
    mutation: mutationType,
    subscription: subscriptionType,
    types: [...typeSet],
    directives,
    extensions: schema.extensions,
  });
}

function pruneRootType(
  operation: string,
  rootType: GraphQLObjectTypeType | null | undefined,
  fieldNames: ReadonlyArray<string> | undefined,
): GraphQLObjectTypeType | undefined {
  if (fieldNames === undefined) {
    return rootType ?? undefined;
  }
  if (rootType == null) {
    if (fieldNames.length === 0) {
      return undefined;
    }
    throw new Error(
      'Cannot prune schema: the schema does not define a ' +
        operation +
        ' root type, but fields were provided: ' +
        quoteNames(fieldNames) +
        '.',
    );
  }

  const fields = rootType.getFields();
  const unknownFields = fieldNames.filter(
    (name) => !Object.hasOwn(fields, name),
  );
  if (unknownFields.length > 0) {
    throw new Error(
      'Cannot prune schema: unknown ' +
        operation +
        ' root field(s) ' +
        quoteNames(unknownFields) +
        ' on type "' +
        rootType.name +
        '".',
    );
  }
  if (fieldNames.length === 0) {
    return undefined;
  }

  const prunedFields: ObjMap<GraphQLFieldConfig<unknown, unknown>> = {};
  for (const name of fieldNames) {
    prunedFields[name] = fieldToConfig(fields[name]);
  }

  // The AST nodes of the original root type are intentionally not carried
  // over since they still describe the unfiltered set of fields.
  return new GraphQLObjectType({
    name: rootType.name,
    description: rootType.description,
    interfaces: rootType.getInterfaces(),
    fields: prunedFields,
    isTypeOf: rootType.isTypeOf,
    extensions: rootType.extensions,
  });
}

function fieldToConfig(
  field: GraphQLField<unknown, unknown>,
): GraphQLFieldConfig<unknown, unknown> {
  const args: ObjMap<GraphQLArgumentConfig> = {};
  for (const arg of field.args) {
    args[arg.name] = arg;
  }
  return {
    description: field.description,
    type: field.type,
    args,
    resolve: field.resolve,
    subscribe: field.subscribe,
    deprecationReason: field.deprecationReason,
    extensions: field.extensions,
    astNode: field.astNode,
  };
}

function collectReferencedTypes(
  schema: GraphQLSchema,
  rootTypes: ReadonlyArray<GraphQLObjectTypeType>,
): Set<GraphQLNamedType> {
  const typeSet = new Set<GraphQLNamedType>();
  for (const rootType of rootTypes) {
    collectType(schema, typeSet, rootType);
  }
  return typeSet;
}

function collectType(
  schema: GraphQLSchema,
  typeSet: Set<GraphQLNamedType>,
  type: GraphQLType,
): void {
  const namedType = getNamedType(type);
  if (typeSet.has(namedType)) {
    return;
  }
  typeSet.add(namedType);

  if (isObjectType(namedType) || isInterfaceType(namedType)) {
    for (const interfaceType of namedType.getInterfaces()) {
      collectType(schema, typeSet, interfaceType);
    }
    for (const field of Object.values(namedType.getFields())) {
      collectType(schema, typeSet, field.type);
      for (const arg of field.args) {
        collectType(schema, typeSet, arg.type);
      }
    }
    if (isInterfaceType(namedType)) {
      // Retaining an interface requires retaining all of its possible types,
      // otherwise the interface contract would be silently narrowed.
      for (const possibleType of schema.getPossibleTypes(namedType)) {
        collectType(schema, typeSet, possibleType);
      }
    }
  } else if (isUnionType(namedType)) {
    for (const memberType of namedType.getTypes()) {
      collectType(schema, typeSet, memberType);
    }
  } else if (isInputObjectType(namedType)) {
    for (const inputField of Object.values(namedType.getFields())) {
      collectType(schema, typeSet, inputField.type);
    }
  }
}

function collectUsedDirectiveNames(
  typeSet: ReadonlySet<GraphQLNamedType>,
): Set<string> {
  const usedNames = new Set<string>();
  const collectFromNode = (
    node: Maybe<{
      directives?: ReadonlyArray<ConstDirectiveNode> | undefined;
    }>,
  ): void => {
    if (node?.directives != null) {
      for (const directive of node.directives) {
        usedNames.add(directive.name.value);
      }
    }
  };

  for (const type of typeSet) {
    collectFromNode(type.astNode);
    for (const extensionNode of type.extensionASTNodes) {
      collectFromNode(extensionNode);
    }
    if (isObjectType(type) || isInterfaceType(type)) {
      for (const field of Object.values(type.getFields())) {
        collectFromNode(field.astNode);
        for (const arg of field.args) {
          collectFromNode(arg.astNode);
        }
      }
    } else if (isEnumType(type)) {
      for (const value of type.getValues()) {
        collectFromNode(value.astNode);
      }
    } else if (isInputObjectType(type)) {
      for (const inputField of Object.values(type.getFields())) {
        collectFromNode(inputField.astNode);
      }
    }
  }
  return usedNames;
}

function quoteNames(names: ReadonlyArray<string>): string {
  return names.map((name) => '"' + name + '"').join(', ');
}
