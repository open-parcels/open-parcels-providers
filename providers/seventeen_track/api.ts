import {
  isObject,
  num,
  objects,
  readJson,
  SignInRejectedError,
  text,
  TransientError,
  type Json,
  type ProviderContext,
} from "../../provider/api.js";

export const HOST = "api.17track.net";
const API = `https://${HOST}/track/v2.2`;
/** 17TRACK takes at most this many numbers per request. */
export const BATCH = 40;

export interface Secret {
  readonly apiKey: string;
}

export interface Rejection {
  readonly number: string;
  readonly code: number | null;
  readonly message: string;
}

export interface Answer {
  readonly accepted: readonly Json[];
  readonly rejected: readonly Rejection[];
}

/** Rejections that mean the account's quota is used up. */
export function isQuotaRejection(rejection: Pick<Rejection, "code" | "message">): boolean {
  return rejection.code === -18019908 || /quota/iu.test(rejection.message);
}

/** A number 17TRACK has registered already (registering it again is refused, not charged). */
export function isAlreadyRegistered(rejection: Pick<Rejection, "code">): boolean {
  return rejection.code === -18019901;
}

/** A number 17TRACK does not follow (any more): it has to be registered (again). */
export function isNotRegistered(rejection: Pick<Rejection, "code">): boolean {
  return rejection.code === -18019902;
}

function failure(payload: Json): never {
  const errors = objects(isObject(payload["data"]) ? payload["data"]["errors"] : undefined);
  const message = errors.map((error) => text(error["message"]) ?? "").join(" ");
  if (/security key|token|unauthori[sz]ed|access denied/iu.test(message)) {
    throw new SignInRejectedError("17TRACK refused the API key. Enter it again.");
  }
  throw new TransientError(`17TRACK refused the request (code ${String(payload["code"])}).`);
}

/** One call of the 17TRACK API v2.2 with the user's key. */
export async function call(
  context: ProviderContext<unknown, Secret>,
  path: "register" | "gettrackinfo" | "getquota",
  body: unknown,
): Promise<Json> {
  const response = await context.http.request(new URL(`${API}/${path}`), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "17token": context.secret.apiKey,
    },
    body: JSON.stringify(body),
  });
  if (response.status === 401 || response.status === 403) {
    throw new SignInRejectedError("17TRACK refused the API key. Enter it again.");
  }
  if (response.status !== 200) {
    throw new TransientError(`17TRACK answered HTTP ${response.status}.`);
  }
  const payload = readJson(response, "17TRACK");
  if (!isObject(payload)) throw new TransientError("17TRACK answered without a JSON object.");
  if (payload["code"] !== 0) failure(payload);
  return isObject(payload["data"]) ? payload["data"] : {};
}

/** The accepted and rejected numbers of a register or gettrackinfo answer. */
export function answerOf(data: Json): Answer {
  return {
    accepted: objects(data["accepted"]),
    rejected: objects(data["rejected"]).map((entry) => {
      const error = isObject(entry["error"]) ? entry["error"] : {};
      return {
        number: text(entry["number"]) ?? "",
        code: num(error["code"]),
        message: text(error["message"]) ?? "",
      };
    }),
  };
}

/** Numbers the account may still register: the total quota and today's cap, whichever is less. */
export function registrationsLeft(quota: Json): number {
  const remain = num(quota["quota_remain"]) ?? 0;
  const daily = num(quota["max_track_daily"]);
  const today = num(quota["today_used"]) ?? 0;
  return Math.max(0, Math.min(remain, daily === null ? remain : daily - today));
}
