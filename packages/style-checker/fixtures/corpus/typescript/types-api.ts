// Style: camelCase vars/fns, PascalCase types, SCREAMING_SNAKE constants
// Formatting: no semicolons, single quotes
// Docs: JSDoc on exports only

const API_VERSION = 'v1'
const DEFAULT_PAGE_SIZE = 20

interface PaginationParams {
  page: number
  pageSize: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

interface ApiError {
  code: string
  message: string
  details?: Record<string, unknown>
}

interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: ApiError
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

interface RouteDefinition {
  method: HttpMethod
  path: string
  auth: boolean
  rateLimit?: number
}

interface UserDto {
  id: string
  name: string
  email: string
  role: string
  createdAt: string
}

interface CreateUserDto {
  name: string
  email: string
  password: string
  role?: string
}

/** Builds a success API response wrapper. */
export function successResponse<T>(data: T): ApiResponse<T> {
  return { success: true, data }
}

/** Builds an error API response wrapper. */
export function errorResponse(code: string, message: string): ApiResponse<never> {
  return { success: false, error: { code, message } }
}

/** Creates default pagination params from query values. */
export function defaultPagination(
  page?: number,
  pageSize?: number
): PaginationParams {
  return {
    page: page ?? 1,
    pageSize: pageSize ?? DEFAULT_PAGE_SIZE,
  }
}
