import type { OtpRouterApi, ErrorBody } from "@otp-router/server/api";

type Application = typeof OtpRouterApi.groups.application.endpoints;
type History = typeof OtpRouterApi.groups.history.endpoints;

// HttpApi payload codecs encode to generic JSON; their Type preserves the validated JSON DTO.
export type CreateChallengeTransferDto = Application["createChallenge"]["~Payload"]["Type"];
export type VerifyChallengeTransferDto = Application["verifyChallenge"]["~Payload"]["Type"];
export type DeliveryActionTransferDto = Application["scheduleDelivery"]["~Payload"]["Type"];
export type PrepareDeliveryTransferDto = Application["prepareDelivery"]["~Payload"]["Type"];
export type CreateDeliveryTransferDto = Application["createDelivery"]["~Payload"]["Type"];
export type SubmitDeliveryCodeTransferDto = Application["submitDeliveryCode"]["~Payload"]["Type"];
export type ChallengeDecodeDto = Application["getChallengeStatus"]["~Success"]["Type"];
export type DeliveryDecodeDto = Application["getDelivery"]["~Success"]["Type"];
export type VerificationDecodeDto = Application["verifyChallenge"]["~Success"]["Type"];
export type ChallengeDeliveryDecodeDto = Application["scheduleDelivery"]["~Success"]["Type"];
export type HistoryQueryDto = History["operations"]["~Query"]["Type"];
export type EventsQueryDto = History["events"]["~Query"]["Type"];
export type OperationPageDecodeDto = History["operations"]["~Success"]["Type"];
export type AttemptPageDecodeDto = History["attempts"]["~Success"]["Type"];
export type AttemptDecodeDto = History["attempt"]["~Success"]["Type"];
export type EventPageDecodeDto = History["events"]["~Success"]["Type"];
export type HistoryEventDecodeDto = EventPageDecodeDto["events"][number];
export type ApiErrorDto = typeof ErrorBody.Type.error;
export type ErrorCode = ApiErrorDto["code"];
export type IncorrectCodeErrorDto = Extract<ApiErrorDto, { readonly code: "incorrect_code" }>;

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface MutationOptions extends RequestOptions {
  readonly idempotencyKey: string;
}

export interface ResponseMetadata {
  readonly status: number;
  readonly requestId: string | null;
  readonly replayed: boolean;
  readonly retryAfter: string | null;
}

export interface ClientResponse<A> extends ResponseMetadata {
  readonly data: A;
}

export interface ClientOptions {
  readonly baseUrl: string | URL;
  readonly projectId: string;
  readonly bearerToken: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}
