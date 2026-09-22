## GraphQL Validation

The `graphql/validation` module fulfills the Validation phase of fulfilling a
GraphQL result.

```js
import { validate } from 'graphql/validation'; // ES6
var GraphQLValidator = require('graphql/validation'); // CommonJS
```

## Query cost analysis

`analyzeQueryCost` estimates a query's cost before execution. It runs the
standard validation rules and execution-style variable/argument coercion,
then returns the total cost, a response-shaped cost tree, and the first path
that crosses an optional budget. Resolvers never run; list sizes come from a
configured integer argument with an explicit default and maximum.
