def add(a, b):
    return a + b


def process_data(input_list):
    results = []
    seen = set()
    errors = []
    count = 0

    for item in input_list:
        if item in seen:
            continue
        seen.add(item)

        trimmed = item.strip()
        if len(trimmed) == 0:
            errors.append("empty")
            continue

        upper = trimmed.upper()
        results.append(upper)
        count += 1

    if len(errors) > 0:
        print(errors)

    return results


def deeply_nested(data):
    if data:
        if isinstance(data, dict):
            if "items" in data:
                for item in data["items"]:
                    if isinstance(item, str):
                        return item
    return ""
