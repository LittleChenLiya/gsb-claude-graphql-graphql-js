import assert from 'node:assert';
import { describe, it } from 'node:test';

import { expect } from 'chai';

import type { OperationDefinitionNode } from '../../language/ast.ts';
import { Kind } from '../../language/kinds.ts';
import { parse } from '../../language/parser.ts';

import { buildSchema } from '../buildASTSchema.ts';
import {
  summarizeVariables,
  VARIABLE_SUMMARY_REDACTED,
} from '../summarizeVariables.ts';

const schema = buildSchema(`
  input UserInput {
    name: String
    password: String
    secretCode: Int
    tags: [String]
  }

  input CatInput {
    name: String
    secret: String
  }

  input DogInput {
    name: String
    secret: String
  }

  input PetInput @oneOf {
    cat: CatInput
    dog: DogInput
  }

  enum Role {
    ADMIN
    USER
  }

  type Query {
    users(
      users: [UserInput]
      input: UserInput
      pet: PetInput
      role: Role
    ): [String]
  }
`);

function operationOf(source: string): OperationDefinitionNode {
  const document = parse(source);
  const operation = document.definitions[0];
  assert(operation.kind === Kind.OPERATION_DEFINITION);
  return operation;
}

describe('summarizeVariables', () => {
  it('masks sensitive fields in every element of a nested users list', () => {
    const operation = operationOf(`
      query ($users: [UserInput]) {
        users(users: $users)
      }
    `);
    const variables = {
      users: [
        { name: 'Ada', password: 'pw-ada', tags: ['a', 'b'] },
        { name: 'Grace', password: 'pw-grace' },
        { name: 'Linus', password: null },
      ],
    };
    const variablesSnapshot = JSON.parse(JSON.stringify(variables));

    const result = summarizeVariables(schema, operation, variables, {
      sensitivePaths: ['users[].password'],
    });

    assert('summary' in result);
    expect(result.summary).to.deep.equal({
      users: {
        status: 'provided',
        value: [
          { name: 'Ada', password: '[REDACTED]', tags: ['a', 'b'] },
          { name: 'Grace', password: '[REDACTED]' },
          { name: 'Linus', password: null },
        ],
      },
    });
    // The original variables object must not be mutated.
    expect(variables).to.deep.equal(variablesSnapshot);
  });

  it('masks variable default values, including default passwords', () => {
    const operation = operationOf(`
      query ($input: UserInput = { name: "Anon", password: "default-s3cr3t" }) {
        users(input: $input)
      }
    `);

    const result = summarizeVariables(
      schema,
      operation,
      {},
      {
        sensitivePaths: ['input.password'],
      },
    );

    assert('summary' in result);
    expect(result.summary).to.deep.equal({
      input: {
        status: 'default',
        value: { name: 'Anon', password: '[REDACTED]' },
      },
    });
  });

  it('distinguishes provided, default, null, and not provided variables', () => {
    const operation = operationOf(`
      query ($a: UserInput, $b: UserInput, $c: UserInput = { name: "D" }) {
        users(input: $c)
      }
    `);

    const result = summarizeVariables(
      schema,
      operation,
      { b: null },
      { sensitivePaths: ['c.name'] },
    );

    assert('summary' in result);
    expect(result.summary).to.deep.equal({
      a: { status: 'notProvided' },
      b: { status: 'provided', value: null },
      c: { status: 'default', value: { name: '[REDACTED]' } },
    });
    expect(Object.hasOwn(result.summary.a, 'value')).to.equal(false);
  });

  it('masks oneOf input values via wildcard segments', () => {
    const operation = operationOf(`
      query ($pet: PetInput) {
        users(pet: $pet)
      }
    `);

    const result = summarizeVariables(
      schema,
      operation,
      { pet: { cat: { name: 'Tom', secret: 'cat-secret' } } },
      { sensitivePaths: ['pet.*.secret'] },
    );

    assert('summary' in result);
    expect(result.summary).to.deep.equal({
      pet: {
        status: 'provided',
        value: { cat: { name: 'Tom', secret: '[REDACTED]' } },
      },
    });
  });

  it('returns sanitized errors for invalid oneOf inputs', () => {
    const operation = operationOf(`
      query ($pet: PetInput) {
        users(pet: $pet)
      }
    `);

    const result = summarizeVariables(
      schema,
      operation,
      {
        pet: {
          cat: { name: 'Tom', secret: 'cat-secret' },
          dog: { name: 'Rex', secret: 'dog-secret' },
        },
      },
      { sensitivePaths: ['pet.*.secret'] },
    );

    assert('errors' in result);
    expect(result.errors).to.have.lengthOf(1);
    const { message } = result.errors[0];
    expect(message).to.not.contain('cat-secret');
    expect(message).to.not.contain('dog-secret');
  });

  it('masks enum values and sanitizes enum coercion errors', () => {
    const operation = operationOf(`
      query ($role: Role) {
        users(role: $role)
      }
    `);

    const valid = summarizeVariables(
      schema,
      operation,
      { role: 'ADMIN' },
      { sensitivePaths: ['role'] },
    );
    assert('summary' in valid);
    expect(valid.summary).to.deep.equal({
      role: { status: 'provided', value: '[REDACTED]' },
    });

    const invalid = summarizeVariables(
      schema,
      operation,
      { role: 'SUPER_SECRET_ROLE' },
      { sensitivePaths: ['role'] },
    );
    assert('errors' in invalid);
    expect(invalid.errors).to.have.lengthOf(1);
    const { message } = invalid.errors[0];
    expect(message).to.not.contain('SUPER_SECRET_ROLE');
    expect(message).to.contain('[REDACTED]');
  });

  it('sanitizes sensitive values referenced by unknown field errors', () => {
    const operation = operationOf(`
      query ($input: UserInput) {
        users(input: $input)
      }
    `);

    const result = summarizeVariables(
      schema,
      operation,
      { input: { name: 'Ada', password: 'hunter2', bogus: true } },
      { sensitivePaths: ['input.password'] },
    );

    assert('errors' in result);
    expect(result.errors).to.have.lengthOf(1);
    const { message } = result.errors[0];
    expect(message).to.contain('bogus');
    expect(message).to.not.contain('hunter2');
    expect(message).to.contain('[REDACTED]');
  });

  it('sanitizes sensitive values coming from variable defaults in errors', () => {
    const operation = operationOf(`
      query ($input: UserInput = { password: "d3fault-pw", bogus: 1 }) {
        users(input: $input)
      }
    `);

    const result = summarizeVariables(
      schema,
      operation,
      {},
      {
        sensitivePaths: ['input.password'],
      },
    );

    assert('errors' in result);
    expect(result.errors).to.have.lengthOf(1);
    const { message } = result.errors[0];
    expect(message).to.contain('bogus');
    expect(message).to.not.contain('d3fault-pw');
    expect(message).to.contain('[REDACTED]');
  });

  it('supports numeric index paths and ignores out-of-range indexes', () => {
    const operation = operationOf(`
      query ($users: [UserInput]) {
        users(users: $users)
      }
    `);
    const variables = {
      users: [
        { name: 'Ada', password: 'pw-0' },
        { name: 'Grace', password: 'pw-1' },
        { name: 'Linus', password: 'pw-2' },
      ],
    };

    const result = summarizeVariables(schema, operation, variables, {
      sensitivePaths: [
        'users.0.password',
        'users.2.password',
        'users.9.password',
      ],
    });

    assert('summary' in result);
    expect(result.summary).to.deep.equal({
      users: {
        status: 'provided',
        value: [
          { name: 'Ada', password: '[REDACTED]' },
          { name: 'Grace', password: 'pw-1' },
          { name: 'Linus', password: '[REDACTED]' },
        ],
      },
    });
  });

  it('supports array-form paths and ignores paths not rooted at a variable', () => {
    const operation = operationOf(`
      query ($users: [UserInput]) {
        users(users: $users)
      }
    `);

    const result = summarizeVariables(
      schema,
      operation,
      { users: [{ name: 'Ada', password: 'pw-ada' }] },
      {
        sensitivePaths: [['users', '*', 'password'], [0, 'password'], []],
      },
    );

    assert('summary' in result);
    expect(result.summary).to.deep.equal({
      users: {
        status: 'provided',
        value: [{ name: 'Ada', password: '[REDACTED]' }],
      },
    });
  });

  it('supports the standalone wildcard segment syntax', () => {
    const operation = operationOf(`
      query ($users: [UserInput]) {
        users(users: $users)
      }
    `);

    const result = summarizeVariables(
      schema,
      operation,
      { users: [{ password: 'pw-0' }, { password: 'pw-1' }] },
      { sensitivePaths: ['users.[].password'] },
    );

    assert('summary' in result);
    expect(result.summary).to.deep.equal({
      users: {
        status: 'provided',
        value: [{ password: '[REDACTED]' }, { password: '[REDACTED]' }],
      },
    });
  });

  it('masks every field value for object wildcards', () => {
    const operation = operationOf(`
      query ($input: UserInput) {
        users(input: $input)
      }
    `);

    const result = summarizeVariables(
      schema,
      operation,
      { input: { name: 'Ada', password: 'hunter2' } },
      { sensitivePaths: ['input.*'] },
    );

    assert('summary' in result);
    expect(result.summary).to.deep.equal({
      input: {
        status: 'provided',
        value: { name: '[REDACTED]', password: '[REDACTED]' },
      },
    });
  });

  it('masks a whole variable value while preserving structure', () => {
    const operation = operationOf(`
      query ($input: UserInput) {
        users(input: $input)
      }
    `);

    const result = summarizeVariables(
      schema,
      operation,
      {
        input: {
          name: null,
          password: 'hunter2',
          secretCode: 42,
          tags: ['x', 'y'],
        },
      },
      { sensitivePaths: ['input'] },
    );

    assert('summary' in result);
    expect(result.summary).to.deep.equal({
      input: {
        status: 'provided',
        value: {
          name: null,
          password: '[REDACTED]',
          secretCode: '[REDACTED]',
          tags: ['[REDACTED]', '[REDACTED]'],
        },
      },
    });
  });

  it('leaves values unchanged when paths do not match the structure', () => {
    const operation = operationOf(`
      query ($users: [UserInput], $input: UserInput) {
        users(users: $users, input: $input)
      }
    `);
    const variables = {
      users: [{ name: 'Ada', password: 'pw-ada' }],
      input: { name: 'Grace', password: 'pw-grace' },
    };

    const result = summarizeVariables(schema, operation, variables, {
      sensitivePaths: [
        'users.password', // field path applied to a list
        'input.0.password', // index path applied to an object
        'input.name.first', // field path applied to a scalar
        'input.name.*', // wildcard applied to a scalar
        'input.missing', // unknown field
      ],
    });

    assert('summary' in result);
    expect(result.summary).to.deep.equal({
      users: {
        status: 'provided',
        value: [{ name: 'Ada', password: 'pw-ada' }],
      },
      input: {
        status: 'provided',
        value: { name: 'Grace', password: 'pw-grace' },
      },
    });
  });

  it('supports a custom redaction marker', () => {
    const operation = operationOf(`
      query ($input: UserInput) {
        users(input: $input)
      }
    `);

    const result = summarizeVariables(
      schema,
      operation,
      { input: { password: 'hunter2' } },
      { sensitivePaths: ['input.password'], redactedMarker: '***' },
    );

    assert('summary' in result);
    expect(result.summary).to.deep.equal({
      input: { status: 'provided', value: { password: '***' } },
    });
  });

  it('passes values through when no sensitive paths are declared', () => {
    const operation = operationOf(`
      query ($input: UserInput) {
        users(input: $input)
      }
    `);

    const result = summarizeVariables(schema, operation, {
      input: { name: 'Ada', password: 'hunter2' },
    });

    assert('summary' in result);
    expect(result.summary).to.deep.equal({
      input: {
        status: 'provided',
        value: { name: 'Ada', password: 'hunter2' },
      },
    });
  });

  it('returns an empty summary for operations without variables', () => {
    const operation = operationOf('{ users }');

    const result = summarizeVariables(schema, operation, {});

    assert('summary' in result);
    expect(result.summary).to.deep.equal({});
  });

  it('exports the default redaction marker', () => {
    expect(VARIABLE_SUMMARY_REDACTED).to.equal('[REDACTED]');
  });

  it('collects sensitive values across path shapes when sanitizing errors', () => {
    const operation = operationOf(`
      query (
        $input: UserInput = { name: "D" }
        $users: [UserInput]
        $pw: String
        $other: String
      ) {
        users(users: $users, input: $input)
      }
    `);
    const variables = {
      input: { name: 5, password: '', tags: ['t1', 't2'] },
      users: [{ name: 'Ada', password: null }],
    };

    const result = summarizeVariables(schema, operation, variables, {
      sensitivePaths: [
        'input[].password', // wildcard applied to an object
        'input.password', // empty string secret
        'input.tags', // sensitive list
        'input.name.*', // wildcard applied to a scalar
        'input.name.first', // field path applied to a scalar
        'input.0.password', // index path applied to an object
        'input.missing', // unknown field
        'users[].name', // wildcard applied to a list
        'users.0', // whole list element
        'users.0.password', // null secret
        'pw', // variable that is not provided and has no default
      ],
    });

    assert('errors' in result);
    expect(result.errors).to.have.lengthOf(1);
    expect(result.errors[0].message).to.equal(
      'Variable "$input" has invalid value at .name: String cannot represent a non string value: 5',
    );
  });
});
