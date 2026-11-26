import {
  type ProviderHttp,
  asObject,
  carrierKey,
  readObject,
  SignInRejectedError,
  text,
  TransientError,
  type Json,
  type SessionStore,
} from "../../provider/api.js";

export const IDENTITY_HOST = "identity.anpost.com";
/** The public site key An Post's own web pages use for their identity service. Not a secret. */
const siteKey = (): string => carrierKey("an_post", "site_key");
const OK = 0;
const WRONG_CREDENTIALS = 403042;
const SESSION_EXPIRED = 403007;
/** Gigya codes after a fresh sign-in that mean the account itself is refused, not a hiccup. */
const SESSION_REFUSED = new Set([403005, 403007, 403042, 403044]);

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

export interface AnPostSession {
  readonly uid: string;
  readonly loginToken: string;
  readonly gmid: string;
}

/** The identity service answers HTTP 200 for everything; `errorCode` carries the outcome. */
async function call(
  http: ProviderHttp,
  method: string,
  form: Record<string, string>,
): Promise<Json> {
  const response = await http.request(new URL(`https://${IDENTITY_HOST}/${method}`), {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams({ apiKey: siteKey(), format: "json", ...form }),
  });
  if (response.status >= 500) {
    throw new TransientError(`An Post's sign-in service answered HTTP ${response.status}.`);
  }
  return readObject(response, "An Post's sign-in service");
}

/** A browser id the service hands out first; sign-in works without one, so it is best effort. */
async function browserId(http: ProviderHttp): Promise<string> {
  const url = new URL(`https://${IDENTITY_HOST}/accounts.webSdkBootstrap`);
  url.searchParams.set("apiKey", siteKey());
  url.searchParams.set("format", "json");
  const response = await http.request(url, { headers: { accept: "application/json" } });
  for (const cookie of response.headers.getSetCookie()) {
    const match = /^gmid=([^;]+)/.exec(cookie);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return "";
}

async function signIn(http: ProviderHttp, credentials: Credentials): Promise<AnPostSession> {
  const gmid = await browserId(http);
  const answer = await call(http, "accounts.login", {
    loginID: credentials.username,
    password: credentials.password,
    gmid,
    include: "profile,data",
  });
  if (answer["errorCode"] === WRONG_CREDENTIALS) {
    throw new SignInRejectedError("An Post refused the e-mail address or password.");
  }
  if (answer["errorCode"] !== OK) {
    throw new TransientError(`An Post's sign-in failed (error ${String(answer["errorCode"])}).`);
  }
  const uid = text(answer["UID"]);
  const loginToken = text(asObject(answer["sessionInfo"])["cookieValue"]);
  if (uid === null || loginToken === null) {
    throw new TransientError("An Post's sign-in answer had no session.");
  }
  return { uid, loginToken, gmid };
}

function stored(session: SessionStore): AnPostSession | null {
  const value = asObject(session.load());
  const uid = text(value["uid"]);
  const loginToken = text(value["loginToken"]);
  return uid === null || loginToken === null
    ? null
    : { uid, loginToken, gmid: text(value["gmid"]) ?? "" };
}

async function shortToken(http: ProviderHttp, session: AnPostSession): Promise<Json> {
  return call(http, "accounts.getJWT", {
    login_token: session.loginToken,
    UID: session.uid,
    lang: "en",
    gmid: session.gmid,
  });
}

/**
 * A short-lived token for the deliveries API. The stored session is reused; only when the
 * service says it has expired does the provider sign in again with the stored password, once.
 */
export async function idToken(
  http: ProviderHttp,
  store: SessionStore,
  credentials: Credentials,
): Promise<{ token: string; uid: string }> {
  let session = stored(store) ?? (await signIn(http, credentials));
  await store.save(session);
  let answer = await shortToken(http, session);
  if (answer["errorCode"] === SESSION_EXPIRED) {
    session = await signIn(http, credentials);
    await store.save(session);
    answer = await shortToken(http, session);
  }
  const code = answer["errorCode"];
  if (code !== OK && typeof code === "number" && SESSION_REFUSED.has(code)) {
    await store.save(null);
    throw new SignInRejectedError("An Post no longer accepts the stored session.");
  }
  if (code !== OK) {
    throw new TransientError(`An Post's token request failed (error ${String(code)}).`);
  }
  const token = text(answer["id_token"]);
  if (token === null) {
    throw new TransientError("An Post's token answer had no token.");
  }
  return { token, uid: session.uid };
}
