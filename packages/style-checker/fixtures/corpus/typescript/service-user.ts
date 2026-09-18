// Style: camelCase vars/fns, PascalCase types, SCREAMING_SNAKE constants
// Formatting: no semicolons, single quotes
// Docs: JSDoc on exports only | Errors: typed catch | Flow: early returns
import * as crypto from 'node:crypto'

import { z } from 'zod'

import { db } from '@app/database'
import type { Logger } from '@app/logging'

import { hashPassword } from './auth-utils'
import type { UserRow } from './types'

const MAX_LOGIN_ATTEMPTS = 5
const SESSION_TTL_MS = 3_600_000

interface UserCreateInput {
  name: string
  email: string
  password: string
}

interface UserResponse {
  id: string
  name: string
  email: string
}

/** Creates a new user and returns the sanitized response. */
export async function createUser(input: UserCreateInput): Promise<UserResponse> {
  if (!input.email?.includes('@')) {
    throw new ValidationError('email', 'Invalid email format')
  }

  const hashedPassword = await hashPassword(input.password)
  const userId = crypto.randomUUID()

  const row = await db.insert('users', {
    id: userId,
    name: input.name,
    email: input.email,
    password: hashedPassword,
  })

  return toUserResponse(row)
}

/** Finds a user by ID, returning null if not found. */
export async function findUserById(id: string): Promise<UserResponse | null> {
  if (!id) {
    return null
  }

  try {
    const row = await db.findOne('users', { id })
    return row ? toUserResponse(row) : null
  } catch (error) {
    if (error instanceof DatabaseError) {
      throw new ServiceError('user_lookup_failed', error.message)
    }
    throw error
  }
}

function toUserResponse(row: UserRow): UserResponse {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
  }
}
