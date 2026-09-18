# Guard clauses / early return
def process_user(user):
    if user is None:
        return None
    if not user.get("active"):
        return None
    return user["name"].upper()


# Ternary (conditional expression)
label = "yes" if True else "no"
status = "active" if False else "inactive"


# List comprehension (array method equivalent)
nums = [1, 2, 3, 4, 5]
doubled = [n * 2 for n in nums]
evens = [n for n in nums if n % 2 == 0]


# For loop
def sum_array(arr):
    total = 0
    for n in arr:
        total += n
    return total


# Async/await
async def fetch_data(url):
    response = await aiohttp.get(url)
    data = await response.json()
    return data
