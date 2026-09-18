// Variables: camelCase
const userName = "Alice";
const accountBalance = 100;
let isActive = true;
let hasPermission = false;
const shouldRetry = true;

// Constants: SCREAMING_SNAKE
const MAX_RETRIES = 3;
const API_BASE_URL = "https://api.example.com";

// Functions: camelCase
function fetchUserProfile(userId: string) {
  return userId;
}

const calculateTotal = (items: number[]) => {
  return items.reduce((sum, item) => sum + item, 0);
};

// Types: PascalCase
interface UserProfile {
  name: string;
  age: number;
}

type ApiResponse = {
  data: unknown;
  status: number;
};

enum UserRole {
  Admin = "admin",
  Editor = "editor",
  Viewer = "viewer",
}

// Class: PascalCase
class HttpClient {
  private _baseUrl: string;

  constructor(baseUrl: string) {
    this._baseUrl = baseUrl;
  }

  async getData(endpoint: string) {
    return endpoint;
  }
}

// Parameters: camelCase
function processOrder(orderId: string, itemCount: number) {
  return { orderId, itemCount };
}
