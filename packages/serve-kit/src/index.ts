export { authorized, checkToken, MIN_TOKEN_LENGTH, TokenError } from "./auth";
export {
  type AdapterBackend,
  AdapterError,
  type Attachment,
  type Cursor,
  type ErrorEnvelope,
  type MediaFile,
  type Message,
  type MessagesAnswer,
  type Reaction,
  type ReadMessagesRequest,
  type Room,
  type RoomsAnswer,
  type SendAnswer,
  type SendOptions,
  type SendRequest,
  type StreamCursor,
  type StreamMessage,
  type StreamPing,
  type StreamReady,
  type StreamUpdate,
  type UploadFile,
  type UploadOptions,
} from "./backend";
export {
  type Capabilities,
  capabilityRevision,
  type ExtensionId,
  FEATURE_IDS,
  type FeatureId,
  type FeatureParams,
  type Features,
  type RoomFeatures,
} from "./capabilities";
export {
  CONTRACT_VERSION,
  OPTIONAL_EVENTS,
  RESERVED_FEATURES,
} from "./contract";
export { type ErrorCode, failure, ok, STATUS } from "./envelope";
export type { ProviderIcon } from "./icon";
export { mediaHeaders } from "./media";
export {
  type Registration,
  registrationFromEnv,
  startRegistration,
} from "./register";
export { type AdapterOptions, createHandler, serve } from "./server";
