/** @category Validation */

import type { GraphQLError } from '../error/GraphQLError.ts';

import type {
  ArgumentNode,
  ASTNode,
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  ObjectFieldNode,
  OperationDefinitionNode,
  SelectionSetNode,
  VariableDefinitionNode,
} from '../language/ast.ts';
import { Kind } from '../language/kinds.ts';
import type { SourceLocation } from '../language/location.ts';
import { parse } from '../language/parser.ts';
import { visit } from '../language/visitor.ts';

import type {
  GraphQLCompositeType,
  GraphQLField,
  GraphQLInputType,
  GraphQLNamedType,
} from '../type/definition.ts';
import {
  getNamedType,
  isEnumType,
  isInputObjectType,
} from '../type/definition.ts';
import type { GraphQLSchema } from '../type/schema.ts';

import { TypeInfo, visitWithTypeInfo } from '../utilities/TypeInfo.ts';
import { typeFromAST } from '../utilities/typeFromAST.ts';

import { specifiedRules } from './specifiedRules.ts';
import { validate } from './validate.ts';
import type { ValidationRule } from './ValidationContext.ts';

/**
 * A named operation document to include in a schema upgrade check.
 *
 * The document may contain additional operations and fragments; only the
 * operation selected by `name` and the fragments it (transitively) spreads
 * are checked, so a fragment shared by many operations is attributed to each
 * operation that uses it.
 * @category Validation
 */
export interface NamedOperationDocument {
  /** Name of the operation within `document` to check. */
  readonly name: string;
  /** GraphQL source text or parsed document containing the named operation. */
  readonly document: string | DocumentNode;
}

/**
 * Outcome of checking a single operation against a pair of schemas.
 *
 * - `valid`: the operation validates against both schemas.
 * - `regressed`: the operation validated against the old schema but fails
 *   against the new schema.
 * - `previouslyInvalid`: the operation already failed validation against the
 *   old schema, so none of its errors are upgrade regressions.
 * @category Validation
 */
export type OperationUpgradeStatus =
  | 'valid'
  | 'regressed'
  | 'previouslyInvalid';

/**
 * A single validation problem located within a named operation, annotated
 * with the rule that reported it and the printed shape of the involved
 * schema element (field signature, argument, input field, or input type) in
 * the old and new schemas.
 * @category Validation
 */
export interface UpgradeDiagnostic {
  /** Name of the operation this diagnostic is attributed to. */
  readonly operationName: string;
  /** Name of the validation rule that reported this diagnostic. */
  readonly rule: string;
  /** Human readable description of the problem. */
  readonly message: string;
  /** Source locations of the offending field, argument, variable, or value. */
  readonly locations: ReadonlyArray<SourceLocation>;
  /** Printed shape of the involved schema element in the old schema. */
  readonly oldType: string | undefined;
  /** Printed shape of the involved schema element in the new schema. */
  readonly newType: string | undefined;
}

/**
 * Result of checking one named operation against an old and a new schema.
 * @category Validation
 */
export interface OperationUpgradeResult {
  /** Name of the checked operation. */
  readonly name: string;
  /** Outcome of the upgrade check for this operation. */
  readonly status: OperationUpgradeStatus;
  /** Incompatibilities introduced by the schema upgrade. */
  readonly diagnostics: ReadonlyArray<UpgradeDiagnostic>;
  /** Problems that already existed when validating against the old schema. */
  readonly preExistingDiagnostics: ReadonlyArray<UpgradeDiagnostic>;
}

/**
 * Aggregated result of a schema upgrade check.
 * @category Validation
 */
export interface SchemaUpgradeReport {
  /** Per-operation results, in the same order as the input operations. */
  readonly operations: ReadonlyArray<OperationUpgradeResult>;
  /** All newly introduced incompatibilities, in input operation order. */
  readonly regressions: ReadonlyArray<UpgradeDiagnostic>;
  /** All problems that already existed under the old schema, in input order. */
  readonly preExisting: ReadonlyArray<UpgradeDiagnostic>;
}

/**
 * Options accepted by `checkSchemaUpgrade`.
 * @category Validation
 */
export interface SchemaUpgradeOptions {
  /**
   * Validation rules applied to each operation; defaults to all rules
   * defined by the GraphQL specification.
   */
  readonly rules?: ReadonlyArray<ValidationRule>;
}

/**
 * Checks a set of named operations against an old and a new schema and
 * reports only the incompatibilities introduced by the upgrade.
 *
 * Every operation is validated twice: once against the old schema and once
 * against the new schema. Operations that already fail validation against
 * the old schema are reported as `previouslyInvalid` and are never counted
 * as new regressions. Operations that validate against the old schema but
 * fail against the new schema are reported as `regressed`, with one
 * diagnostic per validation error. Each diagnostic names the operation, the
 * validation rule, the source locations of the offending field, argument,
 * variable, or value, and the printed shape of the involved schema element
 * in both schemas.
 *
 * The check is purely static: it parses and validates documents but never
 * executes them, so no field resolver is ever called.
 *
 * Covered schema changes include (among others) newly required arguments,
 * removed arguments, changed field return types, removed fields, narrowed
 * enums, removed or newly required input object fields, and invalid variable
 * default values.
 * @param oldSchema - The schema the operations were written against.
 * @param newSchema - The upgraded schema the operations are checked against.
 * @param operations - Named operation documents to check, processed in order.
 * @param options - Options such as a custom list of validation rules.
 * @returns A report of regressions and pre-existing problems.
 * @example
 * ```ts
 * import { buildSchema } from 'graphql/utilities';
 * import { checkSchemaUpgrade } from 'graphql/validation';
 *
 * const oldSchema = buildSchema(`
 *   type Query {
 *     user(id: ID): String
 *   }
 * `);
 * const newSchema = buildSchema(`
 *   type Query {
 *     user(id: ID!): String
 *   }
 * `);
 *
 * const report = checkSchemaUpgrade(oldSchema, newSchema, [
 *   { name: 'GetUser', document: 'query GetUser { user }' },
 * ]);
 *
 * report.regressions.length; // => 1
 * report.regressions[0].rule; // => 'ProvidedRequiredArguments'
 * ```
 */
export function checkSchemaUpgrade(
  oldSchema: GraphQLSchema,
  newSchema: GraphQLSchema,
  operations: ReadonlyArray<NamedOperationDocument>,
  options?: SchemaUpgradeOptions,
): SchemaUpgradeReport {
  const rules = options?.rules ?? specifiedRules;
  const results = operations.map((operation) =>
    checkOperation(oldSchema, newSchema, operation, rules),
  );
  return {
    operations: results,
    regressions: results.flatMap((result) => result.diagnostics),
    preExisting: results.flatMap((result) => result.preExistingDiagnostics),
  };
}

function checkOperation(
  oldSchema: GraphQLSchema,
  newSchema: GraphQLSchema,
  operation: NamedOperationDocument,
  rules: ReadonlyArray<ValidationRule>,
): OperationUpgradeResult {
  const document = extractOperationDocument(
    typeof operation.document === 'string'
      ? parse(operation.document)
      : operation.document,
    operation.name,
  );
  const oldErrors = validateWithRules(oldSchema, document, rules);
  if (oldErrors.length !== 0) {
    return {
      name: operation.name,
      status: 'previouslyInvalid',
      diagnostics: [],
      preExistingDiagnostics: toDiagnostics(
        operation.name,
        oldErrors,
        oldSchema,
        newSchema,
        document,
      ),
    };
  }
  const newErrors = validateWithRules(newSchema, document, rules);
  return {
    name: operation.name,
    status: newErrors.length === 0 ? 'valid' : 'regressed',
    diagnostics: toDiagnostics(
      operation.name,
      newErrors,
      oldSchema,
      newSchema,
      document,
    ),
    preExistingDiagnostics: [],
  };
}

interface RuledError {
  readonly rule: string;
  readonly error: GraphQLError;
}

function validateWithRules(
  schema: GraphQLSchema,
  document: DocumentNode,
  rules: ReadonlyArray<ValidationRule>,
): Array<RuledError> {
  const errors: Array<RuledError> = [];
  for (const rule of rules) {
    for (const error of validate(schema, document, [rule])) {
      errors.push({ rule: ruleName(rule), error });
    }
  }
  return errors;
}

function ruleName(rule: ValidationRule): string {
  const name = rule.name;
  return name.endsWith('Rule') ? name.slice(0, -'Rule'.length) : name;
}

function toDiagnostics(
  operationName: string,
  errors: ReadonlyArray<RuledError>,
  oldSchema: GraphQLSchema,
  newSchema: GraphQLSchema,
  document: DocumentNode,
): Array<UpgradeDiagnostic> {
  if (errors.length === 0) {
    return [];
  }
  const oldContexts = collectTypeContexts(oldSchema, document);
  const newContexts = collectTypeContexts(newSchema, document);
  return errors.map(({ rule, error }) => {
    const node = error.nodes?.[0];
    return {
      operationName,
      rule,
      message: error.message,
      locations: error.locations ?? [],
      oldType: node === undefined ? undefined : oldContexts.get(node),
      newType: node === undefined ? undefined : newContexts.get(node),
    };
  });
}

function collectTypeContexts(
  schema: GraphQLSchema,
  document: DocumentNode,
): Map<ASTNode, string | undefined> {
  const typeInfo = new TypeInfo(schema);
  const contexts = new Map<ASTNode, string | undefined>();
  const fieldContextStack: Array<string | undefined> = [];
  visit(
    document,
    visitWithTypeInfo(typeInfo, {
      Field: {
        enter(node) {
          const context = describeField(typeInfo, node);
          contexts.set(node, context);
          fieldContextStack.push(context);
        },
        leave() {
          fieldContextStack.pop();
        },
      },
      SelectionSet(node) {
        contexts.set(node, fieldContextStack[fieldContextStack.length - 1]);
      },
      Argument(node) {
        contexts.set(node, describeArgument(typeInfo, node));
      },
      ObjectField(node) {
        contexts.set(node, describeObjectField(typeInfo, node));
      },
      VariableDefinition(node) {
        contexts.set(node, describeVariableDefinition(schema, node));
      },
      EnumValue(node) {
        contexts.set(node, describeInputValue(typeInfo));
      },
      ObjectValue(node) {
        contexts.set(node, describeInputValue(typeInfo));
      },
    }),
  );
  return contexts;
}

function describeField(
  typeInfo: TypeInfo,
  node: FieldNode,
): string | undefined {
  const parentType = typeInfo.getParentType();
  if (parentType == null) {
    return undefined;
  }
  const fieldDef = typeInfo.getFieldDef();
  if (fieldDef == null) {
    return parentType.name + '.' + node.name.value;
  }
  return printFieldSignature(parentType, fieldDef);
}

function printFieldSignature(
  parentType: GraphQLCompositeType,
  fieldDef: GraphQLField<unknown, unknown>,
): string {
  const args = fieldDef.args
    .map((arg) => arg.name + ': ' + String(arg.type))
    .join(', ');
  const signature =
    args === ''
      ? parentType.name + '.' + fieldDef.name
      : parentType.name + '.' + fieldDef.name + '(' + args + ')';
  return signature + ': ' + String(fieldDef.type);
}

function describeArgument(
  typeInfo: TypeInfo,
  node: ArgumentNode,
): string | undefined {
  const argument = typeInfo.getArgument();
  return argument == null
    ? undefined
    : node.name.value + ': ' + String(argument.type);
}

function describeObjectField(
  typeInfo: TypeInfo,
  node: ObjectFieldNode,
): string | undefined {
  const inputType = typeInfo.getInputType();
  return inputType == null
    ? undefined
    : node.name.value + ': ' + String(inputType);
}

function describeVariableDefinition(
  schema: GraphQLSchema,
  node: VariableDefinitionNode,
): string | undefined {
  const type = typeFromAST(schema, node.type);
  return type === undefined
    ? undefined
    : describeNamedInputType(getNamedType(type));
}

function describeInputValue(typeInfo: TypeInfo): string | undefined {
  const inputType: GraphQLInputType | null | undefined =
    typeInfo.getInputType();
  return inputType == null
    ? undefined
    : describeNamedInputType(getNamedType(inputType));
}

function describeNamedInputType(type: GraphQLNamedType): string {
  if (isEnumType(type)) {
    const values = type
      .getValues()
      .map((value) => value.name)
      .join(' ');
    return 'enum ' + type.name + ' { ' + values + ' }';
  }
  if (isInputObjectType(type)) {
    const fields = Object.values(type.getFields())
      .map((field) => field.name + ': ' + String(field.type))
      .join(', ');
    return 'input ' + type.name + ' { ' + fields + ' }';
  }
  return String(type);
}

function extractOperationDocument(
  document: DocumentNode,
  operationName: string,
): DocumentNode {
  let operation: OperationDefinitionNode | undefined;
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      if (definition.name?.value === operationName) {
        operation = definition;
      }
    } else if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }
  if (operation === undefined) {
    throw new Error(
      'Document does not contain an operation named "' + operationName + '".',
    );
  }
  const usedFragments: Array<FragmentDefinitionNode> = [];
  collectFragments(operation.selectionSet, fragments, new Set(), usedFragments);
  return {
    kind: Kind.DOCUMENT,
    definitions: [operation, ...usedFragments],
  };
}

function collectFragments(
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  seen: Set<string>,
  usedFragments: Array<FragmentDefinitionNode>,
): void {
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const name = selection.name.value;
      if (!seen.has(name)) {
        seen.add(name);
        const fragment = fragments.get(name);
        if (fragment !== undefined) {
          usedFragments.push(fragment);
          collectFragments(
            fragment.selectionSet,
            fragments,
            seen,
            usedFragments,
          );
        }
      }
    } else if (selection.selectionSet !== undefined) {
      collectFragments(selection.selectionSet, fragments, seen, usedFragments);
    }
  }
}
