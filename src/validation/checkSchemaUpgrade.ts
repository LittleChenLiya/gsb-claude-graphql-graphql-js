/** @category Schema Upgrade */

import type { GraphQLError } from '../error/GraphQLError.ts';

import type {
  ArgumentNode,
  ASTNode,
  DocumentNode,
  FieldNode,
} from '../language/ast.ts';
import { isNode } from '../language/ast.ts';
import { Kind } from '../language/kinds.ts';
import type { SourceLocation } from '../language/location.ts';
import { visit } from '../language/visitor.ts';

import type { GraphQLField } from '../type/definition.ts';
import { isInterfaceType, isObjectType } from '../type/definition.ts';
import type { GraphQLSchema } from '../type/schema.ts';

import type {
  BreakingChange,
  DangerousChange,
  SchemaChange,
} from '../utilities/findSchemaChanges.ts';
import {
  BreakingChangeType,
  DangerousChangeType,
  findSchemaChanges,
} from '../utilities/findSchemaChanges.ts';
import { separateOperations } from '../utilities/separateOperations.ts';
import { TypeInfo, visitWithTypeInfo } from '../utilities/TypeInfo.ts';

import { specifiedRules } from './specifiedRules.ts';
import { validate } from './validate.ts';
import type { ValidationRule } from './ValidationContext.ts';

/**
 * A named entry of a parsed GraphQL document to check during a schema
 * upgrade. The document may contain multiple operations; shared fragments
 * are attributed to each operation that (transitively) uses them.
 * @category Schema Upgrade
 */
export interface NamedOperationDocument {
  /** Name identifying this document within the report. */
  name: string;
  /** Parsed document containing one or more operations. */
  document: DocumentNode;
  /** Restrict the check to a single operation within the document. */
  operationName?: string;
}

/**
 * A single validation diagnostic attributed to one operation, located at a
 * field, argument, or variable, and annotated with the types of that
 * position in the old and new schema whenever they differ.
 * @category Schema Upgrade
 */
export interface SchemaUpgradeDiagnostic {
  /** Name of the `NamedOperationDocument` this diagnostic belongs to. */
  documentName: string;
  /** Name of the attributed operation, or `undefined` when anonymous. */
  operationName: string | undefined;
  /** Name of the validation rule that reported this diagnostic. */
  rule: string;
  /** Human-readable validation message. */
  message: string;
  /** Source locations of the offending nodes within the document. */
  locations: ReadonlyArray<SourceLocation>;
  /** Coordinate of the nearest enclosing field, e.g. `"Query.user"`. */
  field: string | undefined;
  /** Name of the nearest enclosing argument, when any. */
  argument: string | undefined;
  /** Name of the involved variable, when any. */
  variable: string | undefined;
  /** Printed type at the located position in the old schema. */
  oldType: string | undefined;
  /** Printed type at the located position in the new schema. */
  newType: string | undefined;
}

/**
 * Result of checking a set of operation documents against a schema upgrade.
 * @category Schema Upgrade
 */
export interface SchemaUpgradeReport {
  /** True when the upgrade introduced no new incompatibilities. */
  compatible: boolean;
  /**
   * Diagnostics for errors that only appear when validating against the new
   * schema, in the same order as the provided documents.
   */
  regressions: ReadonlyArray<SchemaUpgradeDiagnostic>;
  /**
   * Diagnostics for errors that were already present when validating
   * against the old schema. These are not upgrade regressions.
   */
  preExisting: ReadonlyArray<SchemaUpgradeDiagnostic>;
  /** Breaking schema changes detected between the old and new schema. */
  breakingChanges: ReadonlyArray<BreakingChange>;
  /** Dangerous schema changes detected between the old and new schema. */
  dangerousChanges: ReadonlyArray<DangerousChange>;
}

/**
 * Options used when checking a schema upgrade.
 * @category Schema Upgrade
 */
export interface SchemaUpgradeOptions {
  /**
   * Validation rules to apply to both schemas. Defaults to all rules
   * defined by the GraphQL specification.
   */
  rules?: ReadonlyArray<ValidationRule>;
}

/**
 * Checks a collection of named operation documents against a schema upgrade.
 *
 * Every operation is validated against both the old and the new schema and
 * only incompatibilities newly introduced by the upgrade are reported as
 * regressions. Documents that were already invalid against the old schema
 * are reported separately as pre-existing errors and are never counted as
 * new regressions. Fragments shared between operations are attributed to
 * each operation individually.
 *
 * The check is purely static: it only runs validation rules and never
 * executes any resolver.
 * @param oldSchema - The schema currently in production.
 * @param newSchema - The upgraded schema to validate against.
 * @param documents - Named operation documents to check, reported in order.
 * @param options - Options, including a custom list of validation rules.
 * @returns A report of regressions, pre-existing errors, and schema changes.
 * @example
 * ```ts
 * import { parse } from 'graphql/language';
 * import { buildSchema } from 'graphql/utilities';
 * import { checkSchemaUpgrade } from 'graphql/validation';
 *
 * const oldSchema = buildSchema('type Query { user(id: ID): String }');
 * const newSchema = buildSchema('type Query { user(id: ID!): String }');
 *
 * const report = checkSchemaUpgrade(oldSchema, newSchema, [
 *   { name: 'GetUser', document: parse('{ user }') },
 * ]);
 *
 * report.compatible; // => false
 * report.regressions[0].rule; // => 'ProvidedRequiredArgumentsRule'
 * report.regressions[0].oldType; // => 'ID'
 * report.regressions[0].newType; // => 'ID!'
 * ```
 */
export function checkSchemaUpgrade(
  oldSchema: GraphQLSchema,
  newSchema: GraphQLSchema,
  documents: ReadonlyArray<NamedOperationDocument>,
  options?: SchemaUpgradeOptions,
): SchemaUpgradeReport {
  const rules = options?.rules ?? specifiedRules;
  const regressions: Array<SchemaUpgradeDiagnostic> = [];
  const preExisting: Array<SchemaUpgradeDiagnostic> = [];

  for (const { name, document, operationName } of documents) {
    const separated = separateOperations(document);
    const operationNames =
      operationName !== undefined ? [operationName] : Object.keys(separated);

    for (const opName of operationNames) {
      const operationDocument = separated[opName];
      if (operationDocument === undefined) {
        throw new Error(
          `Document "${name}" does not contain an operation named "${opName}".`,
        );
      }

      const oldErrors = collectRuleErrors(oldSchema, operationDocument, rules);
      const newErrors = collectRuleErrors(newSchema, operationDocument, rules);
      const oldFingerprints = new Set(oldErrors.map(fingerprint));

      const oldFieldParents = collectFieldParents(oldSchema, operationDocument);
      const newFieldParents = collectFieldParents(newSchema, operationDocument);
      const context: DiagnosticContext = {
        documentName: name,
        operationName: opName === '' ? undefined : opName,
        oldSchema,
        newSchema,
        parentMap: buildParentMap(operationDocument),
      };

      for (const ruleError of oldErrors) {
        preExisting.push(buildDiagnostic(context, ruleError, oldFieldParents));
      }
      for (const ruleError of newErrors) {
        if (!oldFingerprints.has(fingerprint(ruleError))) {
          regressions.push(
            buildDiagnostic(context, ruleError, newFieldParents),
          );
        }
      }
    }
  }

  const schemaChanges = findSchemaChanges(oldSchema, newSchema);
  return {
    compatible: regressions.length === 0,
    regressions,
    preExisting,
    breakingChanges: schemaChanges.filter(isBreakingChange),
    dangerousChanges: schemaChanges.filter(isDangerousChange),
  };
}

function isBreakingChange(change: SchemaChange): change is BreakingChange {
  return change.type in BreakingChangeType;
}

function isDangerousChange(change: SchemaChange): change is DangerousChange {
  return change.type in DangerousChangeType;
}

interface RuleError {
  rule: string;
  error: GraphQLError;
}

function collectRuleErrors(
  schema: GraphQLSchema,
  document: DocumentNode,
  rules: ReadonlyArray<ValidationRule>,
): Array<RuleError> {
  const ruleErrors: Array<RuleError> = [];
  for (const rule of rules) {
    for (const error of validate(schema, document, [rule])) {
      ruleErrors.push({ rule: rule.name, error });
    }
  }
  return ruleErrors;
}

function fingerprint(ruleError: RuleError): string {
  const { rule, error } = ruleError;
  const locations = (error.locations ?? [])
    .map((location) => `${location.line}:${location.column}`)
    .join(',');
  return `${rule}\n${error.message}\n${locations}`;
}

function buildParentMap(document: DocumentNode): Map<ASTNode, ASTNode> {
  const parentMap = new Map<ASTNode, ASTNode>();
  visit(document, {
    enter(node, _key, parent, _path, ancestors) {
      // Nodes nested inside lists (e.g. argument lists) report the list as
      // their parent, so walk back through the ancestors to the nearest node.
      let current: ASTNode | ReadonlyArray<ASTNode> | undefined = parent;
      for (
        let index = ancestors.length - 1;
        current !== undefined && !isNode(current);
        --index
      ) {
        current = ancestors[index];
      }
      if (isNode(current)) {
        parentMap.set(node, current);
      }
    },
  });
  return parentMap;
}

function collectFieldParents(
  schema: GraphQLSchema,
  document: DocumentNode,
): Map<FieldNode, string> {
  const typeInfo = new TypeInfo(schema);
  const fieldParents = new Map<FieldNode, string>();
  visit(
    document,
    visitWithTypeInfo(typeInfo, {
      Field(node) {
        const parentType = typeInfo.getParentType();
        if (parentType != null) {
          fieldParents.set(node, parentType.name);
        }
      },
    }),
  );
  return fieldParents;
}

interface DiagnosticContext {
  documentName: string;
  operationName: string | undefined;
  oldSchema: GraphQLSchema;
  newSchema: GraphQLSchema;
  parentMap: Map<ASTNode, ASTNode>;
}

function buildDiagnostic(
  context: DiagnosticContext,
  ruleError: RuleError,
  fieldParents: Map<FieldNode, string>,
): SchemaUpgradeDiagnostic {
  const { documentName, operationName, oldSchema, newSchema, parentMap } =
    context;
  const { rule, error } = ruleError;

  let fieldNode: FieldNode | undefined;
  let argumentNode: ArgumentNode | undefined;
  let variable: string | undefined;
  for (const node of error.nodes ?? []) {
    let current: ASTNode | undefined = node;
    while (current !== undefined) {
      if (fieldNode === undefined && current.kind === Kind.FIELD) {
        fieldNode = current;
      }
      if (argumentNode === undefined && current.kind === Kind.ARGUMENT) {
        argumentNode = current;
      }
      if (variable === undefined) {
        if (current.kind === Kind.VARIABLE) {
          variable = current.name.value;
        } else if (current.kind === Kind.VARIABLE_DEFINITION) {
          variable = current.variable.name.value;
        }
      }
      current = parentMap.get(current);
    }
  }

  let field: string | undefined;
  let argument: string | undefined;
  let oldType: string | undefined;
  let newType: string | undefined;
  if (fieldNode !== undefined) {
    const parentName = fieldParents.get(fieldNode);
    if (parentName !== undefined) {
      const fieldName = fieldNode.name.value;
      field = `${parentName}.${fieldName}`;
      const argumentName =
        argumentNode?.name.value ?? matchArgumentName(error.message);
      if (argumentName !== undefined) {
        argument = argumentName;
        oldType = getArgumentType(
          oldSchema,
          parentName,
          fieldName,
          argumentName,
        );
        newType = getArgumentType(
          newSchema,
          parentName,
          fieldName,
          argumentName,
        );
      } else {
        oldType = getFieldType(oldSchema, parentName, fieldName);
        newType = getFieldType(newSchema, parentName, fieldName);
      }
      if (oldType === newType) {
        oldType = undefined;
        newType = undefined;
      }
    }
  }

  return {
    documentName,
    operationName,
    rule,
    message: error.message,
    locations: error.locations ?? [],
    field,
    argument,
    variable,
    oldType,
    newType,
  };
}

function matchArgumentName(message: string): string | undefined {
  return /Argument "(?:@)?[^"]*?\((\w+):\)"/.exec(message)?.[1];
}

function getFieldDef(
  schema: GraphQLSchema,
  parentTypeName: string,
  fieldName: string,
): GraphQLField<unknown, unknown> | undefined {
  const type = schema.getType(parentTypeName);
  if (type !== undefined && (isObjectType(type) || isInterfaceType(type))) {
    return type.getFields()[fieldName];
  }
  return undefined;
}

function getFieldType(
  schema: GraphQLSchema,
  parentTypeName: string,
  fieldName: string,
): string | undefined {
  const fieldDef = getFieldDef(schema, parentTypeName, fieldName);
  return fieldDef === undefined ? undefined : String(fieldDef.type);
}

function getArgumentType(
  schema: GraphQLSchema,
  parentTypeName: string,
  fieldName: string,
  argumentName: string,
): string | undefined {
  const argumentDef = getFieldDef(schema, parentTypeName, fieldName)?.args.find(
    (argument) => argument.name === argumentName,
  );
  return argumentDef === undefined ? undefined : String(argumentDef.type);
}
