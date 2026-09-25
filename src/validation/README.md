## GraphQL Validation

The `graphql/validation` module fulfills the Validation phase of fulfilling a
GraphQL result.

```js
import { validate } from 'graphql/validation'; // ES6
var GraphQLValidator = require('graphql/validation'); // CommonJS
```

## Schema Upgrade Checks

The `checkSchemaUpgrade` function compares an old and a new schema against a
collection of named operation documents. Every operation is validated against
both schemas and the two error sets are diffed, so the report only contains
incompatibilities newly introduced by the upgrade. The check is purely static
and never executes any resolvers.

```js
import { checkSchemaUpgrade } from 'graphql/validation'; // ES6
var { checkSchemaUpgrade } = require('graphql/validation'); // CommonJS
```

Each reported diagnostic is attributed to a single operation and locates the
nearest field, argument, or variable, along with the types of that position in
the old and new schema whenever they differ. Fragments shared between
operations are attributed to each operation separately. Documents that were
already invalid against the old schema are listed under `preExisting` and are
never counted as new regressions.

The covered rule categories map to validation rules as follows:

| Schema change                        | Example validation rule                                           |
| ------------------------------------ | ----------------------------------------------------------------- |
| Required argument added or tightened | `ProvidedRequiredArgumentsRule`, `VariablesInAllowedPositionRule` |
| Variable default value invalidated   | `ValuesOfCorrectTypeRule`                                         |
| Required input object field added    | `ValuesOfCorrectTypeRule`                                         |
| Enum value removed (narrowing)       | `ValuesOfCorrectTypeRule`                                         |
| Field removed                        | `FieldsOnCorrectTypeRule`                                         |
| Field return type changed            | `ScalarLeafsRule`, `FieldsOnCorrectTypeRule`                      |

The report also lists the raw `breakingChanges` and `dangerousChanges`
between the two schemas. See `resources/check-schema-upgrade-example.ts` for
a runnable example that prints the diagnostics before and after an upgrade:

```shell
npm run example:schema-upgrade
```
