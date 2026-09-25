# Schema Upgrade Checker

`checkSchemaUpgrade` (exported from `graphql/validation` and the package
root) compares an old and a new `GraphQLSchema` against a set of named
operation documents and reports only the incompatibilities introduced by the
upgrade. The check is purely static: documents are parsed and validated, but
never executed, so no field resolver is ever called.

## Usage

```ts
import { buildSchema } from 'graphql/utilities';
import { checkSchemaUpgrade } from 'graphql/validation';

const report = checkSchemaUpgrade(oldSchema, newSchema, [
  { name: 'GetUser', document: 'query GetUser { user { id } }' },
]);

for (const diagnostic of report.regressions) {
  console.log(diagnostic.operationName, diagnostic.rule, diagnostic.message);
}
```

Run the bundled example (prints the diagnostics from before and after the
upgrade, finishes in well under 90 seconds):

```sh
npm run example:schema-upgrade
```

## How operations are checked

- Each entry names one operation inside a document. The document may contain
  several operations; only the named one is checked, together with the
  fragments it transitively spreads.
- A fragment shared by several operations is validated once per operation, so
  problems inside it are attributed to every operation that uses it.
- Every operation is validated twice: once against the old schema and once
  against the new schema.
- Operations that already fail validation against the old schema are reported
  as `previouslyInvalid` (with `preExistingDiagnostics`) and are never
  counted as new regressions.
- Operations that validate against the old schema but fail against the new
  schema are reported as `regressed` with one diagnostic per error.
- `report.operations`, `report.regressions`, and `report.preExisting`
  preserve the input order of the operations.

## Diagnostics

Every `UpgradeDiagnostic` carries:

- `operationName`: the operation the problem is attributed to.
- `rule`: the validation rule that reported it (the rule function name
  without the trailing `Rule`).
- `message` and `locations`: the validation error text and the line/column
  positions of the offending field, argument, variable, or value.
- `oldType` / `newType`: the printed shape of the involved schema element
  in each schema (a field signature such as `Query.user(id: ID): User`, an
  argument or input object field such as `tags: [String]`, or an enum/input
  object definition). A side is `undefined` when the element does not exist
  in that schema.

## Covered schema changes

The checker runs all specified validation rules per operation, so any
spec-visible breaking change is detected. Common cases and the rules that
report them:

| Schema change                              | Rule                        |
| ------------------------------------------ | --------------------------- |
| Argument becomes required (`ID` to `ID!`)  | `ProvidedRequiredArguments` |
| Argument or its enum type is removed       | `KnownArgumentNames`        |
| Field is removed                           | `FieldsOnCorrectType`       |
| Field return type changes (leaf/composite) | `ScalarLeafs`               |
| Enum value is removed (narrowing)          | `ValuesOfCorrectType`       |
| Input object field is removed              | `ValuesOfCorrectType`       |
| Input object field becomes required        | `ValuesOfCorrectType`       |
| Variable default value becomes invalid     | `ValuesOfCorrectType`       |
| Variable type is removed                   | `KnownTypeNames`            |

A custom rule list can be supplied with the `rules` option; rule names are
reported verbatim.

## Types

`NamedOperationDocument`, `OperationUpgradeStatus`, `UpgradeDiagnostic`,
`OperationUpgradeResult`, `SchemaUpgradeReport`, and
`SchemaUpgradeOptions` are exported as types from `graphql/validation` and
the package root. A standalone fixture with a matching pair of schemas and
operation documents lives in
`src/validation/__tests__/fixtures/schemaUpgrade.ts`.
