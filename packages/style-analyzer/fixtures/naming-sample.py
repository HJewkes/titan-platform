# Variables: snake_case
user_name = "Alice"
account_balance = 100
is_active = True
has_permission = False

# Constants: SCREAMING_SNAKE
MAX_RETRIES = 3
API_BASE_URL = "https://api.example.com"

# Functions: snake_case
def fetch_user_profile(user_id: str):
    return user_id

def calculate_total(items: list[int]) -> int:
    return sum(items)

# Classes: PascalCase
class HttpClient:
    def __init__(self, base_url: str):
        self._base_url = base_url

    def get_data(self, endpoint: str):
        return endpoint

# Parameters: snake_case
def process_order(order_id: str, item_count: int):
    return {"order_id": order_id, "item_count": item_count}
