/**
 * Create, format, and locate GraphQL errors.
 *
 * These exports are also available from the root `graphql` package.
 * @packageDocumentation
 */

export { GraphQLError } from './GraphQLError.ts';
export type {
  GraphQLErrorOptions,
  GraphQLFormattedError,
  GraphQLErrorExtensions,
  GraphQLFormattedErrorExtensions,
} from './GraphQLError.ts';

export { syntaxError } from './syntaxError.ts';

export { locatedError } from './locatedError.ts';

export { groupGraphQLErrors, formatGroupedErrors } from './groupGraphQLErrors.ts';
export type {
  GraphQLErrorGroup,
  GroupGraphQLErrorsOptions,
  FormattedGraphQLErrorEvent,
  FormattedGraphQLErrorGroup,
  FormatGroupedErrorsOptions,
} from './groupGraphQLErrors.ts';
