import axios from "axios";
import cookieParser from "cookie-parser";
import express, { Request, Response } from "express";
import http from "node:http";
import lz from "lz-ts";
import { createClient } from "redis";

type ExistResponse = {
  status: number;
  headers: Record<string, string>;
  data: string | Buffer;
  binary: boolean;
};

const app = express();
app.use(cookieParser());

const port = process.env.PORT || 3000;

const existUrlBase =
  process.env.EXIST_URL_BASE || "http://localhost:8080/exist/apps/prodomo";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

// How long a successful response stays cached.
const redisExpiry = Number(
  process.env.REDIS_EXPIRY_SEC || 60 * 60 * 24 * 7 * 4
);

// Negative caching: a genuine 404 is cached briefly so that crawlers walking a
// combinatorial URL space stop costing a backend query every time. Kept short so
// that content appearing later is picked up quickly.
const notFoundExpiry = Number(process.env.REDIS_NOT_FOUND_EXPIRY_SEC || 15 * 60);

// eXist can take many seconds for a faceted search; without a timeout a stalled
// request occupies a socket forever.
const upstreamTimeout = Number(process.env.EXIST_TIMEOUT_MS || 30000);

// Node defaults to unlimited sockets, which lets this proxy pile unbounded
// concurrency onto eXist. Bound it so backpressure surfaces here instead.
const upstreamMaxSockets = Number(process.env.EXIST_MAX_SOCKETS || 24);

// Bumped when the cache encoding changes, so stale entries are never
// misinterpreted by newer code.
const keyVersion = "v2";

const transport = axios.create({
  withCredentials: true,
  timeout: upstreamTimeout,
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: upstreamMaxSockets }),
  // Handle every status ourselves. Without this, axios rejects on 4xx/5xx and a
  // backend timeout becomes indistinguishable from a real 404.
  validateStatus: () => true,
});

const prodomoCookies = ["ASPECTSORTING", "SORTING", "PERSONSORTING", "LANG"];

const prodomoHeaders = ["Content-Type"];

const notFoundBody =
  '<html><body>The page you are looking for can not found. Please click <a href="/">here</a> to return home.</body></html>';

const unavailableBody =
  "<html><body>The service is temporarily unavailable. Please try again shortly.</body></html>";

// Anchored on a real extension boundary and tested against the path only, so a
// query string cannot defeat it and a person named "Ludovico" is not mistaken
// for an .ico file.
const binaryPattern = /\.(png|jpe?g|tiff?|ttf|woff2?|ico)$/i;

const redis = createClient({ url: redisUrl });
redis.on("error", (err) => console.error("redis_error", (err as Error).message));
await redis.connect();

// A crash here used to take the whole process down, and Docker restarted it in a
// loop. Log and stay up; genuine programming errors still surface in the log.
process.on("unhandledRejection", (reason) =>
  console.error("unhandled_rejection", reason)
);

const redisKey = (existUrl: string, cookie: string) =>
  `${keyVersion}:` + Buffer.from(`${existUrl}--${cookie}`).toString("base64");

const createExistUrl = (request: Request) => {
  const base = existUrlBase.replace(/\/+$/, "") + request.path;
  const parts: string[] = [];
  const push = (key: string, value: unknown) =>
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  for (const [key, value] of Object.entries(request.query)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => push(key, entry));
    } else if (value !== undefined && value !== null) {
      push(key, value);
    }
  }
  return parts.length > 0 ? `${base}?${parts.join("&")}` : base;
};

const extractCookies = (request: Request) => {
  const cookies: string[] = [];
  for (const name of prodomoCookies) {
    const value: undefined | string = request.cookies[name];
    if (value) {
      cookies.push(`${name}=${value}`);
    }
  }
  return cookies;
};

const serialize = ({ status, headers, data, binary }: ExistResponse): string =>
  lz.compress(
    JSON.stringify({
      status,
      headers,
      binary,
      data: binary ? Array.from(new Uint8Array(data as Buffer)) : data,
    })
  );

const deserialize = (value: string): ExistResponse => {
  const parsed = JSON.parse(lz.decompress(value)) as {
    status?: number;
    headers: Record<string, string>;
    binary?: boolean;
    data: string | number[];
  };
  const binary = parsed.binary === true;
  return {
    // Entries written before status was stored were only ever successes.
    status: parsed.status ?? 200,
    headers: parsed.headers,
    binary,
    data: binary
      ? Buffer.from(Uint8Array.from(parsed.data as number[]))
      : (parsed.data as string),
  };
};

// Collapses concurrent identical requests into one backend query. Without this,
// every miss on a popular URL starts its own eXist search.
const inFlight = new Map<string, Promise<ExistResponse>>();

const fetchFromExist = async (
  existUrl: string,
  cookie: string,
  binary: boolean
): Promise<ExistResponse & { cacheable: boolean }> => {
  try {
    const { status, headers, data } = await transport.get(existUrl, {
      headers: { cookie: cookie || undefined },
      responseType: binary ? "arraybuffer" : "text",
    });
    return {
      status,
      headers: headers as unknown as Record<string, string>,
      data: binary ? Buffer.from(data as ArrayBuffer) : (data as string),
      binary,
      // Only a definite answer is worth storing. 5xx and anything else is
      // treated as transient and retried on the next request.
      cacheable: status === 200 || status === 404,
    };
  } catch (error) {
    // Timeout or connection failure. Crucially this is NOT reported as a 404 and
    // is never cached, so a slow backend cannot poison the cache with
    // "page not found" for pages that exist.
    console.error("exist_error", existUrl, (error as Error).message);
    return {
      status: 502,
      headers: { "Content-Type": "text/html" },
      data: unavailableBody,
      binary: false,
      cacheable: false,
    };
  }
};

const fetchAndStore = (
  key: string,
  existUrl: string,
  cookie: string,
  binary: boolean
): Promise<ExistResponse> => {
  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }
  const pending = fetchFromExist(existUrl, cookie, binary)
    .then(async (result) => {
      if (result.cacheable) {
        const body =
          result.status === 404 && !binary ? notFoundBody : result.data;
        const entry: ExistResponse = { ...result, data: body };
        try {
          // Deliberately stored even when the client has already disconnected:
          // an abandoned request has already cost a backend query, so the result
          // is worth keeping.
          await redis.set(key, serialize(entry), {
            EX: result.status === 404 ? notFoundExpiry : redisExpiry,
          });
        } catch (error) {
          console.error("redis_set_error", (error as Error).message);
        }
        return entry;
      }
      return result;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
};

const handleRequests = async (request: Request, response: Response) => {
  const started = Date.now();
  const cookie = extractCookies(request).join("; ");
  const existUrl = createExistUrl(request);
  const binary = binaryPattern.test(request.path);
  const key = redisKey(existUrl, cookie);

  let entry: ExistResponse | undefined;
  let outcome = "hit";

  try {
    // A single read. The previous exists()+get() pair could race against LRU
    // eviction and return null between the two calls.
    const cached = await redis.get(key);
    if (cached) {
      entry = deserialize(cached);
    }
  } catch (error) {
    console.error("redis_get_error", (error as Error).message);
  }

  if (!entry) {
    outcome = "miss";
    entry = await fetchAndStore(key, existUrl, cookie, binary);
  }

  console.log(
    JSON.stringify({
      t: "req",
      outcome,
      status: entry.status,
      ms: Date.now() - started,
      path: request.originalUrl,
    })
  );

  // The client may have given up while eXist was working. The cache was still
  // filled above, so the effort is not wasted.
  if (response.writableEnded || request.destroyed) {
    return;
  }

  const { headers, data, status } = entry;
  prodomoHeaders.forEach((name) => {
    const value = headers[name] || headers[name.toLowerCase()];
    if (value) {
      response.setHeader(name, value.toString());
    }
  });
  response.status(status);
  if (entry.binary) {
    response.end(data);
  } else {
    response.send(data);
  }
};

app.get("/robots.txt", function (_, res) {
  res.type("text/plain");
  res.send("User-agent: *\nDisallow: /search/");
});

app.get("*", (request, response) => {
  // Express 4 does not catch rejections from async handlers; an unhandled one
  // terminates the process. Everything is funnelled through here.
  handleRequests(request, response).catch((error) => {
    console.error("handler_error", request.originalUrl, error);
    if (!response.headersSent) {
      response.status(502).type("html").send(unavailableBody);
    }
  });
});

app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
