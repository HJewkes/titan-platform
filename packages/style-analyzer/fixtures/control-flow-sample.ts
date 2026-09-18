// Guard clauses / early return
function processUser(user: { active: boolean; name: string } | null) {
  if (!user) return null;
  if (!user.active) return null;
  return user.name.toUpperCase();
}

// Else-after-return (non-guard pattern)
function classify(score: number) {
  if (score >= 90) {
    return "A";
  } else if (score >= 80) {
    return "B";
  } else {
    return "C";
  }
}

// Ternary
const label = true ? "yes" : "no";
const status = false ? "active" : "inactive";

// If/else (non-ternary conditional)
function getLabel(flag: boolean) {
  if (flag) {
    return "on";
  } else {
    return "off";
  }
}

// Array methods
const nums = [1, 2, 3, 4, 5];
const doubled = nums.map((n) => n * 2);
const evens = nums.filter((n) => n % 2 === 0);
const sum = nums.reduce((acc, n) => acc + n, 0);

// For loop (indexed)
function sumArray(arr: number[]) {
  let total = 0;
  for (let i = 0; i < arr.length; i++) {
    total += arr[i];
  }
  return total;
}

// For-of loop
function printAll(items: string[]) {
  for (const item of items) {
    console.log(item);
  }
}

// Async/await
async function fetchData(url: string) {
  const response = await fetch(url);
  const data = await response.json();
  return data;
}

// Promise .then() chain
function fetchDataThen(url: string) {
  return fetch(url)
    .then((res) => res.json())
    .then((data) => data);
}
