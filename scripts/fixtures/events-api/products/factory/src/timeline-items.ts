export const query = "query { repository(owner: \"o\", name: \"r\") { pullRequest(number: 1) { timelineItems(first: 10) { totalCount } } } }";
