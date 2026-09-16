export type {
  ChatPart,
  DataPart,
  FilePart,
  PartStreamState,
  ProviderMetadata,
  ReasoningPart,
  SourceDocumentPart,
  SourceUrlPart,
  StepStartPart,
  TextPart,
  ToolApproval,
  ToolPart,
  ToolPartState,
} from "./parts.js";
export {
  DATA_PART_KEY_PATTERN,
  chatPart,
  dataPart,
  filePart,
  isDataPartType,
  isToolPartType,
  providerMetadata,
  reasoningPart,
  sourceDocumentPart,
  sourceUrlPart,
  stepStartPart,
  textPart,
  toolApproval,
  toolPart,
} from "./parts.js";

export type {
  AddressScheme,
  ChatMessage,
  ChatThread,
  DeliveryState,
  DeliveryStatus,
  MessageRole,
  Participant,
  ParticipantAddress,
  ParticipantKind,
  Provenance,
  ThreadKind,
} from "./envelope.js";
export {
  addressScheme,
  chatMessage,
  chatThread,
  deliveryState,
  deliveryStatus,
  inboundChatMessage,
  markHumanEndorsed,
  messageRole,
  participant,
  participantKind,
  provenance,
  threadKind,
} from "./envelope.js";

export { TRANSPORT_DELIVERY_CEILING, capDeliveryStatus } from "./delivery.js";

export type { ChatEnvelope, UIMessageLike } from "./ai-sdk.js";
export { fromUIMessage, toUIMessage } from "./ai-sdk.js";

export type {
  InboundContext,
  MessagingInbound,
  MessagingSendInput,
  MessagingSendResult,
  OutboundResult,
} from "./adapters/messaging.js";
export {
  deliveryFromSendResult,
  fromMessagingInbound,
  toMessagingOutbound,
} from "./adapters/messaging.js";

export type { GateAnswer, GateContext, GateSnapshot } from "./adapters/hitl.js";
export { GATE_PART_TYPE, GATE_TOOL_NAME, fromHitlGate, toHitlAnswer } from "./adapters/hitl.js";
