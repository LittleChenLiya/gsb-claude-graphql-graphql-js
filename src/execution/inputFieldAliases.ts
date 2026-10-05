/** @category Values */

import { isIterableObject } from '../jsutils/isIterableObject.ts';
import { isObjectLike } from '../jsutils/isObjectLike.ts';
import type { ObjMap } from '../jsutils/ObjMap.ts';

import type { GraphQLInputType } from '../type/definition.ts';
import {
  isInputObjectType,
  isListType,
  isNonNullType,
} from '../type/definition.ts';

/**
 * An explicit migration rule mapping a deprecated external key of an input
 * object type onto a schema field.
 *
 * Rules are opt-in: the default execution entry points do not accept
 * deprecated keys unless rules are provided (for example via
 * `getVariableValues(schema, varDefs, inputs, { inputFieldAliases })` or
 * `execute({ ..., inputFieldAliases })`).
 * @example
 * ```ts
 * // Migration rule example: accept the deprecated external key
 * // "display_name" wherever the schema now defines "ItemInput.name".
 * import type { InputFieldAliasRule } from 'graphql/execution';
 *
 * const inputFieldAliases: ReadonlyArray<InputFieldAliasRule> = [
 *   { typeName: 'ItemInput', alias: 'display_name', field: 'name' },
 * ];
 * ```
 */
export interface InputFieldAliasRule {
  /** Name of the input object type the rule applies to. */
  readonly typeName: string;
  /** Deprecated external key accepted in variable values. */
  readonly alias: string;
  /** Schema field the deprecated key maps to. */
  readonly field: string;
}

/**
 * Records a single use of a deprecated input field alias, including the
 * location of the deprecated key within the variable value. List segments
 * keep the actual item index.
 */
export interface InputFieldAliasDeprecation {
  /** Name of the variable the deprecated key was found in. */
  readonly variableName: string;
  /** Path to the deprecated key within the variable value. */
  readonly path: ReadonlyArray<string | number>;
  /** The migration rule that matched. */
  readonly rule: InputFieldAliasRule;
}

/**
 * Handlers invoked while applying input field alias rules.
 * @internal
 */
export interface InputFieldAliasHandlers {
  /** Called for every deprecated key that was remapped to its schema field. */
  readonly onDeprecation: (
    path: ReadonlyArray<string | number>,
    rule: InputFieldAliasRule,
  ) => void;
  /**
   * Called when both the deprecated alias and the schema field are provided,
   * even if both values are identical.
   */
  readonly onConflict: (
    path: ReadonlyArray<string | number>,
    rule: InputFieldAliasRule,
  ) => void;
}

/**
 * Groups input field alias rules by input object type name for lookup
 * during variable coercion.
 * @internal
 */
export function groupInputFieldAliasRules(
  rules: ReadonlyArray<InputFieldAliasRule>,
): ReadonlyMap<string, ReadonlyArray<InputFieldAliasRule>> {
  const rulesByType = new Map<string, Array<InputFieldAliasRule>>();
  for (const rule of rules) {
    const existing = rulesByType.get(rule.typeName);
    if (existing === undefined) {
      rulesByType.set(rule.typeName, [rule]);
    } else {
      existing.push(rule);
    }
  }
  return rulesByType;
}

/**
 * Rewrites deprecated external keys in a variable value to their schema
 * fields according to the given alias rules, recording each deprecation and
 * rejecting keys that are provided alongside their schema field.
 *
 * The input value is never mutated: remapped objects and lists are copied
 * lazily, so a failed coercion leaves the original variables untouched.
 * Keys not covered by any rule are left in place for the regular coercion
 * rules to handle.
 * @internal
 */
export function applyInputFieldAliases(
  value: unknown,
  type: GraphQLInputType,
  rulesByType: ReadonlyMap<string, ReadonlyArray<InputFieldAliasRule>>,
  path: ReadonlyArray<string | number>,
  handlers: InputFieldAliasHandlers,
): unknown {
  if (isNonNullType(type)) {
    return applyInputFieldAliases(
      value,
      type.ofType,
      rulesByType,
      path,
      handlers,
    );
  }

  if (value == null) {
    return value;
  }

  if (isListType(type)) {
    if (!isIterableObject(value)) {
      // Lists accept a non-list value as a list of one.
      return applyInputFieldAliases(
        value,
        type.ofType,
        rulesByType,
        path,
        handlers,
      );
    }
    let changed = false;
    const transformedItems: Array<unknown> = [];
    let index = 0;
    for (const item of value) {
      const transformedItem = applyInputFieldAliases(
        item,
        type.ofType,
        rulesByType,
        [...path, index],
        handlers,
      );
      if (transformedItem !== item) {
        changed = true;
      }
      transformedItems.push(transformedItem);
      index++;
    }
    return changed ? transformedItems : value;
  }

  if (isInputObjectType(type)) {
    if (!isObjectLike(value) || Array.isArray(value)) {
      // Leave invalid values to the regular coercion rules.
      return value;
    }

    const inputValue = value as ObjMap<unknown>;
    let result: ObjMap<unknown> | undefined;
    const writeKey = (key: string, keyValue: unknown): void => {
      result ??= { ...inputValue };
      result[key] = keyValue;
    };
    const deleteKey = (key: string): void => {
      result ??= { ...inputValue };
      delete result[key];
    };

    const rules = rulesByType.get(type.name);
    if (rules !== undefined) {
      for (const rule of rules) {
        if (
          !Object.hasOwn(inputValue, rule.alias) ||
          inputValue[rule.alias] === undefined
        ) {
          continue;
        }
        const aliasPath = [...path, rule.alias];
        if (
          Object.hasOwn(inputValue, rule.field) &&
          inputValue[rule.field] !== undefined
        ) {
          // Both the deprecated alias and the schema field are provided:
          // reject, even when both values are identical. The explicit schema
          // field wins so coercion can still collect further diagnostics.
          handlers.onConflict(aliasPath, rule);
          deleteKey(rule.alias);
        } else {
          handlers.onDeprecation(aliasPath, rule);
          writeKey(rule.field, inputValue[rule.alias]);
          deleteKey(rule.alias);
        }
      }
    }

    const current = result ?? inputValue;
    for (const field of Object.values(type.getFields())) {
      if (!Object.hasOwn(current, field.name)) {
        continue;
      }
      const fieldValue = current[field.name];
      if (fieldValue === undefined) {
        continue;
      }
      const transformedField = applyInputFieldAliases(
        fieldValue,
        field.type,
        rulesByType,
        [...path, field.name],
        handlers,
      );
      if (transformedField !== fieldValue) {
        writeKey(field.name, transformedField);
      }
    }

    return result ?? value;
  }

  return value;
}
