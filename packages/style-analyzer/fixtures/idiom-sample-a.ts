async function getUser(id: string) {
  try {
    const res = await fetch(`/api/users/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("Failed to fetch user:", err);
    throw err;
  }
}

async function getPost(id: string) {
  try {
    const res = await fetch(`/api/posts/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("Failed to fetch post:", err);
    throw err;
  }
}

async function getComment(id: string) {
  try {
    const res = await fetch(`/api/comments/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("Failed to fetch comment:", err);
    throw err;
  }
}
