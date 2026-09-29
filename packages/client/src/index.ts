import { DeliveryInput } from "@otp-router/server/api";
import { Effect, Schema } from "effect";
import type {
  ClientOptions,
  ClientResponse,
  ChallengeDecodeDto,
  DeliveryDecodeDto,
  VerificationDecodeDto,
  ChallengeDeliveryDecodeDto,
  OperationPageDecodeDto,
  AttemptPageDecodeDto,
  AttemptDecodeDto,
  EventPageDecodeDto,
  CreateChallengeTransferDto,
  VerifyChallengeTransferDto,
  DeliveryActionTransferDto,
  PrepareDeliveryTransferDto,
  CreateDeliveryTransferDto,
  SubmitDeliveryCodeTransferDto,
  HistoryQueryDto,
  EventsQueryDto,
  MutationOptions,
  RequestOptions,
} from "./contracts.js";
import { makeTransport } from "./transport.js";
export type * from "./contracts.js";
export * from "./errors.js";

const deliveryRequest = <P>(
  params: P,
  input: DeliveryActionTransferDto,
  request: MutationOptions,
) =>
  Schema.decodeUnknownEffect(DeliveryInput)(input).pipe(
    Effect.map((payload) => {
      const common = {
        params,
        headers: { "idempotency-key": request.idempotencyKey },
        responseMode: "decoded-and-response" as const,
      };
      // HttpApiClient distributes its request type across payload union members.
      switch (payload.action) {
        case "resend":
          return { ...common, payload };
        case "next":
          return { ...common, payload };
        case "select":
          return { ...common, payload };
      }
    }),
  );

/** A backend-only client. Mutations never retry or generate idempotency keys. */
export const createClient = (options: ClientOptions) => {
  const execute = makeTransport(options);
  const params = { projectId: options.projectId };
  const mutationHeaders = (request: MutationOptions) => ({
    "idempotency-key": request.idempotencyKey,
  });
  return {
    createChallenge: (
      input: CreateChallengeTransferDto,
      request: MutationOptions,
    ): Promise<ClientResponse<ChallengeDecodeDto>> =>
      execute(
        (client) =>
          client.application.createChallenge({
            params,
            payload: input,
            headers: mutationHeaders(request),
            responseMode: "decoded-and-response",
          }),
        request,
      ),
    getChallenge: (
      challengeId: string,
      request: RequestOptions = {},
    ): Promise<ClientResponse<ChallengeDecodeDto>> =>
      execute(
        (client) =>
          client.application.getChallengeStatus({
            params: { ...params, challengeId },
            responseMode: "decoded-and-response",
          }),
        request,
      ),
    verifyChallenge: (
      challengeId: string,
      input: VerifyChallengeTransferDto,
      request: MutationOptions,
    ): Promise<ClientResponse<VerificationDecodeDto>> =>
      execute(
        (client) =>
          client.application.verifyChallenge({
            params: { ...params, challengeId },
            payload: input,
            headers: mutationHeaders(request),
            responseMode: "decoded-and-response",
          }),
        request,
      ),
    sendChallenge: (
      challengeId: string,
      input: DeliveryActionTransferDto,
      request: MutationOptions,
    ): Promise<ClientResponse<ChallengeDeliveryDecodeDto>> =>
      execute(
        (client) =>
          deliveryRequest({ ...params, challengeId }, input, request).pipe(
            Effect.flatMap((encoded) => client.application.scheduleDelivery(encoded)),
          ),
        request,
      ),
    cancelChallenge: (
      challengeId: string,
      request: MutationOptions,
    ): Promise<ClientResponse<ChallengeDecodeDto>> =>
      execute(
        (client) =>
          client.application.cancelChallenge({
            params: { ...params, challengeId },
            payload: {},
            headers: mutationHeaders(request),
            responseMode: "decoded-and-response",
          }),
        request,
      ),
    prepareDelivery: (
      input: PrepareDeliveryTransferDto,
      request: MutationOptions,
    ): Promise<ClientResponse<DeliveryDecodeDto>> =>
      execute(
        (client) =>
          client.application.prepareDelivery({
            params,
            payload: input,
            headers: mutationHeaders(request),
            responseMode: "decoded-and-response",
          }),
        request,
      ),
    createDelivery: (
      input: CreateDeliveryTransferDto,
      request: MutationOptions,
    ): Promise<ClientResponse<DeliveryDecodeDto>> =>
      execute(
        (client) =>
          client.application.createDelivery({
            params,
            payload: input,
            headers: mutationHeaders(request),
            responseMode: "decoded-and-response",
          }),
        request,
      ),
    getDelivery: (
      operationId: string,
      request: RequestOptions = {},
    ): Promise<ClientResponse<DeliveryDecodeDto>> =>
      execute(
        (client) =>
          client.application.getDelivery({
            params: { ...params, operationId },
            responseMode: "decoded-and-response",
          }),
        request,
      ),
    submitDeliveryCode: (
      operationId: string,
      input: SubmitDeliveryCodeTransferDto,
      request: MutationOptions,
    ): Promise<ClientResponse<DeliveryDecodeDto>> =>
      execute(
        (client) =>
          client.application.submitDeliveryCode({
            params: { ...params, operationId },
            payload: input,
            headers: mutationHeaders(request),
            responseMode: "decoded-and-response",
          }),
        request,
      ),
    sendDelivery: (
      operationId: string,
      input: DeliveryActionTransferDto,
      request: MutationOptions,
    ): Promise<ClientResponse<DeliveryDecodeDto>> =>
      execute(
        (client) =>
          deliveryRequest({ ...params, operationId }, input, request).pipe(
            Effect.flatMap((encoded) => client.application.sendDelivery(encoded)),
          ),
        request,
      ),
    closeDelivery: (
      operationId: string,
      request: MutationOptions,
    ): Promise<ClientResponse<DeliveryDecodeDto>> =>
      execute(
        (client) =>
          client.application.closeDelivery({
            params: { ...params, operationId },
            payload: {},
            headers: mutationHeaders(request),
            responseMode: "decoded-and-response",
          }),
        request,
      ),
    listOperations: (
      query: HistoryQueryDto = {},
      request: RequestOptions = {},
    ): Promise<ClientResponse<OperationPageDecodeDto>> =>
      execute(
        (client) =>
          client.history.operations({ params, query, responseMode: "decoded-and-response" }),
        request,
      ),
    listAttempts: (
      operationId: string,
      query: HistoryQueryDto = {},
      request: RequestOptions = {},
    ): Promise<ClientResponse<AttemptPageDecodeDto>> =>
      execute(
        (client) =>
          client.history.attempts({
            params: { ...params, operationId },
            query,
            responseMode: "decoded-and-response",
          }),
        request,
      ),
    getAttempt: (
      attemptId: string,
      request: RequestOptions = {},
    ): Promise<ClientResponse<AttemptDecodeDto>> =>
      execute(
        (client) =>
          client.history.attempt({
            params: { ...params, attemptId },
            responseMode: "decoded-and-response",
          }),
        request,
      ),
    listEvents: (
      query: EventsQueryDto = {},
      request: RequestOptions = {},
    ): Promise<ClientResponse<EventPageDecodeDto>> =>
      execute(
        (client) => client.history.events({ params, query, responseMode: "decoded-and-response" }),
        request,
      ),
  };
};

export type OtpRouterClient = ReturnType<typeof createClient>;
