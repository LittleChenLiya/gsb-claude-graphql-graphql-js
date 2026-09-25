/**
 * Standalone fixture for the schema upgrade checker tests and example.
 *
 * The two schemas below differ in exactly one breaking change per schema
 * element so each operation document exercises a single upgrade rule:
 *
 * - `Query.user`: argument `id` changed from `ID` to `ID!`.
 * - `Query.legacy`: argument `mode` (and the `Mode` enum) was removed.
 * - `Query.config`: return type changed from `Config` to `String`.
 * - `Role`: enum value `GUEST` was removed (enum narrowing).
 * - `SearchFilter`: field `term` became required and `tags` was removed.
 */

export const oldSchemaSDL = /* GraphQL */ `
  type Query {
    user(id: ID): User
    usersByRole(role: Role): [User]
    search(filter: SearchFilter): [String]
    legacy(mode: Mode): String
    config: Config
  }

  type User {
    id: ID!
    name: String
  }

  type Config {
    key: String
    value: String
  }

  enum Role {
    ADMIN
    USER
    GUEST
  }

  enum Mode {
    FAST
    SLOW
  }

  input SearchFilter {
    term: String
    limit: Int
    tags: [String]
  }
`;

export const newSchemaSDL = /* GraphQL */ `
  type Query {
    user(id: ID!): User
    usersByRole(role: Role): [User]
    search(filter: SearchFilter): [String]
    legacy: String
    config: String
  }

  type User {
    id: ID!
    name: String
  }

  enum Role {
    ADMIN
    USER
  }

  input SearchFilter {
    term: String!
    limit: Int
  }
`;

/** Missing the newly required `id` argument: regresses. */
export const getUserWithoutId = {
  name: 'GetUser',
  document: /* GraphQL */ `
    query GetUser {
      user {
        id
        name
      }
    }
  `,
};

/** Provides a valid `id` argument: stays valid after the upgrade. */
export const getUserWithId = {
  name: 'GetUserWithId',
  document: /* GraphQL */ `
    query GetUserWithId {
      user(id: "user-1") {
        id
        name
      }
    }
  `,
};

/** References a field that never existed: invalid before and after. */
export const getUserWithUnknownField = {
  name: 'GetUserTypo',
  document: /* GraphQL */ `
    query GetUserTypo {
      user(id: "user-1") {
        id
        nickname
      }
    }
  `,
};

/**
 * Two operations sharing one fragment; the missing `id` argument error is
 * located inside the shared fragment and must be attributed per operation.
 */
export const sharedFragmentDocument = /* GraphQL */ `
  fragment UserCard on Query {
    user {
      id
      name
    }
  }

  query GetUserA {
    ...UserCard
  }

  query GetUserB {
    ...UserCard
  }
`;

/** Variable default uses the removed enum value `GUEST`: regresses. */
export const getUsersByRoleWithDefault = {
  name: 'GetUsersByRole',
  document: /* GraphQL */ `
    query GetUsersByRole($role: Role = GUEST) {
      usersByRole(role: $role) {
        id
      }
    }
  `,
};

/** Literal argument uses the removed enum value `GUEST`: regresses. */
export const getGuestsByRoleLiteral = {
  name: 'GetGuests',
  document: /* GraphQL */ `
    query GetGuests {
      usersByRole(role: GUEST) {
        id
      }
    }
  `,
};

/** Input object literal uses the removed field `tags`: regresses. */
export const searchWithRemovedField = {
  name: 'SearchWithTags',
  document: /* GraphQL */ `
    query SearchWithTags {
      search(filter: { term: "graphql", tags: ["a", "b"] })
    }
  `,
};

/** Input object literal misses the newly required field `term`. */
export const searchMissingRequiredField = {
  name: 'SearchWithoutTerm',
  document: /* GraphQL */ `
    query SearchWithoutTerm {
      search(filter: { limit: 10 })
    }
  `,
};

/** Variable default uses the removed input object field `tags`. */
export const searchWithDefaultFilter = {
  name: 'SearchWithDefault',
  document: /* GraphQL */ `
    query SearchWithDefault(
      $filter: SearchFilter = { term: "x", tags: ["t"] }
    ) {
      search(filter: $filter)
    }
  `,
};

/** Selects subfields on `config` whose return type became `String`. */
export const getConfig = {
  name: 'GetConfig',
  document: /* GraphQL */ `
    query GetConfig {
      config {
        key
      }
    }
  `,
};

/** Uses the removed argument `mode` (and its enum type `Mode`). */
export const getLegacy = {
  name: 'GetLegacy',
  document: /* GraphQL */ `
    query GetLegacy {
      legacy(mode: FAST)
    }
  `,
};
