# try/except with specific exception types
def fetch_user(user_id: str) -> dict:
    try:
        response = requests.get(f"/api/users/{user_id}")
        response.raise_for_status()
        return response.json()
    except requests.HTTPError as e:
        print(f"HTTP error: {e}")
        raise
    except ConnectionError:
        print("Network error")
        raise


# try/except with generic catch
def parse_config(raw: str):
    try:
        return json.loads(raw)
    except Exception:
        return None


# Custom exception class
class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class ValidationError(Exception):
    def __init__(self, field: str, message: str):
        super().__init__(message)
        self.field = field
