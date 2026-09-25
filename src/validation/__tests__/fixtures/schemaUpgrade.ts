/**
 * Standalone fixtures for the schema upgrade checker tests.
 *
 * The upgrade from `oldSchemaSDL` to `newSchemaSDL` contains one change
 * per covered rule category:
 * - `Query.user(id:)` changes from `ID` to `ID!` (argument tightened).
 * - `Role` loses the `GUEST` value (enum narrowing).
 * - `UserFilter` gains the required field `tag` (input object field).
 * - `User.nickname` is removed (field removal).
 * - `Query.status` changes from `String` to `Status` (return type).
 * - `Query.category` changes from `Category` to `String` (return type).
 * - `Query.thing` of the new `Thing` type is added (safe addition).
 */
export const oldSchemaSDL = /* GraphQL */ `
  enum Role {
    ADMIN
    USER
    GUEST
  }

  input UserFilter {
    name: String
  }

  type User {
    id: ID
    name: String
    nickname: String
  }

  type Category {
    name: String
  }

  type Query {
    user(id: ID): User
    users(filter: UserFilter, role: Role): [User]
    status: String
    category: Category
    version: Int
  }
`;

export const newSchemaSDL = /* GraphQL */ `
  enum Role {
    ADMIN
    USER
  }

  input UserFilter {
    name: String
    tag: String!
  }

  type User {
    id: ID
    name: String
  }

  type Status {
    label: String
  }

  type Thing {
    label(code: String!): String
  }

  type Query {
    user(id: ID!): User
    users(filter: UserFilter, role: Role): [User]
    status: Status
    category: String
    thing: Thing
    version: Int
  }
`;

/** Named operation documents exercised against the schema upgrade. */
export const operations: { [name: string]: string } = {
  // Missing the newly required `id` argument: becomes a regression.
  noArgument: /* GraphQL */ `
    query GetUser {
      user {
        id
      }
    }
  `,
  // Explicitly passes a legal id: stays valid after the upgrade.
  explicitId: /* GraphQL */ `
    query GetUser($id: ID!) {
      user(id: $id) {
        id
      }
    }
  `,
  // Nullable variable used for the newly required argument: regression.
  nullableIdVariable: /* GraphQL */ `
    query GetUser($id: ID) {
      user(id: $id) {
        id
      }
    }
  `,
  // References a field that never existed: pre-existing error only.
  unknownField: /* GraphQL */ `
    query GetBroken {
      unknownField {
        sub(arg: 1, arg: 2)
      }
    }
  `,
  // Uses a variable that is never defined: pre-existing error only.
  undefinedVariable: /* GraphQL */ `
    query GetUser {
      user(id: $missing) {
        id
      }
    }
  `,
  // Two operations sharing one fragment that selects a changed field.
  sharedFragment: /* GraphQL */ `
    query FirstStatus {
      ...StatusBits
    }

    query SecondStatus {
      ...StatusBits
    }

    fragment StatusBits on Query {
      status
    }
  `,
  // Two operations used to check operation name selection.
  multiOperation: /* GraphQL */ `
    query KeepVersion {
      version
    }

    query DropStatus {
      status
    }
  `,
  // Variable default value invalidated by enum narrowing.
  variableDefault: /* GraphQL */ `
    query GetUsers($role: Role = GUEST) {
      users(role: $role) {
        id
      }
    }
  `,
  // Input object literal missing the newly required field.
  inputObject: /* GraphQL */ `
    query GetUsers {
      users(filter: { name: "a" }) {
        id
      }
    }
  `,
  // Enum literal removed by enum narrowing.
  enumLiteral: /* GraphQL */ `
    query GetUsers {
      users(role: GUEST) {
        id
      }
    }
  `,
  // Selection set on a field whose return type became a scalar.
  category: /* GraphQL */ `
    query GetCategory {
      category {
        name
      }
    }
  `,
  // Selects a field that was removed from the User type.
  removedField: /* GraphQL */ `
    query GetUser {
      user(id: "1") {
        nickname
      }
    }
  `,
  // Selects a field of a type that only exists in the new schema.
  newType: /* GraphQL */ `
    query GetThing {
      thing {
        label
      }
    }
  `,
  // Anonymous operation selecting a changed field.
  anonymous: /* GraphQL */ `
    {
      status
    }
  `,
};
