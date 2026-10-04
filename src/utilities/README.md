## GraphQL Utilities

The `graphql/utilities` module contains common useful computations to use with
the GraphQL language and type objects.

```js
import { ... } from 'graphql/utilities'; // ES6
var GraphQLUtilities = require('graphql/utilities'); // CommonJS
```

### Producing and organizing query documents

- `separateOperations` splits a document containing multiple operations into
  one document per operation together with the fragments each operation
  reaches.
- `pruneUnusedVariables` rewrites a document so that each operation only keeps
  the variable definitions it references in its fields, directives, and
  reachable fragments. It is a purely syntactic, offline transform: it never
  consults a schema or resolvers, unknown fragment spreads are reported as
  errors, and fragment cycles are fully traversed. A runnable before/after
  demo lives at `resources/prune-unused-variables-demo.ts`.
