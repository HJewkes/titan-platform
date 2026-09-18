export async function fetchTeamMembers(teamId: string) {
  try {
    const response = await fetch(`/api/teams/${teamId}/members`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Failed to fetch members:", error);
    throw error;
  }
}
