/** @category Values */

import { isIterableObject } from '../jsutils/isIterableObject.ts';
import { isObjectLike } from '../jsutils/isObjectLike.ts';
import type { Maybe } from '../jsutils/Maybe.ts';
import type { ObjMap } from '../jsutils/ObjMap.ts';
import { printPathArray } from '../jsutils/printPathArray.ts';

import { GraphQLError } from '../error/GraphQLError.ts';

import type {
  GraphQLInputObjectType,
  GraphQLInputType,
} from '../type/definition.ts';
import {
  isInputObjectType,
  isListType,
  isNonNullType,
} from '../type/definition.ts';

/**
 * Records a single use of a deprecated input field alias.
 */
export interface InputFieldAliasUsage {
  /**
   * The path to the deprecated alias usage, starting from the root input
   * value. List indices are preserved as numbers.
   */
  readonly path: ReadonlyArray<string | number>;
  /** The deprecated external key that was used. */
  readonly alias: string;
  /** The canonical schema field name the alias maps to. */
  readonly fieldName: string;
  /** The input object type that declares the alias. */
  readonly type: GraphQLInputObjectType;
}

/**
 * The result of applying input field aliases to a runtime input value.
 */
export interface ApplyInputFieldAliasesResult {
  /**
   * A new input value with deprecated aliases renamed to schema field names.
   * The original input value is not mutated.
   */
  readonly value: unknown;
  /** Locations where deprecated aliases were used. */
  readonly deprecations: ReadonlyArray<InputFieldAliasUsage>;
}

/**
 * Applies deprecated input field aliases to a runtime input value before
 * coercion.
 *
 * This is a preprocessing step that walks the input value and renames any
 * alias keys declared on input object fields to their canonical schema field
 * names. Deprecated alias usages are recorded with their full path (including
 * list indices) so callers can log or surface them.
 *
 * If both an alias and its canonical field name are present on the same input
 * object, a `GraphQLError` is thrown immediately, even if the values are
 * identical. Unknown keys are left untouched so the original coercion rules
 * can reject them.
 *
 * The input value is never mutated; a new value is returned.
 * @param inputValue - The runtime input value to process.
 * @param type - The GraphQL input type of the value.
 * @returns A new value with aliases applied, plus deprecation locations.
 * @throws {GraphQLError} When both an alias and its field name are present.
 * @example
 * ```ts
 * import { GraphQLInputObjectType, GraphQLString } from 'graphql/type';
 * import { applyInputFieldAliases } from 'graphql/utilities';
 *
 * const ItemInput = new GraphQLInputObjectType({
 *   name: 'ItemInput',
 *   fields: {
 *     name: { type: GraphQLString, aliases: ['display_name'] },
 *   },
 * });
 *
 * const result = applyInputFieldAliases(
 *   [{ display_name: 'first' }, { name: 'second' }],
 *   ItemInput,
 * );
 *
 * result.value; // => [{ name: 'first' }, { name: 'second' }]
 * result.deprecations;
 * // => [{ path: [0, 'display_name'], alias: 'display_name', fieldName: 'name', ... }]
 * ```
 */
export function applyInputFieldAliases(
  inputValue: unknown,
  type: GraphQLInputType,
): ApplyInputFieldAliasesResult {
  const deprecations: Array<InputFieldAliasUsage> = [];
  const value = applyAliases(inputValue, type, [], deprecations);
  return { value, deprecations };
}

function applyAliases(
  inputValue: unknown,
  type: GraphQLInputType,
  path: ReadonlyArray<string | number>,
  deprecations: Array<InputFieldAliasUsage>,
): unknown {
  if (isNonNullType(type)) {
    if (inputValue == null) {
      return inputValue;
    }
    return applyAliases(inputValue, type.ofType, path, deprecations);
  }

  if (inputValue == null) {
    return inputValue;
  }

  if (isListType(type)) {
    if (!isIterableObject(inputValue)) {
      const coercedItem = applyAliases(inputValue, type.ofType, path, deprecations);
      return [coercedItem];
    }
    const coercedValue: Array<unknown> = [];
    let index = 0;
    for (const itemValue of inputValue) {
      coercedValue.push(
        applyAliases(itemValue, type.ofType, [...path, index], deprecations),
      );
      index++;
    }
    return coercedValue;
  }

  if (isInputObjectType(type)) {
    if (!isObjectLike(inputValue) || Array.isArray(inputValue)) {
      return inputValue;
    }

    const fieldDefs = type.getFields();
    const aliasToField = new Map<string, string>();
    for (const field of Object.values(fieldDefs)) {
      if (field.aliases != null) {
        for (const alias of field.aliases) {
          aliasToField.set(alias, field.name);
        }
      }
    }

    const coercedValue: ObjMap<unknown> = Object.create(null);
    for (const [key, rawValue] of Object.entries(inputValue)) {
      if (rawValue === undefined) {
        continue;
      }

      if (Object.hasOwn(fieldDefs, key)) {
        const fieldName = key;
        const alias = findAliasForField(fieldDefs[fieldName].aliases, inputValue);
        if (alias !== undefined) {
          throw new GraphQLError(
            `Field "${fieldName}" and its alias "${alias}" cannot both be provided.`,
            { path: [...path, fieldName] },
          );
        }
        coercedValue[fieldName] = rawValue;
      } else if (aliasToField.has(key)) {
        const fieldName = aliasToField.get(key);
        if (fieldName === undefined) {
          continue;
        }
        if (
          Object.hasOwn(inputValue, fieldName) &&
          inputValue[fieldName] !== undefined
        ) {
          throw new GraphQLError(
            `Field "${fieldName}" and its alias "${key}" cannot both be provided.`,
            { path: [...path, key] },
          );
        }
        deprecations.push({
          path: [...path, key],
          alias: key,
          fieldName,
          type,
        });
        coercedValue[fieldName] = rawValue;
      } else {
        coercedValue[key] = rawValue;
      }
    }

    for (const field of Object.values(fieldDefs)) {
      if (coercedValue[field.name] !== undefined) {
        coercedValue[field.name] = applyAliases(
          coercedValue[field.name],
          field.type,
          [...path, field.name],
          deprecations,
        );
      }
    }

    return coercedValue;
  }

  return inputValue;
}

function findAliasForField(
  aliases: Maybe<ReadonlyArray<string>>,
  inputValue: { readonly [key: string]: unknown },
): string | undefined {
  if (aliases == null) {
    return undefined;
  }
  for (const alias of aliases) {
    if (Object.hasOwn(inputValue, alias) && inputValue[alias] !== undefined) {
      return alias;
    }
  }
  return undefined;
}

/**
 * Formats a deprecation location for use in log messages.
 * @param usage - The alias usage to format.
 * @returns A human-readable string describing the deprecation location.
 * @example
 * ```ts
 * import { printInputFieldAliasUsage } from 'graphql/utilities';
 *
 * const usage = {
 *   path: ['input', 0, 'display_name'],
 *   alias: 'display_name',
 *   fieldName: 'name',
 *   type: ItemInput,
 * };
 *
 * printInputFieldAliasUsage(usage);
 * // => 'Field "name" alias "display_name" was deprecated at .input[0].display_name.'
 * ```
 */
export function printInputFieldAliasUsage(usage: InputFieldAliasUsage): string {
  return `Field "${usage.fieldName}" alias "${usage.alias}" was deprecated${printPathArray(usage.path)}.`;
}
