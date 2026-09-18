// Style: camelCase vars/fns, PascalCase types, SCREAMING_SNAKE constants
// Formatting: no semicolons, single quotes
// Docs: JSDoc on exports only | Errors: typed catch | Flow: early returns
import * as crypto from 'node:crypto'

import { jwt } from 'jsonwebtoken'

import type { Request, Response } from '@app/http'
import { userService } from '@app/services'

import { validateCredentials } from './validation'

const TOKEN_EXPIRY_SECONDS = 3600
const REFRESH_TOKEN_BYTES = 32

interface AuthPayload {
  userId: string
  email: string
  role: string
}

interface LoginResult {
  accessToken: string
  refreshToken: string
}

/** Authenticates a user and returns JWT tokens. */
export async function login(req: Request): Promise<LoginResult> {
  const { email, password } = req.body

  if (!email || !password) {
    throw new AuthError('missing_credentials', 'Email and password required')
  }

  const user = await userService.verifyPassword(email, password)

  if (!user) {
    throw new AuthError('invalid_credentials', 'Wrong email or password')
  }

  const payload: AuthPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
  }

  const accessToken = jwt.sign(payload, { expiresIn: TOKEN_EXPIRY_SECONDS })
  const refreshToken = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('hex')

  return { accessToken, refreshToken }
}

/** Validates a refresh token and issues a new access token. */
export async function refresh(req: Request): Promise<{ accessToken: string }> {
  const tokenValue = req.headers?.authorization?.replace('Bearer ', '')

  if (!tokenValue) {
    throw new AuthError('missing_token', 'No refresh token provided')
  }

  try {
    const session = await userService.findSession(tokenValue)
    const accessToken = jwt.sign(session.payload, { expiresIn: TOKEN_EXPIRY_SECONDS })
    return { accessToken }
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      throw new AuthError('token_expired', 'Refresh token has expired')
    }
    throw error
  }
}
