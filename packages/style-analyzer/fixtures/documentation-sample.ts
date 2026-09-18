// @ts-nocheck
/**
 * Fetches a user profile from the API.
 *
 * @param userId - The user's unique identifier
 * @returns The user profile object
 * @throws {NotFoundError} If the user does not exist
 */
export function fetchUserProfile(userId: string): Promise<UserProfile> {
  return api.get(`/users/${userId}`);
}

/** Validates email format. */
export function validateEmail(email: string): boolean {
  return /^[^@]+@[^@]+\.[^@]+$/.test(email);
}

// This is a helper that normalizes whitespace
function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function undocumentedPublicFunction(data: unknown): void {
  console.log(data);
}

function undocumentedPrivateFunction(): number {
  return 42;
}

export class UserService {
  /**
   * Creates a new user in the database.
   *
   * @param name - Display name
   * @param email - Email address
   */
  async createUser(name: string, email: string): Promise<User> {
    return this.db.insert({ name, email });
  }

  // Quick lookup by ID
  async getUser(id: string): Promise<User | null> {
    return this.db.findById(id); // inline trailing comment
  }

  private async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  }
}

// Section: Utility functions
// These helpers are used across the codebase

function helperA() {
  return 1;
}

function helperB() {
  return 2; // trailing
}
