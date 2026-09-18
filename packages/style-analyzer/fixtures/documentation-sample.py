def fetch_user_profile(user_id: str) -> dict:
    """Fetch a user profile from the API.

    Args:
        user_id: The user's unique identifier.

    Returns:
        The user profile dictionary.

    Raises:
        NotFoundError: If the user does not exist.
    """
    return api.get(f"/users/{user_id}")


def validate_email(email: str) -> bool:
    """Validate email format."""
    import re
    return bool(re.match(r"^[^@]+@[^@]+\.[^@]+$", email))


# This normalizes whitespace
def normalize_whitespace(input_str: str) -> str:
    return " ".join(input_str.split())


def undocumented_function(data):
    print(data)


class UserService:
    """Service for managing users."""

    def create_user(self, name: str, email: str) -> dict:
        """Create a new user in the database.

        Args:
            name: Display name.
            email: Email address.
        """
        return self.db.insert({"name": name, "email": email})

    def get_user(self, user_id: str) -> dict:
        # Quick lookup by ID
        return self.db.find_by_id(user_id)
