import type { ApiErrorDto, ResponseMetadata } from "./contracts.js";

export class OtpRouterApiError extends Error {
  readonly _tag = "OtpRouterApiError";
  readonly code: ApiErrorDto["code"];
  readonly requestId: string;
  readonly retryAt: string | undefined;
  readonly error: ApiErrorDto;
  readonly status: number;
  readonly replayed: boolean;
  readonly retryAfter: string | null;

  constructor(error: ApiErrorDto, metadata: ResponseMetadata) {
    super(error.message);
    this.name = "OtpRouterApiError";
    this.code = error.code;
    this.requestId = error.requestId;
    this.retryAt = error.retryAt;
    this.error = error;
    this.status = metadata.status;
    this.replayed = metadata.replayed;
    this.retryAfter = metadata.retryAfter;
  }
}

export type ClientErrorKind =
  | "configuration"
  | "invalid_request"
  | "invalid_response"
  | "transport"
  | "timeout"
  | "aborted"
  | "defect";

export interface ClientErrorDto {
  readonly type: ClientErrorKind;
}

export class OtpRouterClientError extends Error {
  readonly _tag = "OtpRouterClientError";
  readonly kind: ClientErrorKind;
  readonly error: ClientErrorDto;
  readonly response: ResponseMetadata | undefined;

  constructor(kind: ClientErrorKind, response?: ResponseMetadata) {
    super(`OTP Router client ${kind.replaceAll("_", " ")}`);
    this.name = "OtpRouterClientError";
    this.kind = kind;
    this.error = { type: kind };
    this.response = response;
  }
}
