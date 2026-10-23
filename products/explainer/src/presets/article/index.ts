export { extractFigures, tableData, type ExtractedFigure, type FigureNote } from "./figures.js";
export {
  checkClaims,
  gatherArticle,
  parseArticleFacts,
  writeArticleGather,
  type ArticleGatherFiles,
  type GatherArticleOptions,
  type GatherArticleResult,
  type RejectedClaim,
} from "./gather-article.js";
export { isShortQuote, isVerbatim, normalizeText, quoteStates } from "./quotes.js";
export {
  ARTICLE_FACT_KINDS,
  ArticleClaimSchema,
  ArticleFactSchema,
  FigureDataSchema,
  FigureSeriesSchema,
  QUOTE_MAX_WORDS,
  type ArticleClaim,
  type ArticleFact,
  type FigureData,
  type FigureSeries,
} from "./schemas.js";
export { ARTICLE_PUBLISH_CHECKS, paperPublishEligibility, type PublishEligibility, type PublishIssue } from "../../article-checks.js";
