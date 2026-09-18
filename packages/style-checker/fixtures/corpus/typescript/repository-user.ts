// Style: camelCase vars/fns, PascalCase types, SCREAMING_SNAKE constants
// Formatting: no semicolons, single quotes
// Docs: JSDoc on exports only | Errors: typed catch | Flow: early returns

import type { DatabaseClient, QueryResult } from '@app/database'
import { logger } from '@app/logging'

import type { UserRow } from './types'

const USERS_TABLE = 'users'
const DEFAULT_LIMIT = 50

interface FindOptions {
  limit?: number
  offset?: number
  orderBy?: string
}

export class UserRepository {
  private client: DatabaseClient

  constructor(client: DatabaseClient) {
    this.client = client
  }

  /** Finds a user by primary key. */
  async findById(id: string): Promise<UserRow | null> {
    if (!id) {
      return null
    }

    try {
      const result = await this.client.query(
        `SELECT * FROM ${USERS_TABLE} WHERE id = $1`,
        [id]
      )
      return result.rows[0] ?? null
    } catch (error) {
      if (error instanceof ConnectionError) {
        logger.error('Database connection failed during user lookup')
      }
      throw error
    }
  }

  /** Lists users with pagination support. */
  async findMany(options: FindOptions = {}): Promise<UserRow[]> {
    const limit = options.limit ?? DEFAULT_LIMIT
    const offset = options.offset ?? 0
    const orderBy = options.orderBy ?? 'created_at'

    const result = await this.client.query(
      `SELECT * FROM ${USERS_TABLE} ORDER BY ${orderBy} LIMIT $1 OFFSET $2`,
      [limit, offset]
    )

    return result.rows
  }

  /** Inserts a new user row and returns it. */
  async insert(row: Omit<UserRow, 'id'>): Promise<UserRow> {
    const result = await this.client.query(
      `INSERT INTO ${USERS_TABLE} (name, email, password) VALUES ($1, $2, $3) RETURNING *`,
      [row.name, row.email, row.password]
    )

    return result.rows[0]
  }

  /** Deletes a user by ID, returning true if a row was removed. */
  async deleteById(id: string): Promise<boolean> {
    if (!id) {
      return false
    }

    const result = await this.client.query(
      `DELETE FROM ${USERS_TABLE} WHERE id = $1`,
      [id]
    )

    return result.rowCount > 0
  }
}
